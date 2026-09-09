/**
 * WEB-39/PORT-4..PORT-7: `components/CourseImportDialog.tsx` — the dialog a
 * project's Import menu item opens. What it must do: refuse to import
 * nothing, say before the import runs that the course arrives disabled, read
 * the dropped file and send its text, report what arrived (including the
 * title PORT-5 gave it and anything PORT-3 could not carry), and keep itself
 * open with the reason when the file is refused.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { ImportCourseResult, Project } from '../src/api/types.js'
import { CourseImportDialog } from '../src/components/CourseImportDialog.js'

const { importCourse } = vi.hoisted(() => ({ importCourse: vi.fn() }))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, importCourse }
})

const PROJECT: Project = {
  id: 'project-1',
  organizationId: 'org-1',
  name: 'Fall 2026',
  archivedAt: null,
  createdAt: 0,
}

/** What `courses.import` reports for a clean import, overridable per test. */
function result(
  overrides: Partial<ImportCourseResult> = {}
): ImportCourseResult {
  return {
    course: {
      id: 'course-9',
      organizationId: 'org-1',
      projectId: 'project-1',
      title: 'Intro to CS',
      enabled: false,
      adminsRole: 'admins-cs',
      studentsRole: 'students-cs',
      promptId: null,
      instructions: null,
      model: null,
      vectorStoreId: null,
      maxRequestsPerDay: null,
      conversationScope: 'course',
      discordServerId: null,
      createdAt: 0,
      categories: [],
    },
    title: 'Intro to CS',
    titleChanged: false,
    disabled: true,
    notCarried: {
      vectorStore: false,
      storedPrompt: false,
      attachments: 0,
      discordServer: false,
    },
    ...overrides,
  }
}

/** Drops `file` onto the dialog's own zone, the way a browser delivers one. */
function dropFile(file: File): void {
  const zone = screen.getByRole('button', {
    name: /Course export file — drop a file here/,
  })
  fireEvent.drop(zone, {
    dataTransfer: { files: [file], items: [{ kind: 'file', type: file.type }] },
  })
}

function exportFile(name = 'intro-to-cs.course.yml'): File {
  return new File(['bloombotCourseExport: 1\n'], name, { type: 'text/yaml' })
}

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof CourseImportDialog>> = {}
) {
  const props = {
    open: true,
    organizationId: 'org-1',
    project: PROJECT,
    onClose: vi.fn(),
    onImported: vi.fn(),
    ...overrides,
  }
  render(<CourseImportDialog {...props} />)
  return props
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('CourseImportDialog (WEB-39)', () => {
  it('names the project and says the course arrives disabled, before anything is imported', () => {
    renderDialog()

    expect(
      screen.getByText('Import a course into "Fall 2026"')
    ).toBeInTheDocument()
    expect(screen.getByText(/arrives disabled/)).toBeInTheDocument()
    expect(importCourse).not.toHaveBeenCalled()
  })

  it('cannot be confirmed until a file is chosen', () => {
    renderDialog()

    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
    dropFile(exportFile())
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled()
  })

  it("sends the dropped file's text to the import action", async () => {
    importCourse.mockResolvedValue(result())
    const props = renderDialog()

    dropFile(exportFile())
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() =>
      expect(importCourse).toHaveBeenCalledWith(
        'org-1',
        'project-1',
        'bloombotCourseExport: 1\n'
      )
    )
    await waitFor(() => expect(props.onImported).toHaveBeenCalled())
  })

  it('reports the title PORT-5 gave the course, and what the file could not carry', async () => {
    importCourse.mockResolvedValue(
      result({
        title: 'Intro to CS 2',
        titleChanged: true,
        notCarried: {
          vectorStore: true,
          storedPrompt: false,
          attachments: 2,
          discordServer: true,
        },
      })
    )
    renderDialog()

    dropFile(exportFile())
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    const report = await screen.findByTestId('course-import-report')
    expect(report).toHaveTextContent('Intro to CS 2')
    expect(report).toHaveTextContent('already here')
    expect(report).toHaveTextContent('2 knowledge files')
    expect(report).toHaveTextContent('Discord server')
  })

  it('says nothing about what could not be carried when everything was', async () => {
    importCourse.mockResolvedValue(result())
    renderDialog()

    dropFile(exportFile())
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    const report = await screen.findByTestId('course-import-report')
    expect(report).toHaveTextContent('Imported')
    expect(report).not.toHaveTextContent('knowledge file')
    expect(report).not.toHaveTextContent('Discord server')
  })

  it('stays open with the reason when the file is refused (PORT-7)', async () => {
    importCourse.mockRejectedValue(
      new ApiError(400, {
        error: 'action_input_invalid',
        issues: [
          {
            path: ['content'],
            message:
              'That file is a version 99 course export; this version of Bloombot reads version 1.',
          },
        ],
      })
    )
    const props = renderDialog()

    dropFile(exportFile())
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('version 99')
    // Still the import dialog, not the report — and nothing was announced to
    // the caller as imported.
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument()
    expect(props.onImported).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('closes without importing when cancelled', () => {
    const props = renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(props.onClose).toHaveBeenCalled()
    expect(importCourse).not.toHaveBeenCalled()
  })
})
