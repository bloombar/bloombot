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
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { disableCourse, enableCourse, listCourses } from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { CourseSummary, Project } from '../api/types.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { KebabMenu, type KebabMenuItem } from '../components/KebabMenu.js'
import { useModal } from '../components/modal/ModalProvider.js'
import { AddIcon, ChatIcon, DisableIcon, EnableIcon } from '../icons.js'

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
  const [busyCourseId, setBusyCourseId] = useState<string | undefined>(
    undefined
  )
  const { confirm } = useModal()

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

  const handleToggle = async (course: CourseSummary) => {
    // WEB-15: disabling a live course is destructive (students stop being
    // answered) and confirms first, through the one modal this panel
    // shares (`components/modal/`) — the same treatment
    // `pages/CourseEditor.tsx`'s own toggle gives it. Enabling is not
    // destructive and runs immediately.
    if (course.enabled) {
      const confirmed = await confirm({
        title: `Disable ${course.title}?`,
        description:
          'Students stop being answered here until it is enabled again.',
        confirmLabel: 'Disable',
        destructive: true,
      })
      if (!confirmed) return
    }
    setError(undefined)
    setBusyCourseId(course.id)
    try {
      if (course.enabled) {
        await disableCourse(organizationId, course.id)
      } else {
        await enableCourse(organizationId, course.id)
      }
      refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setBusyCourseId(undefined)
    }
  }

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
        // WEB-13: a card per course, stacked — never a wide table row a
        // phone would have to scroll horizontally to read.
        <ul className="flex flex-col gap-3">
          {courses.map((course) => {
            const busy = busyCourseId === course.id
            // WEB-26: a kebab holding Disable/Enable — destructive-styled
            // only for Disable, matching the danger treatment the button
            // this replaces used to carry only while the course was
            // enabled.
            const items: KebabMenuItem[] = [
              {
                key: 'toggle',
                label: course.enabled ? 'Disable' : 'Enable',
                icon: course.enabled ? (
                  <DisableIcon aria-hidden="true" className="size-4" />
                ) : (
                  <EnableIcon aria-hidden="true" className="size-4" />
                ),
                destructive: course.enabled,
                onSelect: () => void handleToggle(course),
              },
            ]
            return (
              <li
                key={course.id}
                data-testid={`course-${course.id}`}
                className="flex flex-col gap-2 rounded-md border border-neutral-200 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => onOpenCourse(course.id)}
                    className="text-left text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
                  >
                    {course.title}
                  </button>
                  <p className="text-xs text-neutral-500">
                    routes on roles{' '}
                    <code className="rounded bg-neutral-100 px-1">
                      {course.adminsRole}
                    </code>{' '}
                    /{' '}
                    <code className="rounded bg-neutral-100 px-1">
                      {course.studentsRole}
                    </code>{' '}
                    — {course.enabled ? 'enabled' : 'disabled'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {/* WEB-28: the one action on this row worth its own
                      control — opens a chat session for this course
                      directly. */}
                  <Button
                    variant="secondary"
                    icon={<ChatIcon aria-hidden="true" className="size-4" />}
                    onClick={() => onOpenChat(course.id)}
                  >
                    Chat
                  </Button>
                  <KebabMenu
                    label={`Actions for "${course.title}"`}
                    items={items}
                    disabled={busy}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
