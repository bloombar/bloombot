/**
 * WEB-8/PROJ-5: a project's own courses — listed through `courses.list`
 * (base rows, no categories/channels — matching that action's own split
 * from `courses.get`), with each course's enabled state toggled directly
 * from here (`courses.enable`/`courses.disable`) and a way into
 * `pages/CourseEditor.tsx` to define a new one or edit an existing one.
 *
 * WEB-26/WEB-28: each row also gets a **Chat** button — its own control,
 * not folded into the kebab, because it is the one action on this row
 * worth a keystroke of its own (`onOpenChat`, below, switches the shell to
 * its Chat tab with this course already selected — see `pages/Shell.tsx`'s
 * own module comment for how that handoff actually works) — and a kebab
 * holding Disable/Enable, matching the row-menu shape `pages/Projects.tsx`
 * already uses.
 *
 * WEB-42: the row itself — title, metadata, Chat, kebab, and the
 * Export/Disable-Enable handlers behind it — now lives in
 * `components/CourseRows.tsx`, shared with `pages/Projects.tsx`'s own
 * beneath-each-project listing, so this screen owns only the fetch (its
 * one project's `courses.list`) and the loading/empty states around it.
 *
 * WEB-61: this screen is also this project's own screen
 * (`/o/:organizationId/projects/:projectId`), and carries the identical
 * kebab menu the project's own row shows on `pages/Projects.tsx` —
 * Archive/Restore, Duplicate, Import, Rename, Delete — through the shared
 * `hooks/useProjectMenu.tsx`, immediately to the left of "New course." A
 * successful Delete leaves nothing here to show, so it navigates back to
 * the project list (`onBack`) rather than merely refreshing; Archive/
 * Restore/Rename instead report the changed `Project` back through
 * `onProjectChanged` (this file's own prop doc comment), since this screen
 * does not own the record it names in its own heading — `pages/
 * ProjectsPanel.tsx` does, and updates it in place.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { listCourses } from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { CourseSummary, Project } from '../api/types.js'
import { Button } from '../components/Button.js'
import { CourseRows } from '../components/CourseRows.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { KebabMenu } from '../components/KebabMenu.js'
import { LoadingStatus, SkeletonRow } from '../components/Skeleton.js'
import { useProjectMenu } from '../hooks/useProjectMenu.js'
import { AddIcon } from '../icons.js'

export interface CoursesScreenProps {
  organizationId: string
  project: Project
  onBack: () => void
  onOpenCourse: (courseId: string | undefined) => void
  /** WEB-28: opens a chat session for this course directly, switching the shell to its Chat tab with it already selected. */
  onOpenChat: (courseId: string) => void
  /** WEB-61 — this screen does not own `project` (`pages/ProjectsPanel.tsx` resolves it, once, from the route's own id); called after Archive/Restore/Rename so the caller can update the record it is holding in place, or this screen's own header (`project.name`, below) would keep reading the *old* value until the screen was left and reached again. Never called for Duplicate/Import (neither changes `project` itself, `hooks/useProjectMenu.tsx`'s own doc comment) or Delete (`onBack`, below, is that cue instead — the project is gone, not merely different). */
  onProjectChanged: (project: Project) => void
}

export function Courses({
  organizationId,
  project,
  onBack,
  onOpenCourse,
  onOpenChat,
  onProjectChanged,
}: CoursesScreenProps) {
  const [courses, setCourses] = useState<CourseSummary[] | undefined>(undefined)
  const [error, setError] = useState<ApiError | undefined>(undefined)

  // WEB-61: this project's own kebab — Archive/Restore, Duplicate, Import,
  // Rename, Delete — the same shared handlers `pages/Projects.tsx` uses.
  // `onProjectChanged` (this file's own prop doc comment) is what keeps
  // this screen's own header in step with Archive/Restore/Rename; only
  // Delete needs a real cue, since the project this screen names is gone —
  // `onBack` is that cue, the same "go somewhere that still exists"
  // `← Projects` control above already is.
  const projectMenu = useProjectMenu(organizationId, onProjectChanged, () =>
    onBack()
  )

  // Finding 8 (WEB-7 rework): `refresh` is called both from the effect
  // below (on mount, and whenever `project.id` changes) and directly after
  // enabling/disabling a course — two ways for two `listCourses` calls to
  // be in flight at once, with no guarantee the later request resolves
  // last. `refreshId` tags each call and only the most recent one is
  // allowed to update state, so an out-of-order response cannot leave the
  // list showing a course's stale enabled/disabled state.
  const refreshId = useRef(0)
  const refresh = useCallback(() => {
    const id = ++refreshId.current
    // A previous `refresh()` (this screen's own fetch, not `CourseRows`'
    // own row-action errors) may have failed and left `error` set — review
    // finding: without this, a transient failure here outlived every
    // subsequent successful refresh for the life of the screen, since
    // nothing else ever cleared it once the toggle/export handlers (and
    // their own `setError(undefined)`) moved into `CourseRows`.
    setError(undefined)
    listCourses(organizationId, project.id).then(
      (result) => {
        if (id !== refreshId.current) return
        setCourses(result)
      },
      (caught: unknown) => {
        if (id !== refreshId.current) return
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [organizationId, project.id])

  useEffect(() => {
    setCourses(undefined)
    refresh()
  }, [refresh])

  return (
    <section
      aria-label="Courses"
      data-testid="courses-screen"
      className="flex flex-col gap-6"
    >
      <Button variant="ghost" onClick={onBack}>
        ← Projects
      </Button>
      <div className="flex items-center justify-between">
        <h1 className="text-page-title font-semibold text-neutral-900">
          {project.name}
        </h1>
        <div className="flex items-center gap-2">
          {/* WEB-61 — this project's own menu, immediately to the left of
              "New course," the same row `pages/Projects.tsx`'s own row
              puts its kebab in. */}
          <KebabMenu
            label={`Actions for "${project.name}"`}
            items={projectMenu.itemsFor(project)}
            disabled={projectMenu.busyProjectId === project.id}
          />
          {/* WEB-15: the one primary action on this screen. */}
          <Button
            variant="primary"
            icon={<AddIcon aria-hidden="true" className="size-4" />}
            onClick={() => onOpenCourse(undefined)}
          >
            New course
          </Button>
        </div>
      </div>

      {projectMenu.importDialog}
      {projectMenu.duplicateNotice && (
        <p
          role="status"
          data-testid="duplicate-notice"
          className="rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-800"
        >
          {projectMenu.duplicateNotice}
        </p>
      )}
      {error && <ErrorMessage error={error} />}
      {projectMenu.error && <ErrorMessage error={projectMenu.error} />}

      {courses === undefined ? (
        error ? null : (
          // WEB-45: shaped like the cards `CourseRows` renders once
          // `courses` resolves. `error ? null :` — same guard `Admin.tsx`'s
          // own `failed` check exists for: a refusal must not also claim to
          // still be loading, and a pulsing skeleton reads as active
          // progress even more than the plain text it replaced.
          <div className="flex flex-col gap-3">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <LoadingStatus />
          </div>
        )
      ) : courses.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No courses in this project yet.
        </p>
      ) : (
        <CourseRows
          organizationId={organizationId}
          courses={courses}
          onOpenCourse={onOpenCourse}
          onOpenChat={onOpenChat}
          onChanged={refresh}
        />
      )}
    </section>
  )
}
