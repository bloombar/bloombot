/**
 * WEB-7: an instructor's own projects — list (archived shown on request),
 * create, archive, restore, rename and duplicate. Every one of these is the
 * exact action `@bloombot/actions` exposes to anything else (PROJ-1, PROJ-2,
 * PROJ-4, PROJ-5, PROJ-6), reached the one way this bundle ever reaches an
 * action (`dispatchAction`, `api/client.ts`) — this screen adds no route and
 * no action of its own.
 *
 * `onOpenProject` hands the chosen project up to `pages/ProjectsPanel.tsx`,
 * which switches to `pages/Courses.tsx` for a full, drill-in view of it.
 *
 * WEB-42: this screen is no longer only about projects — each one lists its
 * own courses beneath it, indented to show the hierarchy, with the same
 * Chat/Export/Disable-Enable controls `pages/Courses.tsx` offers, so
 * reaching a course's tools no longer requires opening its project first.
 * `courses.list` still takes one `projectId` at a time (no batched "every
 * project's courses" action, and this slice does not add one), so this
 * screen fetches each listed project's courses itself, in parallel, once
 * the projects themselves have loaded — see `fetchCourses`/`courseStates`,
 * below, for how an out-of-order or failed fetch for one project is kept
 * from touching any other. The row itself — title, metadata, Chat, kebab —
 * is `components/CourseRows.tsx`, shared with `pages/Courses.tsx` rather
 * than reimplemented here, so Export and Disable/Enable have exactly one
 * implementation between the two screens.
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  archiveProject,
  createProject,
  duplicateProject,
  listCourses,
  listProjects,
  renameProject,
  unarchiveProject,
} from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { CourseSummary, Project } from '../api/types.js'
import { Button } from '../components/Button.js'
import { CourseImportDialog } from '../components/CourseImportDialog.js'
import { CourseRows } from '../components/CourseRows.js'
import { KebabMenu, type KebabMenuItem } from '../components/KebabMenu.js'
import { useModal } from '../components/modal/ModalProvider.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { checkboxClasses } from '../components/fieldStyles.js'
import {
  AddIcon,
  ArchiveIcon,
  DuplicateIcon,
  EditIcon,
  ImportIcon,
  RestoreIcon,
} from '../icons.js'

export interface ProjectsScreenProps {
  organizationId: string
  onOpenProject: (project: Project) => void
  /** WEB-42 — opens a course listed beneath one of this screen's own projects, straight into the course editor. Takes the project alongside the course id: unlike `pages/Courses.tsx`, which already knows its one project, this screen lists courses from more than one at a time. */
  onOpenCourse: (project: Project, courseId: string) => void
  /** WEB-42/WEB-28 — the same Chat handoff `pages/Courses.tsx` already threads through, reused unchanged for a course listed here. */
  onOpenChat: (courseId: string) => void
}

/**
 * WEB-42 — the three shapes a project's own courses fetch can be in, one
 * entry per listed project (`courseStates`, below) — mirrors
 * `pages/Shell.tsx`'s own `DiscordBindingState` (TEN-8): `'loading'` must
 * never be mistaken for "no courses," and a failed fetch says so rather
 * than rendering an empty list that looks like the answer.
 */
type CourseFetchState =
  | { status: 'loading' }
  | { status: 'ready'; courses: CourseSummary[] }
  | { status: 'error'; error: ApiError }

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
  onOpenCourse,
  onOpenChat,
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
  // WEB-39 — which project's Import dialog is open, or none. The project
  // itself rather than its id, since the dialog names it on screen and this
  // is the only place that already has the row it was opened from.
  const [importingInto, setImportingInto] = useState<Project | undefined>(
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

  // WEB-42: each listed project's own `courses.list`, kept independently —
  // `courseStates` is keyed by project id, rather than one array/error pair
  // for the whole page, so one project's failed fetch renders as *that*
  // project's own failure while the rest of the page (including every
  // other project's courses) renders normally. `courseFetchIds` is the same
  // "tag each request, only the most recent tag may write state" device
  // `pages/Shell.tsx#discordFetchId` uses for its own Discord fetch — kept
  // per project id here rather than a single ref, since a project's own
  // fetch can be reissued on its own (after that project's course changes,
  // below) independently of every other project's — review finding: this
  // guard is exercised by `tests/projects.test.tsx`'s own "two fetches for
  // the same project" case, which fails if the id comparison below is
  // removed.
  const [courseStates, setCourseStates] = useState<
    Record<string, CourseFetchState>
  >({})
  const courseFetchIds = useRef<Record<string, number>>({})
  const fetchCourses = useCallback(
    (project: Project) => {
      const id = (courseFetchIds.current[project.id] ?? 0) + 1
      courseFetchIds.current[project.id] = id
      setCourseStates((previous) => {
        // Only start as `'loading'` (hiding whatever this project's own
        // row already shows) when there is nothing to show yet — a
        // refetch after a course action (`onChanged`, below) or a project
        // mutation keeps rendering the previous list/error until the new
        // one resolves, the same way `Courses.tsx#refresh` already never
        // blanks its own list except on its very first fetch.
        if (previous[project.id] !== undefined) return previous
        return { ...previous, [project.id]: { status: 'loading' } }
      })
      listCourses(organizationId, project.id).then(
        (result) => {
          if (courseFetchIds.current[project.id] !== id) return
          setCourseStates((previous) => ({
            ...previous,
            [project.id]: { status: 'ready', courses: result },
          }))
        },
        (caught: unknown) => {
          if (courseFetchIds.current[project.id] !== id) return
          if (caught instanceof ApiError) {
            setCourseStates((previous) => ({
              ...previous,
              [project.id]: { status: 'error', error: caught },
            }))
          } else throw caught
        }
      )
    },
    [organizationId]
  )

  // Review finding: this used to key off `projects` itself, so *any*
  // project-level mutation — rename, archive, create, duplicate, even
  // ticking "Show archived" — produced a new array reference and reset
  // every listed project's own `courseStates` to `'loading'`, discarding
  // correct lists and re-announcing N `role="status"` regions for a
  // mutation that touched at most one project's own row. `projectIds` is a
  // primitive derived from the *set* of ids alone, compared by value
  // (`Object.is` on a string) rather than by the array's own identity, so a
  // rename (same ids) leaves it unchanged and the effect below does not
  // refire at all.
  const projectIds = useMemo(
    () => (projects ?? []).map((project) => project.id).join(','),
    [projects]
  )

  // Fires once the projects themselves have loaded (mount, an
  // includeArchived toggle, or any other `refresh()` that actually changes
  // *which* projects are listed) and issues every newly-listed project's
  // own `courses.list` in parallel — N requests for N projects, there
  // being no batched "every project's courses" action to issue instead
  // (see this file's own module comment). Only a project this effect has
  // not already fetched (`courseFetchIds.current[project.id] ===
  // undefined`) is fetched here — a project already fetched keeps its own
  // state exactly as `fetchCourses`/`onChanged` below left it, rather than
  // being refetched merely because some *other* project's id joined or
  // left the list. A project that leaves the list (archived out of view,
  // deleted) has its own `courseStates`/`courseFetchIds` entry pruned
  // below too, rather than growing forever.
  useEffect(() => {
    if (projects === undefined) return
    const currentIds = new Set(projects.map((project) => project.id))
    for (const project of projects) {
      if (courseFetchIds.current[project.id] === undefined) {
        fetchCourses(project)
      }
    }
    for (const id of Object.keys(courseFetchIds.current)) {
      if (!currentIds.has(id)) delete courseFetchIds.current[id]
    }
    setCourseStates((previous) => {
      let changed = false
      const next: Record<string, CourseFetchState> = {}
      for (const [id, state] of Object.entries(previous)) {
        if (currentIds.has(id)) {
          next[id] = state
        } else {
          changed = true
        }
      }
      return changed ? next : previous
    })
    // `projectIds` (not `projects`) is the trigger — see its own comment
    // above; `projects` itself is still read fresh from the closure, which
    // is fine here since nothing below reads any field but each project's
    // own stable `id`.
  }, [projectIds, fetchCourses])

  // Review finding: `courseStates`/`courseFetchIds` are keyed by project
  // id alone, with nothing scoping either to *this* organization — a
  // caller that changed `organizationId` on an already-mounted `Projects`
  // (rather than remounting it, which is how `pages/Shell.tsx` actually
  // does it today, via its own `key={activeOrganizationId}`) would
  // otherwise keep growing both maps for every organization and project
  // visited in one session. Cheap to close either way: a fresh
  // organization starts with neither map holding anything.
  useEffect(() => {
    setCourseStates({})
    courseFetchIds.current = {}
  }, [organizationId])

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

      {/* Right-aligned: a filter over the list below, sat at the end of its
          own row so it reads as a control on that list rather than as the
          first item in it. */}
      <label className="flex items-center gap-2 self-end text-sm text-neutral-700">
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(event) => setIncludeArchived(event.target.checked)}
          className={checkboxClasses}
        />
        Show archived
      </label>

      {importingInto && (
        <CourseImportDialog
          open={true}
          organizationId={organizationId}
          project={importingInto}
          onClose={() => setImportingInto(undefined)}
          // A course imported into a project this screen does not itself
          // list the courses of still deserves a line saying it happened —
          // the same notice slot the duplicate already writes into, rather
          // than a second one grown beside it.
          onImported={(result) =>
            setDuplicateNotice(
              `Imported "${result.title}" into "${importingInto.name}", disabled — open the project to enable it.`
            )
          }
        />
      )}
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
                key: 'import',
                label: 'Import',
                icon: <ImportIcon aria-hidden="true" className="size-4" />,
                onSelect: () => setImportingInto(project),
              },
              {
                key: 'rename',
                label: 'Rename',
                icon: <EditIcon aria-hidden="true" className="size-4" />,
                onSelect: () => void handleRename(project),
              },
            ]
            const courseState = courseStates[project.id]
            return (
              // WEB-42/WEB-13: `flex-col` unconditionally (not `sm:flex-row`
              // on the item itself, as this row used to be) — the header
              // below still lays out side by side from `sm:` up, but the
              // course list beneath it always stacks under the header,
              // never beside it, on every viewport.
              <li
                key={project.id}
                data-testid={`project-${project.id}`}
                className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenProject(project)}
                      className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
                    >
                      {project.name}
                    </button>
                    {project.archivedAt !== null && (
                      <span className="text-xs text-neutral-500">
                        (archived)
                      </span>
                    )}
                  </div>
                  <KebabMenu
                    label={`Actions for "${project.name}"`}
                    items={items}
                    disabled={busy}
                  />
                </div>

                {/* WEB-42: this project's own courses, indented beneath it
                    through real nesting (a `<ul>` inside this `<li>`,
                    from `CourseRows` below) rather than padding alone, so
                    the hierarchy reaches assistive technology as well as
                    the eye. The left border carries the indent visually;
                    `pl-4`/`sm:pl-6` is modest on purpose (WEB-13) — enough
                    to read as "beneath," never enough to push a course
                    row's own Chat button or kebab off a phone screen. */}
                <div className="border-l border-neutral-200 pl-4 sm:pl-6">
                  {courseState === undefined ||
                  courseState.status === 'loading' ? (
                    <p role="status" className="text-sm text-neutral-500">
                      Loading…
                    </p>
                  ) : courseState.status === 'error' ? (
                    <ErrorMessage error={courseState.error} />
                  ) : courseState.courses.length === 0 ? (
                    <p className="text-sm text-neutral-500">
                      No courses in this project yet.
                    </p>
                  ) : (
                    <CourseRows
                      organizationId={organizationId}
                      courses={courseState.courses}
                      onOpenCourse={(courseId) =>
                        onOpenCourse(project, courseId)
                      }
                      onOpenChat={onOpenChat}
                      // WEB-42: refreshing only *this* project's courses
                      // after a toggle — the same "not every project's"
                      // requirement `Courses.tsx#refresh` already meets
                      // for its own single project.
                      onChanged={() => fetchCourses(project)}
                      // WEB-42 review finding — this project's own name,
                      // threaded into the row's Chat/kebab labels
                      // (`CourseRows`' own doc comment on why): unlike
                      // `Courses.tsx`, this screen lists more than one
                      // project's courses side by side, and nothing else
                      // makes a title unique across them.
                      projectName={project.name}
                    />
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
