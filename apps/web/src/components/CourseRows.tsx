/**
 * WEB-42: the course row `pages/Courses.tsx` used to own outright — title
 * (opens the course editor), metadata line, a **Chat** button and a kebab
 * holding **Export** and Disable/Enable — pulled out here so
 * `pages/Projects.tsx` can offer the exact same row, with the exact same
 * behaviour, beneath each of its own projects, without a second
 * `handleExport`/`handleToggle` pair drifting away from this one.
 * `pages/Courses.tsx` now renders this component too, for its own single
 * project's list — there is only ever one implementation of "what a course
 * row does."
 *
 * State lives *here*, not with either caller: each render of `CourseRows`
 * owns its own `busyCourseId`/`error`, scoped to the `courses` array it was
 * given. That is what lets `pages/Projects.tsx` mount one of these per
 * project and have one project's Export/Disable failure surface against
 * *that* project's rows without a `busyCourseId`/`error` pair the caller
 * would otherwise have to key by project id itself. A course that changed
 * (enable/disable) is reported upward through `onChanged` — this component
 * never decides *how* to refetch, since that differs by caller:
 * `pages/Courses.tsx` re-lists its one project, `pages/Projects.tsx`
 * re-lists only the affected project rather than every one on the page.
 */

import { useState } from 'react'

import {
  disableCourse,
  downloadTextFile,
  enableCourse,
  exportCourse,
} from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { CourseSummary } from '../api/types.js'
import { Button } from './Button.js'
import { ErrorMessage } from './ErrorMessage.js'
import { KebabMenu, type KebabMenuItem } from './KebabMenu.js'
import { useModal } from './modal/ModalProvider.js'
import { ChatIcon, DisableIcon, DownloadIcon, EnableIcon } from '../icons.js'

export interface CourseRowsProps {
  organizationId: string
  courses: CourseSummary[]
  onOpenCourse: (courseId: string) => void
  /** WEB-28: opens a chat session for this course directly, switching the shell to its Chat tab with it already selected. */
  onOpenChat: (courseId: string) => void
  /** Called once a course's enabled state actually changed (never on Export, which changes nothing) — the caller's own cue to refetch, at whatever scope makes sense for it. */
  onChanged: () => void
  /**
   * WEB-42 review finding: `pages/Courses.tsx` never passes this — one
   * project's own courses are already unambiguous among themselves on
   * that screen (its own heading already names the one project every row
   * belongs to). `pages/Projects.tsx` lists more than one project's
   * courses on the same page, and nothing makes a course title unique
   * *across* projects (PROJ-3's collision rule scopes category/role
   * names, not titles) — two duplicated projects (`Projects.tsx
   * #handleDuplicate`) copy every title unchanged, so without this two
   * rows can read "Chat about "Intro to CS"" and "Actions for "Intro to
   * CS"" with nothing to tell a screen reader, or a `getByRole` query,
   * which project's course either one names. Threaded straight into both
   * labels below when given; omitted (not even a trailing "in undefined")
   * when not.
   */
  projectName?: string
}

export function CourseRows({
  organizationId,
  courses,
  onOpenCourse,
  onOpenChat,
  onChanged,
  projectName,
}: CourseRowsProps) {
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [busyCourseId, setBusyCourseId] = useState<string | undefined>(
    undefined
  )
  const { confirm } = useModal()

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
      onChanged()
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setBusyCourseId(undefined)
    }
  }

  /**
   * WEB-39/PORT-1 — export this course's configuration and hand the file to
   * the browser. The action returns the file's text (PORT-8: an export is an
   * action like any other, not a download route), so the saving happens here.
   */
  const handleExport = async (course: CourseSummary) => {
    setError(undefined)
    setBusyCourseId(course.id)
    try {
      const result = await exportCourse(organizationId, course.id)
      downloadTextFile(result.filename, result.content)
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setBusyCourseId(undefined)
    }
  }

  return (
    <>
      {error && <ErrorMessage error={error} />}
      {/* WEB-13: a card per course, stacked — never a wide table row a
          phone would have to scroll horizontally to read. */}
      <ul className="flex flex-col gap-3">
        {courses.map((course) => {
          const busy = busyCourseId === course.id
          // WEB-26: a kebab holding Disable/Enable — destructive-styled
          // only for Disable, matching the danger treatment the button
          // this replaces used to carry only while the course was
          // enabled.
          const items: KebabMenuItem[] = [
            {
              key: 'export',
              label: 'Export',
              icon: <DownloadIcon aria-hidden="true" className="size-4" />,
              onSelect: () => void handleExport(course),
            },
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
                  {/* PROJ-7: a role that is absent must not render as an
                      empty `<code>` tag — this reads sensibly whether
                      neither, one, or both roles are set. */}
                  {course.adminsRole === null && course.studentsRole === null ? (
                    'does not route on a role'
                  ) : (
                    <>
                      routes on role{' '}
                      {course.adminsRole !== null && (
                        <code className="rounded bg-neutral-100 px-1">
                          {course.adminsRole}
                        </code>
                      )}
                      {course.adminsRole !== null &&
                        course.studentsRole !== null &&
                        ' / '}
                      {course.studentsRole !== null && (
                        <code className="rounded bg-neutral-100 px-1">
                          {course.studentsRole}
                        </code>
                      )}
                    </>
                  )}{' '}
                  — {course.enabled ? 'enabled' : 'disabled'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {/* WEB-28: the one action on this row worth its own
                    control — opens a chat session for this course
                    directly. `aria-label` names the row, the same
                    reason the kebab beside it does (`KebabMenu.tsx`'s
                    own module comment) — a six-course list otherwise
                    reads as six identically-named "Chat" buttons to a
                    screen reader, and to `getByRole('button', { name:
                    'Chat' })` in a test. */}
                <Button
                  variant="secondary"
                  icon={<ChatIcon aria-hidden="true" className="size-4" />}
                  aria-label={
                    projectName
                      ? `Chat about "${course.title}" in "${projectName}"`
                      : `Chat about "${course.title}"`
                  }
                  onClick={() => onOpenChat(course.id)}
                >
                  Chat
                </Button>
                <KebabMenu
                  label={
                    projectName
                      ? `Actions for "${course.title}" in "${projectName}"`
                      : `Actions for "${course.title}"`
                  }
                  items={items}
                  disabled={busy}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}
