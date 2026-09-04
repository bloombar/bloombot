/**
 * WEB-7/WEB-8: the umbrella over the three project/course screens —
 * `Projects.tsx`, `Courses.tsx`, `CourseEditor.tsx` — switching between
 * them with a plain discriminated-union `view` state, the same shape
 * `App.tsx`'s own `SessionState` switches on one level up. Not URL-driven
 * the way `App.tsx`'s `/sign-in/:token` and `/discord/callback` are: those
 * two are one-time entry points a browser can land on directly (an emailed
 * link, Discord's own redirect) and must not be reachable by pressing
 * "back" into; navigating from a project to one of its courses is ordinary
 * in-panel navigation with no such constraint, so component state is
 * enough — the brief's own "no router library" without inventing history
 * entries nothing here needs.
 */

import { useState } from 'react'

import type { Course, Project } from '../api/types.js'
import { CourseEditor } from './CourseEditor.js'
import { Courses } from './Courses.js'
import { Projects } from './Projects.js'

export interface ProjectsPanelProps {
  organizationId: string
  /** WEB-28: threaded down to `pages/Courses.tsx`'s own Chat button — see `pages/Shell.tsx`'s own module comment for what actually happens once a course id reaches here. */
  onOpenChat: (courseId: string) => void
}

type View =
  | { kind: 'projects' }
  | { kind: 'courses'; project: Project }
  | { kind: 'course-editor'; project: Project; courseId: string | undefined }

export function ProjectsPanel({
  organizationId,
  onOpenChat,
}: ProjectsPanelProps) {
  const [view, setView] = useState<View>({ kind: 'projects' })

  if (view.kind === 'projects') {
    return (
      <Projects
        organizationId={organizationId}
        onOpenProject={(project) => setView({ kind: 'courses', project })}
      />
    )
  }

  if (view.kind === 'courses') {
    return (
      <Courses
        organizationId={organizationId}
        project={view.project}
        onBack={() => setView({ kind: 'projects' })}
        onOpenCourse={(courseId) =>
          setView({ kind: 'course-editor', project: view.project, courseId })
        }
        onOpenChat={onOpenChat}
      />
    )
  }

  return (
    <CourseEditor
      organizationId={organizationId}
      project={view.project}
      courseId={view.courseId}
      onCancel={() => setView({ kind: 'courses', project: view.project })}
      onSaved={(course: Course) =>
        setView({
          kind: 'course-editor',
          project: view.project,
          courseId: course.id,
        })
      }
    />
  )
}
