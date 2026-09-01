/**
 * WEB-8/PROJ-5: a project's own courses — listed through `courses.list`
 * (base rows, no categories/channels — matching that action's own split
 * from `courses.get`), with each course's enabled state toggled directly
 * from here (`courses.enable`/`courses.disable`) and a way into
 * `pages/CourseEditor.tsx` to define a new one or edit an existing one.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { disableCourse, enableCourse, listCourses } from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { CourseSummary, Project } from '../api/types.js'
import { ErrorMessage } from '../components/ErrorMessage.js'

export interface CoursesScreenProps {
  organizationId: string
  project: Project
  onBack: () => void
  onOpenCourse: (courseId: string | undefined) => void
}

export function Courses({
  organizationId,
  project,
  onBack,
  onOpenCourse,
}: CoursesScreenProps) {
  const [courses, setCourses] = useState<CourseSummary[] | undefined>(undefined)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [busyCourseId, setBusyCourseId] = useState<string | undefined>(
    undefined
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
    <section aria-label="Courses" data-testid="courses-screen">
      <button type="button" onClick={onBack}>
        ← Projects
      </button>
      <h2>{project.name}</h2>

      <button type="button" onClick={() => onOpenCourse(undefined)}>
        New course
      </button>

      {error && <ErrorMessage error={error} />}

      {courses === undefined ? (
        <p>Loading…</p>
      ) : courses.length === 0 ? (
        <p>No courses in this project yet.</p>
      ) : (
        <ul>
          {courses.map((course) => (
            <li key={course.id} data-testid={`course-${course.id}`}>
              <button type="button" onClick={() => onOpenCourse(course.id)}>
                {course.title}
              </button>
              {' — routes on roles '}
              <code>{course.adminsRole}</code>
              {' / '}
              <code>{course.studentsRole}</code>
              {' — '}
              {course.enabled ? 'enabled' : 'disabled'}
              <button
                type="button"
                onClick={() => void handleToggle(course)}
                disabled={busyCourseId === course.id}
              >
                {course.enabled ? 'Disable' : 'Enable'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
