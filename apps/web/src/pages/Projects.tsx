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

import { useCallback, useEffect, useState } from 'react'

import {
  archiveProject,
  createProject,
  duplicateProject,
  listProjects,
  unarchiveProject,
} from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { Project } from '../api/types.js'
import { ErrorMessage } from '../components/ErrorMessage.js'

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

  const refresh = useCallback(() => {
    listProjects(organizationId, includeArchived).then(
      (result) => setProjects(result),
      (caught: unknown) => {
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
      await createProject(organizationId, newProjectName)
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
    const name = duplicateNames[project.id]
    if (!name) return
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
    <section aria-label="Projects" data-testid="projects-screen">
      <h2>Projects</h2>

      <label>
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(event) => setIncludeArchived(event.target.checked)}
        />{' '}
        Show archived
      </label>

      <div>
        <input
          aria-label="New project name"
          value={newProjectName}
          onChange={(event) => setNewProjectName(event.target.value)}
          placeholder="e.g. Fall 2026"
        />
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating || newProjectName.trim().length === 0}
        >
          {creating ? 'Creating…' : 'Create project'}
        </button>
      </div>

      {duplicateNotice && (
        <p role="status" data-testid="duplicate-notice">
          {duplicateNotice}
        </p>
      )}
      {error && <ErrorMessage error={error} />}

      {projects === undefined ? (
        <p>Loading…</p>
      ) : projects.length === 0 ? (
        <p>No projects yet.</p>
      ) : (
        <ul>
          {projects.map((project) => (
            <li key={project.id} data-testid={`project-${project.id}`}>
              <button type="button" onClick={() => onOpenProject(project)}>
                {project.name}
              </button>
              {project.archivedAt !== null && ' (archived)'}
              <button
                type="button"
                onClick={() => void handleArchive(project)}
                disabled={busyProjectId === project.id}
              >
                {project.archivedAt === null ? 'Archive' : 'Restore'}
              </button>
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
              />
              <button
                type="button"
                onClick={() => void handleDuplicate(project)}
                disabled={
                  duplicatingId === project.id || !duplicateNames[project.id]
                }
              >
                {duplicatingId === project.id ? 'Duplicating…' : 'Duplicate'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
