/**
 * ADMIN-1/ADMIN-3: an instructor reads their course's transcripts,
 * filtered by student and by date, and exports one as a job.
 *
 * The same project → course picker `pages/ProjectsPanel.tsx` already uses
 * for `Courses.tsx`/`CourseEditor.tsx` (`listProjects`/`listCourses`), so
 * this screen adds no new way to choose a course — only what happens once
 * one is chosen. Every read and every export request goes through
 * `dispatchAction` (`api/client.ts`'s own module comment on
 * `readTranscript`/`exportTranscript`), the one write path every other
 * screen in this panel already uses.
 *
 * **WEB-64 extraction: everything from "a course is chosen" downward now
 * lives in `components/TranscriptBrowser.tsx`**, shared with the course
 * editor's own Transcripts tab (`pages/CourseEditor.tsx`) — the student and
 * date filters, the entries list, the export button and its own list of
 * requested exports, and the ADMIN-2 access log. See that file's own
 * module comment for the shape of what moved and why. What is left here is
 * the part that component genuinely cannot do on its own: choosing *which*
 * course, including WEB-36's own route-linked seeding — the course tab has
 * no picker and no route-named person to seed from at all, so it needed
 * none of this.
 *
 * **`TranscriptBrowser` is mounted fresh, keyed by
 * `${courseId}:${seedGeneration}`, whenever this screen settles on a
 * (possibly new) course.** A fresh mount is what replaces the entries/
 * students/exports/access-log half of the WEB-36 rework's own `epochRef`/
 * `seedRef` machinery — there is no in-flight fetch inside
 * `TranscriptBrowser` for a *later* pick to race, because picking again
 * simply mounts a new instance. `seedGeneration` is bumped only when the
 * *route* names a genuinely new (course, person) pair while the course
 * itself has not changed (WEB-36 rework round 1, must-fix 1's own
 * "a routePersonId change alone" case) — an ordinary course pick already
 * forces a fresh instance through `courseId` itself, and does not touch
 * this counter.
 *
 * **`epochRef`/`seedRef`/`seededCourseRef` still guard what remains
 * genuinely racy here**: resolving a route-named course's project
 * (`getCourse`) and this screen's own course list (`listCourses`), both of
 * which a newer pick can still land after. `seedRef` also gates the
 * ordinary "project changed" course-list fetch below, the same
 * "stand aside while a seed's own chain is outstanding" reasoning this
 * file has always used — see each ref's own comment for the rest.
 *
 * **`startDate`/`endDate` are owned here, not inside `TranscriptBrowser`.**
 * WEB-36 rework round 1 found a date filter must survive an *ordinary*
 * course change (only the student filter clears) — since a course change
 * here means a fresh `TranscriptBrowser` instance, the dates would reset
 * with it if that component owned them; passed down as controlled props
 * instead (`TranscriptBrowser`'s own module comment on the same split).
 *
 * WEB-36: a person's own transcript link (`components/CoursePeople.tsx`)
 * opens this screen with that course, and that person, already chosen and
 * read. This screen has no project id of its own in the address (only a
 * course does — `routing/route.ts#TranscriptsRoute`'s own comment on why)
 * — a route-named course's project is resolved via `getCourse`, the same
 * read `pages/CourseEditor.tsx` already makes for the course editor
 * itself. A course this account cannot read (deleted, or another
 * organization's) surfaces through the same `ApiError` this screen already
 * renders for every other refusal, rather than an empty screen. A
 * *disabled* course still resolves (a person does not stop having a
 * transcript because their course was disabled afterward) even though the
 * course picker below is otherwise limited to enabled courses only
 * (ADMIN-1's own choice, unchanged) — folded into `courses` as the one
 * exception, found through the same `getCourse` call, never through
 * relaxing that filter generally, and marked "— disabled" in its own
 * option text since a picker documented as enabled-only otherwise gives no
 * sign why one entry differs.
 *
 * WEB-36/D-81 (`docs/DECISIONS.md`): choosing a different course *within*
 * this screen also rewrites the address (`navigate`, below) — project does
 * not, since it has none in the address to write to; changing it while a
 * course is chosen instead navigates back to the bare `/transcripts`
 * landing address, since the course it named no longer makes sense under a
 * different project. `routing/useRoute.ts`'s own `navigate` already no-ops
 * a call that would push the address already on screen, so this never
 * fights the seeding effect above (which only ever seeds when the route
 * names something this screen has not already applied).
 */

import { useEffect, useRef, useState } from 'react'

import {
  ApiError,
  getCourse,
  listCourses,
  listProjects,
} from '../api/client.js'
import type { Course, CourseSummary, Project } from '../api/types.js'
import type { Route } from '../routing/route.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { FormField } from '../components/FormField.js'
import { textInputClasses } from '../components/fieldStyles.js'
import { TranscriptBrowser } from '../components/TranscriptBrowser.js'

export interface TranscriptsScreenProps {
  organizationId: string
  /** Whether the caller's own membership in this organization is `'owner'` — see `components/TranscriptBrowser.tsx`'s own module comment for why the Access log section is withheld rather than merely disabled for anyone else. */
  isOwner: boolean
  /** WEB-36 — the route's own course, from a transcript link elsewhere in the app (`components/CoursePeople.tsx`) or a bookmarked/copied address; `undefined` for this screen's ordinary landing address. */
  courseId?: string
  /** WEB-36 — the route's own person within `courseId`; only ever present alongside one (`routing/route.ts#TranscriptsRoute`'s own comment on why the two cannot be split). */
  personId?: string
  /** WEB-32/WEB-34's own `navigate`, threaded down from `pages/Shell.tsx` — this screen's own module comment on when it is called. */
  navigate: (route: Route, options?: { replace?: boolean }) => void
}

export function Transcripts({
  organizationId,
  isOwner,
  courseId: routeCourseId,
  personId: routePersonId,
  navigate,
}: TranscriptsScreenProps) {
  const [projects, setProjects] = useState<Project[] | undefined>(undefined)
  const [projectId, setProjectId] = useState('')
  const [courses, setCourses] = useState<CourseSummary[] | undefined>(undefined)
  const [courseId, setCourseId] = useState('')

  // WEB-64 — owned here so a filter set on one course survives an ordinary
  // pick to another (this file's own module comment on why); handed to
  // `TranscriptBrowser` as controlled props.
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  // WEB-64 — the personId `TranscriptBrowser` should seed its own Student
  // filter with, on its *next* mount only (that component's own module
  // comment on why a later change to this value is never watched by an
  // already-mounted instance). `undefined` for an ordinary pick, which
  // starts a course unfiltered.
  const [seedPersonId, setSeedPersonId] = useState<string | undefined>(
    undefined
  )
  // WEB-64 — folded into `TranscriptBrowser`'s own `key`, below, so a
  // route-named person arriving for the *same* course (WEB-36 rework round
  // 1, must-fix 1) still forces a fresh instance even though `courseId`
  // itself has not changed. An ordinary course pick does not bump this —
  // `courseId` changing is already enough to force a fresh instance.
  const [seedGeneration, setSeedGeneration] = useState(0)

  const [error, setError] = useState<ApiError | undefined>(undefined)

  // WEB-36 rework round 1 — this file's own module comment has the full
  // reasoning for both. `epochRef` is bumped by every "this course
  // selection starts over" moment (a fresh seed beginning, or a project/
  // course pick below); every asynchronous stage below captures the
  // current epoch before it starts and checks it again before calling any
  // `setState`, so whichever request is actually current is the only one
  // that can still paint the screen. `seedRef` names the seed this
  // screen's own project/course state is currently governed by, if any —
  // `null` when none is; set here, cleared on a failure anywhere along the
  // chain, but deliberately *not* cleared on success, the same "several
  // `setState` calls can resolve before React commits the first of them"
  // reasoning this file has always relied on — and `seededCourseRef`
  // carries only the resolved `Course` the disabled-course exception
  // (this file's own module comment) needs.
  const epochRef = useRef(0)
  const seedRef = useRef<{
    courseId: string
    personId: string | undefined
  } | null>(null)
  const seededCourseRef = useRef<Course | undefined>(undefined)
  // WEB-36 rework round 1 (e2e finding, not covered by the unit suite: its
  // own props never actually change in response to a `navigate` call the
  // way a live route does) — the last `(courseId, personId)` pair this
  // effect has already started applying, from *any* source: a seed, or an
  // ordinary pick. `navigate`, live in the app, feeds straight back down
  // through `pages/Shell.tsx` as this component's own next
  // `courseId`/`personId` props — so a plain click on the Course `<select>`
  // below both sets state directly *and*, one render later, arrives here
  // again as a "new" route to react to. Comparing against this ref (kept
  // in lockstep by every pick below, and by `TranscriptBrowser`'s own
  // `onPersonIdChange`) is what tells that echo apart from a genuine
  // external change (Back, the drawer's own landing address, a fresh
  // `CoursePeople.tsx` link).
  const appliedRouteRef = useRef<{
    courseId: string | undefined
    personId: string | undefined
  }>({ courseId: undefined, personId: undefined })

  useEffect(() => {
    setProjects(undefined)
    listProjects(organizationId).then(
      (result) => setProjects(result),
      (caught: unknown) => {
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [organizationId])

  // WEB-36 rework round 1 — this file's own module comment has the full
  // reasoning: reacts to *every* change of `routeCourseId`/`routePersonId`.
  useEffect(() => {
    if (
      appliedRouteRef.current.courseId === routeCourseId &&
      appliedRouteRef.current.personId === routePersonId
    ) {
      return
    }
    appliedRouteRef.current = {
      courseId: routeCourseId,
      personId: routePersonId,
    }

    const epoch = ++epochRef.current
    // Review must-fix 1 — a previous refusal (this screen's own project/
    // course resolution, not `TranscriptBrowser`'s own) must not outlive
    // the attempt that produced it: a fresh route naming a course is a
    // fresh attempt, genuinely different from the one that failed, whether
    // it lands on a real course or the route simply lost its course
    // entirely (the branch just below). Left uncleared here, a refusal
    // from an earlier, invalid route stayed on screen for the life of this
    // mounted instance even once a later pick resolved cleanly underneath
    // it — undismissable without a reload.
    setError(undefined)

    if (routeCourseId === undefined) {
      // The route lost its course (the drawer's own bare landing address):
      // reset exactly what the address governs, the same fields an
      // ordinary "clear the Course select" already clears. The project is
      // not part of the address, so it is left as is.
      seedRef.current = null
      seededCourseRef.current = undefined
      setCourseId('')
      setSeedPersonId(undefined)
      return
    }

    seedRef.current = { courseId: routeCourseId, personId: routePersonId }
    getCourse(organizationId, routeCourseId).then(
      (course) => {
        if (epochRef.current !== epoch) return
        seededCourseRef.current = course
        const seed = seedRef.current
        if (!seed) return

        setProjectId(course.projectId)
        setCourseId(seed.courseId)
        setSeedPersonId(seed.personId)
        setSeedGeneration((generation) => generation + 1)

        listCourses(organizationId, course.projectId).then(
          (result) => {
            if (epochRef.current !== epoch) return
            const enabled = result.filter((candidate) => candidate.enabled)
            setCourses(
              enabled.some((candidate) => candidate.id === seed.courseId)
                ? enabled
                : [...enabled, course]
            )
          },
          (caught: unknown) => {
            if (epochRef.current === epoch) {
              seedRef.current = null
              seededCourseRef.current = undefined
              if (caught instanceof ApiError) setError(caught)
              else throw caught
            }
          }
        )
      },
      (caught: unknown) => {
        if (epochRef.current === epoch) {
          seedRef.current = null
          seededCourseRef.current = undefined
          // A course this account cannot read (deleted, or another
          // organization's) surfaces through the same `ErrorMessage` every
          // other refusal on this screen already renders — never a
          // silently empty screen.
          if (caught instanceof ApiError) setError(caught)
          else throw caught
        }
      }
    )
  }, [organizationId, routeCourseId, routePersonId])

  // The ordinary "an instructor picked a different project" fetch — stands
  // aside entirely whenever `seedRef.current` names the course this
  // screen's state currently reflects (that ref's own comment, above, on
  // why it stays set well past the seed's own asynchronous work finishing,
  // rather than being cleared the instant it does): the seeding effect
  // performs this exact fetch itself, with its own disabled-course
  // exception folded in, and letting both run would race two owners over
  // the same `courses` state.
  useEffect(() => {
    if (seedRef.current) return
    setCourses(undefined)
    if (!projectId) return
    const epoch = epochRef.current
    listCourses(organizationId, projectId).then(
      (result) => {
        if (epochRef.current !== epoch) return
        setCourses(result.filter((course) => course.enabled))
      },
      (caught: unknown) => {
        if (epochRef.current !== epoch) return
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [organizationId, projectId])

  return (
    <section
      aria-label="Transcripts"
      data-testid="transcripts-screen"
      className="flex flex-col gap-6"
    >
      <h1 className="text-page-title font-semibold text-neutral-900">
        Transcripts
      </h1>

      <div className="flex flex-col gap-3 sm:flex-row">
        <FormField label="Project">
          <select
            aria-label="Project"
            value={projectId}
            onChange={(event) => {
              const nextProjectId = event.target.value
              // WEB-36 rework round 1, must-fix 3 — bumped immediately, not
              // only inside an effect: an in-flight seed's own `getCourse`
              // (or any of its own downstream fetches) checks this before
              // ever calling `setProjectId`/`setCourseId` again, so it can
              // no longer yank the instructor back onto a project they
              // already picked their way out of while it was resolving.
              epochRef.current += 1
              seedRef.current = null
              seededCourseRef.current = undefined
              // Review must-fix 1 — this screen's own comment on the
              // seeding effect's identical clear: a project pick is a
              // fresh attempt too, and must not leave an earlier refusal
              // on screen underneath a course that goes on to load fine.
              setError(undefined)
              setProjectId(nextProjectId)
              // Clearing on a project change is explicit here, not a side
              // effect the `[organizationId, projectId]` effect above bakes
              // in for every caller, seeded or not.
              setCourseId('')
              setSeedPersonId(undefined)
              if (courseId) {
                // `appliedRouteRef`'s own comment on why this is kept in
                // lockstep with every `navigate` call this screen itself
                // makes — otherwise the address this very call is about to
                // push arrives back down as props and re-triggers the
                // seeding effect for its own pick.
                appliedRouteRef.current = {
                  courseId: undefined,
                  personId: undefined,
                }
                navigate({ kind: 'transcripts', organizationId })
              }
            }}
            className={textInputClasses}
          >
            <option value="">Choose a project…</option>
            {projects?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Course">
          <select
            aria-label="Course"
            value={courseId}
            onChange={(event) => {
              const next = event.target.value
              epochRef.current += 1
              seedRef.current = null
              seededCourseRef.current = undefined
              // Review must-fix 1 — the same clear the Project select's own
              // handler makes, above.
              setError(undefined)
              setCourseId(next)
              // WEB-64 — an ordinary course pick starts unfiltered; the
              // `courseId` change itself is already enough to mount a
              // fresh `TranscriptBrowser` (this file's own module comment
              // on why `seedGeneration` is not bumped here too).
              setSeedPersonId(undefined)
              // `appliedRouteRef`'s own comment on why this is kept in
              // lockstep with the `navigate` call just below.
              appliedRouteRef.current = {
                courseId: next || undefined,
                personId: undefined,
              }
              // WEB-36 — the address names the screen (WEB-32/WEB-34):
              // picking a course here is as real a navigation as clicking
              // a transcript link from `components/CoursePeople.tsx`.
              navigate(
                next
                  ? { kind: 'transcripts', organizationId, courseId: next }
                  : { kind: 'transcripts', organizationId }
              )
            }}
            disabled={!projectId || courses === undefined}
            className={textInputClasses}
          >
            <option value="">Choose a course…</option>
            {courses?.map((course) => (
              <option key={course.id} value={course.id}>
                {/* WEB-36 (rework round 1, cheap fix): this list is
                    otherwise enabled-only (this file's own module
                    comment); the one exception a seed can add is marked
                    here, rather than sorting last with no sign why it
                    differs from every other entry. */}
                {course.enabled ? course.title : `${course.title} — disabled`}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      {error && <ErrorMessage error={error} />}

      {courseId && (
        <TranscriptBrowser
          key={`${courseId}:${seedGeneration}`}
          organizationId={organizationId}
          courseId={courseId}
          isOwner={isOwner}
          {...(seedPersonId !== undefined
            ? { initialPersonId: seedPersonId }
            : {})}
          onPersonIdChange={(next) => {
            // `appliedRouteRef`'s own comment on why this is kept in
            // lockstep with the `navigate` call just below — an ordinary
            // Student pick inside `TranscriptBrowser` is as real a
            // navigation as a course pick here.
            appliedRouteRef.current = { courseId, personId: next }
            navigate(
              next
                ? {
                    kind: 'transcripts',
                    organizationId,
                    courseId,
                    personId: next,
                  }
                : { kind: 'transcripts', organizationId, courseId }
            )
          }}
          startDate={startDate}
          onStartDateChange={setStartDate}
          endDate={endDate}
          onEndDateChange={setEndDate}
        />
      )}
    </section>
  )
}
