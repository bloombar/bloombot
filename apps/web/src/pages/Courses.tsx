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
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { listCourses } from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { CourseSummary, Project } from '../api/types.js'
import { Button } from '../components/Button.js'
import { CourseRows } from '../components/CourseRows.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { AddIcon } from '../icons.js'

export interface CoursesScreenProps {
  organizationId: string
  project: Project
  onBack: () => void
  onOpenCourse: (courseId: string | undefined) => void
  /** WEB-28: opens a chat session for this course directly, switching the shell to its Chat tab with it already selected. */
  onOpenChat: (courseId: string) => void
}

export function Courses({
  organizationId,
  project,
  onBack,
  onOpenCourse,
  onOpenChat,
}: CoursesScreenProps) {
  const [courses, setCourses] = useState<CourseSummary[] | undefined>(undefined)
  const [error, setError] = useState<ApiError | undefined>(undefined)

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
        {/* WEB-15: the one primary action on this screen. */}
        <Button
          variant="primary"
          icon={<AddIcon aria-hidden="true" className="size-4" />}
          onClick={() => onOpenCourse(undefined)}
        >
          New course
        </Button>
      </div>

      {error && <ErrorMessage error={error} />}

      {courses === undefined ? (
        <p role="status" className="text-sm text-neutral-500">
          Loading…
        </p>
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
