/**
 * WEB-7: an instructor's own projects — list (archived shown on request),
 * create, archive, restore, and duplicate. Every one of these is the exact
 * action `@bloombot/actions` exposes to anything else (PROJ-1, PROJ-2,
 * PROJ-4, PROJ-5), reached the one way this bundle ever reaches an action
 * (`dispatchAction`, `api/client.ts`) — this screen adds no route and no
 * action of its own.
 *
 * `onOpenProject` hands the chosen project up to `pages/ProjectsPanel.tsx`,
 * which switches to `pages/Courses.tsx` for it — this component only ever
 * knows about projects, the same split `courses.list`'s own policy draws
 * between "list a project" and "list a project's courses."
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  archiveProject,
  createProject,
  duplicateProject,
  listProjects,
  unarchiveProject,
} from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { Project } from '../api/types.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { checkboxClasses, textInputClasses } from '../components/fieldStyles.js'
import { AddIcon, ArchiveIcon, DuplicateIcon, RestoreIcon } from '../icons.js'

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

export function Projects({
  organizationId,
  onOpenProject,
}: ProjectsScreenProps) {
  const [projects, setProjects] = useState<Project[] | undefined>(undefined)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [newProjectName, setNewProjectName] = useState('')
  const [creating, setCreating] = useState(false)
  const [duplicateNames, setDuplicateNames] = useState<Record<string, string>>(
    {}
  )
  const [duplicatingId, setDuplicatingId] = useState<string | undefined>(
    undefined
  )
  const [duplicateNotice, setDuplicateNotice] = useState<string | undefined>(
    undefined
  )
  const [busyProjectId, setBusyProjectId] = useState<string | undefined>(
    undefined
  )

  // Finding 8 (WEB-7 rework): `refresh` is called both from the effect
  // below (on mount, and whenever `includeArchived` changes) and directly
  // after every mutation (create/archive/duplicate) — two ways for two
  // `listProjects` calls to be in flight at once, with no guarantee the
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

  const handleCreate = async () => {
    setError(undefined)
    setCreating(true)
    try {
      // Trimmed, not the raw input — the Create button is already disabled
      // on a whitespace-only name (`newProjectName.trim().length === 0`
      // below), but the *stored* name should not carry leading/trailing
      // whitespace either (finding 7 of the WEB-7 rework).
      await createProject(organizationId, newProjectName.trim())
      setNewProjectName('')
      refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setCreating(false)
    }
  }

  const handleArchive = async (project: Project) => {
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

  const handleDuplicate = async (project: Project) => {
    // `.trim()` — the same whitespace-only guard `handleCreate` and its own
    // button already apply (finding 7 of the WEB-7 rework): a raw-truthiness
    // check here accepted a whitespace-only name and created an effectively
    // unopenable project.
    const name = (duplicateNames[project.id] ?? '').trim()
    if (name === '') return
    setError(undefined)
    setDuplicateNotice(undefined)
    setDuplicatingId(project.id)
    try {
      const result = await duplicateProject(organizationId, project.id, name)
      setDuplicateNotice(
        duplicateDisabledMessage(result.project.name, result.coursesCopied)
      )
      setDuplicateNames((current) => ({ ...current, [project.id]: '' }))
      refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setDuplicatingId(undefined)
    }
  }

  return (
    <section
      aria-label="Projects"
      data-testid="projects-screen"
      className="flex flex-col gap-6"
    >
      <h1 className="text-page-title font-semibold text-neutral-900">
        Projects
      </h1>

      <label className="flex items-center gap-2 text-sm text-neutral-700">
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(event) => setIncludeArchived(event.target.checked)}
          className={checkboxClasses}
        />
        Show archived
      </label>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          aria-label="New project name"
          value={newProjectName}
          onChange={(event) => setNewProjectName(event.target.value)}
          placeholder="e.g. Fall 2026"
          className={`sm:max-w-xs ${textInputClasses}`}
        />
        {/* WEB-15: the one primary action on this screen. */}
        <Button
          variant="primary"
          icon={<AddIcon aria-hidden="true" className="size-4" />}
          onClick={() => void handleCreate()}
          disabled={creating || newProjectName.trim().length === 0}
        >
          {creating ? 'Creating…' : 'Create project'}
        </Button>
      </div>

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
          {projects.map((project) => (
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
              <div className="flex flex-wrap items-center gap-2">
                {/* WEB-15: archiving is not styled or confirmed as
                    destructive — it is reversible (Restore, right there)
                    and must never look like a deletion. */}
                <Button
                  variant="secondary"
                  icon={
                    project.archivedAt === null ? (
                      <ArchiveIcon aria-hidden="true" className="size-4" />
                    ) : (
                      <RestoreIcon aria-hidden="true" className="size-4" />
                    )
                  }
                  onClick={() => void handleArchive(project)}
                  disabled={busyProjectId === project.id}
                >
                  {project.archivedAt === null ? 'Archive' : 'Restore'}
                </Button>
                <input
                  aria-label={`Duplicate "${project.name}" as`}
                  value={duplicateNames[project.id] ?? ''}
                  onChange={(event) =>
                    setDuplicateNames((current) => ({
                      ...current,
                      [project.id]: event.target.value,
                    }))
                  }
                  placeholder="new project name"
                  className={`w-40 ${textInputClasses}`}
                />
                <Button
                  variant="secondary"
                  icon={<DuplicateIcon aria-hidden="true" className="size-4" />}
                  onClick={() => void handleDuplicate(project)}
                  disabled={
                    duplicatingId === project.id ||
                    (duplicateNames[project.id] ?? '').trim().length === 0
                  }
                >
                  {duplicatingId === project.id ? 'Duplicating…' : 'Duplicate'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
