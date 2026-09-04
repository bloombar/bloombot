/**
 * WEB-7: an instructor's own projects — list (archived shown on request),
 * create, archive, restore, rename and duplicate. Every one of these is the
 * exact action `@bloombot/actions` exposes to anything else (PROJ-1, PROJ-2,
 * PROJ-4, PROJ-5, PROJ-6), reached the one way this bundle ever reaches an
 * action (`dispatchAction`, `api/client.ts`) — this screen adds no route and
 * no action of its own.
 *
 * `onOpenProject` hands the chosen project up to `pages/ProjectsPanel.tsx`,
 * which switches to `pages/Courses.tsx` for it — this component only ever
 * knows about projects, the same split `courses.list`'s own policy draws
 * between "list a project" and "list a project's courses."
 *
 * WEB-26/WEB-27: each row's own Archive/Restore, Duplicate and Rename
 * controls live behind one `KebabMenu` (`components/KebabMenu.tsx`) rather
 * than a row of buttons plus a free-text "duplicate as" input beside it —
 * and "New project" is a primary button beside the heading, matching
 * `pages/Courses.tsx`'s own "New course," rather than an always-present
 * inline input and Create button. Duplicate and Rename both ask for their
 * name through `useModal()`'s own `prompt` (`components/modal/`), the one
 * dialog this app renders, rather than a second free-text field grown per
 * row.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  archiveProject,
  createProject,
  duplicateProject,
  listProjects,
  renameProject,
  unarchiveProject,
} from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { Project } from '../api/types.js'
import { Button } from '../components/Button.js'
import { KebabMenu, type KebabMenuItem } from '../components/KebabMenu.js'
import { useModal } from '../components/modal/ModalProvider.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { checkboxClasses } from '../components/fieldStyles.js'
import {
  AddIcon,
  ArchiveIcon,
  DuplicateIcon,
  EditIcon,
  RestoreIcon,
} from '../icons.js'

export interface ProjectsScreenProps {
  organizationId: string
  onOpenProject: (project: Project) => void
}

/**
 * D-23's reasoning, said in one sentence a person can act on: a duplicate's
 * courses carry the same category and role names as their originals — the
 * exact collision PROJ-3 forbids among enabled courses — so every one of
 * them is created disabled, and stays that way until an instructor confirms
 * (or edits) those names and enables it.
 */
function duplicateDisabledMessage(
  newProjectName: string,
  coursesCopied: number
): string {
  if (coursesCopied === 0) {
    return `Copied "${newProjectName}" — it had no courses to bring with it.`
  }
  const plural = coursesCopied === 1 ? 'course' : 'courses'
  return (
    `Copied ${coursesCopied} ${plural} into "${newProjectName}", every one disabled: ` +
    `a copy shares its original's category and role names, so enabling one immediately ` +
    `would collide with the course it was copied from. Confirm or edit those names, then enable each.`
  )
}

/** A blank or whitespace-only name is refused the same way everywhere a project name is typed (finding 7 of the WEB-7 rework, carried forward into every `prompt()` call below). */
function requireName(value: string): string | undefined {
  return value.trim().length === 0 ? 'Enter a project name.' : undefined
}

export function Projects({
  organizationId,
  onOpenProject,
}: ProjectsScreenProps) {
  const [projects, setProjects] = useState<Project[] | undefined>(undefined)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [duplicateNotice, setDuplicateNotice] = useState<string | undefined>(
    undefined
  )
  const [busyProjectId, setBusyProjectId] = useState<string | undefined>(
    undefined
  )
  const { prompt, confirm } = useModal()

  // Finding 8 (WEB-7 rework): `refresh` is called both from the effect
  // below (on mount, and whenever `includeArchived` changes) and directly
  // after every mutation (create/archive/rename/duplicate) — two ways for
  // two `listProjects` calls to be in flight at once, with no guarantee the
  // later request resolves last. `refreshId` tags each call and only the
  // most recent one is allowed to update state, so an out-of-order response
  // cannot leave the list disagreeing with the "Show archived" checkbox.
  const refreshId = useRef(0)
  const refresh = useCallback(() => {
    const id = ++refreshId.current
    listProjects(organizationId, includeArchived).then(
      (result) => {
        if (id !== refreshId.current) return
        setProjects(result)
      },
      (caught: unknown) => {
        if (id !== refreshId.current) return
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [organizationId, includeArchived])

  useEffect(() => {
    setProjects(undefined)
    refresh()
  }, [refresh])

  // WEB-27: "New project" opens a modal asking for the name rather than the
  // old always-present inline input — `.trim()` (finding 7 of the WEB-7
  // rework) is enforced by `requireName` before the dialog will even let the
  // caller confirm, and applied again here since `prompt()`'s own resolved
  // value is the raw typed string, not the trimmed one.
  const handleCreate = async () => {
    const name = await prompt({
      title: 'New project',
      label: 'Project name',
      placeholder: 'e.g. Fall 2026',
      confirmLabel: 'Create',
      validate: requireName,
    })
    if (name === undefined) return
    setError(undefined)
    setCreating(true)
    try {
      await createProject(organizationId, name.trim())
      refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setCreating(false)
    }
  }

  const handleArchive = async (project: Project) => {
    // WEB-15 — archiving and deleting must never look alike (PROJ-2:
    // archiving is reversible, Restore is right there), so this confirms
    // through the *non-destructive* path — a plain, primary-styled
    // confirm, not the danger-red one `destructive: true` renders — while
    // still confirming at all, because archiving a whole term stops every
    // course inside it routing, more consequence than disabling one course
    // ever has, and disabling already confirms (`pages/Courses.tsx`,
    // `pages/CourseEditor.tsx`). One rule — a destructive action confirms
    // as destructive, a merely consequential one still confirms, plainly —
    // applied the same way everywhere it appears. Restoring undoes exactly
    // this, so it never needs to ask first.
    if (project.archivedAt === null) {
      const confirmed = await confirm({
        title: `Archive ${project.name}?`,
        description: 'Its courses stop routing. You can restore it.',
        confirmLabel: 'Archive',
      })
      if (!confirmed) return
    }
    setError(undefined)
    setBusyProjectId(project.id)
    try {
      if (project.archivedAt === null) {
        await archiveProject(organizationId, project.id)
      } else {
        await unarchiveProject(organizationId, project.id)
      }
      refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setBusyProjectId(undefined)
    }
  }

  // PROJ-6/WEB-26: rename, over the `projects.rename` action
  // (`packages/actions`) — a refusal (the name collides with another active
  // project) surfaces the same way every other refusal on this screen does,
  // through `error`/`ErrorMessage`, naming the colliding project.
  const handleRename = async (project: Project) => {
    const name = await prompt({
      title: `Rename "${project.name}"`,
      label: 'Project name',
      initialValue: project.name,
      confirmLabel: 'Rename',
      validate: requireName,
    })
    if (name === undefined) return
    setError(undefined)
    setBusyProjectId(project.id)
    try {
      await renameProject(organizationId, project.id, name.trim())
      refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setBusyProjectId(undefined)
    }
  }

  const handleDuplicate = async (project: Project) => {
    const name = await prompt({
      title: `Duplicate "${project.name}"`,
      label: 'New project name',
      placeholder: 'new project name',
      confirmLabel: 'Duplicate',
      validate: requireName,
    })
    if (name === undefined) return
    setError(undefined)
    setDuplicateNotice(undefined)
    setBusyProjectId(project.id)
    try {
      const result = await duplicateProject(
        organizationId,
        project.id,
        name.trim()
      )
      setDuplicateNotice(
        duplicateDisabledMessage(result.project.name, result.coursesCopied)
      )
      refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setBusyProjectId(undefined)
    }
  }

  return (
    <section
      aria-label="Projects"
      data-testid="projects-screen"
      className="flex flex-col gap-6"
    >
      <div className="flex items-center justify-between">
        <h1 className="text-page-title font-semibold text-neutral-900">
          Projects
        </h1>
        {/* WEB-15/WEB-27: the one primary action on this screen, matching
            `pages/Courses.tsx`'s own "New course" heading row exactly. */}
        <Button
          variant="primary"
          icon={<AddIcon aria-hidden="true" className="size-4" />}
          onClick={() => void handleCreate()}
          disabled={creating}
        >
          {creating ? 'Creating…' : 'New project'}
        </Button>
      </div>

      <label className="flex items-center gap-2 text-sm text-neutral-700">
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(event) => setIncludeArchived(event.target.checked)}
          className={checkboxClasses}
        />
        Show archived
      </label>

      {duplicateNotice && (
        <p
          role="status"
          data-testid="duplicate-notice"
          className="rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-800"
        >
          {duplicateNotice}
        </p>
      )}
      {error && <ErrorMessage error={error} />}

      {projects === undefined ? (
        <p role="status" className="text-sm text-neutral-500">
          Loading…
        </p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-neutral-500">No projects yet.</p>
      ) : (
        // WEB-13: a card per project, stacked — never a wide table row a
        // phone would have to scroll horizontally to read.
        <ul className="flex flex-col gap-3">
          {projects.map((project) => {
            const busy = busyProjectId === project.id
            // WEB-26: Archive/Restore, Duplicate and Rename, in that order —
            // a single kebab per row rather than a row of buttons plus a
            // free-text "duplicate as" input.
            const items: KebabMenuItem[] = [
              {
                key: 'archive',
                label: project.archivedAt === null ? 'Archive' : 'Restore',
                icon:
                  project.archivedAt === null ? (
                    <ArchiveIcon aria-hidden="true" className="size-4" />
                  ) : (
                    <RestoreIcon aria-hidden="true" className="size-4" />
                  ),
                onSelect: () => void handleArchive(project),
              },
              {
                key: 'duplicate',
                label: 'Duplicate',
                icon: <DuplicateIcon aria-hidden="true" className="size-4" />,
                onSelect: () => void handleDuplicate(project),
              },
              {
                key: 'rename',
                label: 'Rename',
                icon: <EditIcon aria-hidden="true" className="size-4" />,
                onSelect: () => void handleRename(project),
              },
            ]
            return (
              <li
                key={project.id}
                data-testid={`project-${project.id}`}
                className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenProject(project)}
                    className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
                  >
                    {project.name}
                  </button>
                  {project.archivedAt !== null && (
                    <span className="text-xs text-neutral-500">(archived)</span>
                  )}
                </div>
                <KebabMenu
                  label={`Actions for "${project.name}"`}
                  items={items}
                  disabled={busy}
                />
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
