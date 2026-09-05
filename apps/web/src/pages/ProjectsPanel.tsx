/**
 * WEB-7/WEB-8: the umbrella over the three project/course screens —
 * `Projects.tsx`, `Courses.tsx`, `CourseEditor.tsx` — switched between
 * through `pages/Shell.tsx`'s own `route` prop (WEB-32), not a
 * component-local `view` state as before this slice: each of the four
 * addresses `routing/route.ts#ProjectsRoute` names —
 * `/o/:organizationId/projects`, `/o/:organizationId/projects/:projectId`,
 * `/o/:organizationId/projects/:projectId/courses/new` and
 * `/o/:organizationId/projects/:projectId/courses/:courseId` — is a real,
 * bookmarkable, back-button-reachable screen.
 *
 * A deep link only ever carries the ids the address itself names, never the
 * whole `Project` record `pages/Projects.tsx#onOpenProject` used to hand
 * this component directly — there is no `projects.get` action (`courses.get`
 * exists for a single course, but a single project is only ever read as
 * part of `projects.list`), so `useResolvedProject`, below, reads the
 * organization's whole project list (including archived — a bookmarked or
 * reload-held address should not go dark just because the project was
 * archived since) and searches it for the id the route names. A project id
 * that is not in that list at all (deleted, or never this organization's)
 * renders `pages/NotFound.tsx` rather than a 404 from a deeper fetch that
 * never had a project to make sense of.
 */

import { useEffect, useState } from 'react'

import { ApiError, listProjects } from '../api/client.js'
import type { Course, Project } from '../api/types.js'
import type { ProjectsRoute, Route } from '../routing/route.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { CourseEditor } from './CourseEditor.js'
import { Courses } from './Courses.js'
import { NotFound } from './NotFound.js'
import { Projects } from './Projects.js'

export interface ProjectsPanelProps {
  organizationId: string
  /** WEB-32 — which of the four project/course addresses is current. */
  route: ProjectsRoute
  navigate: (route: Route, options?: { replace?: boolean }) => void
  /** WEB-28: threaded down to `pages/Courses.tsx`'s own Chat button — see `pages/Shell.tsx`'s own module comment for what actually happens once a course id reaches here. */
  onOpenChat: (courseId: string) => void
}

/** `useResolvedProject`'s own three shapes — mirrors `pages/Shell.tsx`'s own `DiscordBindingState` (TEN-8): `'loading'` must never be mistaken for "not found," and a failed lookup says so rather than guessing. */
type ProjectResolution =
  | { status: 'loading' }
  | { status: 'ready'; project: Project }
  | { status: 'not-found' }
  | { status: 'error'; error: ApiError }

export function ProjectsPanel({
  organizationId,
  route,
  navigate,
  onOpenChat,
}: ProjectsPanelProps) {
  const [resolution, setResolution] = useState<ProjectResolution>({
    status: 'loading',
  })

  // Resolves the route's own `projectId` into the `Project` record
  // `Courses`/`CourseEditor` below still take whole — skipped entirely for
  // plain `'projects'`, which names no project to resolve and renders
  // `Projects` directly, below, without paying for this fetch at all.
  useEffect(() => {
    // Cleared, not merely skipped, on the way back to `'projects'` (review
    // finding): returning early while a previous project's `'ready'`
    // resolution is still in state meant the *next* project opened rendered
    // `<Courses project={previous}>` for one commit — the old project's
    // heading flashed, and its `courses.list` was issued — before this
    // effect's own `setResolution({ status: 'loading' })` below took hold.
    if (route.kind === 'projects') {
      setResolution({ status: 'loading' })
      return
    }
    let stale = false
    setResolution({ status: 'loading' })
    listProjects(organizationId, true).then(
      (result) => {
        if (stale) return
        const project = result.find(
          (candidate) => candidate.id === route.projectId
        )
        setResolution(
          project ? { status: 'ready', project } : { status: 'not-found' }
        )
      },
      (caught: unknown) => {
        if (stale) return
        if (caught instanceof ApiError) {
          setResolution({ status: 'error', error: caught })
        } else throw caught
      }
    )
    return () => {
      stale = true
    }
    // `route.kind === 'projects'` never reaches the fetch above, so its own
    // `projectId` (absent on that variant) never belongs in this list —
    // narrowed explicitly rather than depending on `route` as a whole,
    // which would refetch on every `courseId` change too.
  }, [organizationId, route.kind === 'projects' ? undefined : route.projectId])

  if (route.kind === 'projects') {
    return (
      <Projects
        organizationId={organizationId}
        onOpenProject={(project) =>
          navigate({
            kind: 'project-courses',
            organizationId,
            projectId: project.id,
          })
        }
      />
    )
  }

  if (resolution.status === 'loading') {
    return (
      <p role="status" className="text-sm text-neutral-500">
        Loading…
      </p>
    )
  }

  if (resolution.status === 'error') {
    return <ErrorMessage error={resolution.error} />
  }

  if (resolution.status === 'not-found') {
    return (
      <NotFound onHome={() => navigate({ kind: 'projects', organizationId })} />
    )
  }

  const project = resolution.project

  if (route.kind === 'project-courses') {
    return (
      <Courses
        organizationId={organizationId}
        project={project}
        onBack={() => navigate({ kind: 'projects', organizationId })}
        onOpenCourse={(courseId) =>
          navigate(
            courseId === undefined
              ? { kind: 'new-course', organizationId, projectId: project.id }
              : {
                  kind: 'course-editor',
                  organizationId,
                  projectId: project.id,
                  courseId,
                }
          )
        }
        onOpenChat={onOpenChat}
      />
    )
  }

  // `route.kind` is `'new-course'` or `'course-editor'` here — `CourseEditor`
  // itself already handles `courseId === undefined` as "define a new one"
  // (its own `courseId` prop's doc comment, unchanged by this slice).
  return (
    <CourseEditor
      organizationId={organizationId}
      project={project}
      courseId={route.kind === 'course-editor' ? route.courseId : undefined}
      onCancel={() =>
        navigate({
          kind: 'project-courses',
          organizationId,
          projectId: project.id,
        })
      }
      // WEB-34 — `replace`, never a push: `CourseEditor` calls `onSaved` on
      // *every* save, not only the first, so pushing would stack one
      // identical entry per save and leave Back apparently dead for as many
      // presses as the instructor made saves. Worse after a *create*: the
      // entry underneath is the blank `new-course` form, so one Back landed
      // on an empty creation screen for a course that already exists, where
      // saving again would create a duplicate. Replacing keeps the address
      // honest (the saved course's own) while leaving the entry behind it
      // the screen the instructor actually came from.
      onSaved={(course: Course) =>
        navigate(
          {
            kind: 'course-editor',
            organizationId,
            projectId: project.id,
            courseId: course.id,
          },
          { replace: true }
        )
      }
    />
  )
}
