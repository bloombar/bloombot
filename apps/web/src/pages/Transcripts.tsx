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
 * **ADMIN-2's own read path, owner-only.** An audit
 * (`docs/ROADMAP.md`'s "Audit — surfaces that were never built") found the
 * transcript-access audit trail this screen's own reads and exports write
 * to (`transcripts.read`/`.export`'s own module comment) had no read path
 * anywhere — `isOwner` (a prop, computed once in `pages/Shell.tsx` from the
 * caller's own membership, the same shape `pages/Usage.tsx`/`components/Team.tsx`
 * already take) decides whether the "Access log" section below even fetches
 * or renders, the same "withhold the control rather than offer one every
 * click through which would refuse" discipline those two already hold
 * themselves to — `transcripts.listAccessLog`'s own `execute` is what
 * actually enforces the restriction (`actions/transcripts.ts`'s own module
 * comment on why an owner, not any membership).
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
 * option text (rework round 1, cheap fix) since a picker documented as
 * enabled-only otherwise gives no sign why one entry differs.
 *
 * **Rework round 1: the screen ignored a route change it did not cause
 * itself.** The first draft's seeding effect bailed once `routeCourseId`
 * matched `courseId` (state) — correct for the one case it was built for
 * (this screen's own pick echoing back down as the very route it just
 * pushed) but wrong for every other way the route can change while this
 * screen stays mounted (`pages/Shell.tsx` renders
 * `<Transcripts key={activeOrganizationId}>`, so an organization switch
 * remounts this screen, but nothing else does): Back to a previous course
 * or person, a fresh `CoursePeople.tsx` link landing on an *already*-loaded
 * project, or the drawer's own Transcripts item pushing the bare
 * `/o/:id/transcripts` (`pages/Shell.tsx`'s own comment: that address is
 * this tab's plain landing screen). All three left the address and the
 * screen disagreeing about what was on display — a copied URL handed
 * someone a different transcript from the one visibly open.
 *
 * Fixed by giving route-seeding its own effect, keyed on
 * `[organizationId, routeCourseId, routePersonId]` — it now reacts to
 * *every* change those props make, not only the first one, and owns the
 * whole chain itself (resolving the project, choosing the course, loading
 * students, choosing the person, and reading) rather than leaning on the
 * ordinary project/course-list effects below to notice a `projectId`/
 * `courseId` change and do that work as a side effect — a same-project or
 * same-course reseed leaves one or both of those exactly as they already
 * were, a no-op `setState` React never turns into a re-run, which is
 * *why* the first draft's approach could not react to those two cases no
 * matter how its bail condition was written. `routeCourseId === undefined`
 * (the route losing its course) resets exactly what the address governs —
 * `courseId`, `personId`, the loaded students and the entries on screen —
 * the same fields an ordinary "clear the Course select" already clears;
 * the project itself stays, since it was never part of the address to
 * begin with. The two ordinary effects stand aside entirely while a seed
 * is outstanding (`seedRef.current !== null`, below) rather than racing it
 * to fetch the same lists a second time.
 *
 * **Rework round 1: one seed descriptor, one owner, every failure clears
 * it.** The first draft split "is a seed outstanding" across three refs
 * and a boolean, none of which were ever reliably cleared on a failure —
 * `listTranscriptStudents` erroring mid-seed left the boolean `true` for
 * the rest of the screen's life, after which an unrelated, later course
 * pick silently inherited the stale seed's own `personId` and issued an
 * ADMIN-2-audited read of the wrong thing. `seedRef` (`{ courseId,
 * personId } | null`) is now the one question with one owner — `null`
 * means no seed currently governs this screen's own project/course/
 * student state — and `seededCourseRef` carries only the resolved `Course`
 * the disabled-course exception above needs. Every *failure* along the
 * chain clears both; a *success*, deliberately, does not (`seedRef`'s own
 * comment, below, on why: a mocked, or genuinely fast, chain of
 * `getCourse` -> `listCourses`/`listTranscriptStudents` -> `readTranscript`
 * can fully resolve — several `setState` calls deep — before React ever
 * commits the *first* of those state changes and runs the ordinary
 * project/course effects' own pass for it; clearing on success left those
 * effects nothing to skip on, and they raced the seed to fetch (or read)
 * the exact same thing a second time). `epochRef`/`readEpochRef` are the
 * second half: two separate counters
 * (`readEpochRef`'s own comment on why two, not one), each bumped by every
 * "this context starts over" moment it owns — a fresh seed beginning or a
 * project/course pick for `epochRef`, any new read for `readEpochRef` —
 * rather than a `stale` flag local to one effect. An in-flight `getCourse`
 * that would otherwise land after the instructor already picked a
 * different project (must-fix 3) checks `epochRef`; a stale read landing
 * after a newer one already painted the screen under a different course's
 * own heading (must-fix 4, the pre-existing gap in `runSearch` this
 * slice's own second concurrent writer made cross-course) checks
 * `readEpochRef`. Both check before ever calling `setState`.
 *
 * WEB-36/D-81 (`docs/DECISIONS.md`): choosing a different course or person
 * *within* this screen also rewrites the address (`navigate`, below) —
 * project does not, since it has none in the address to write to; changing
 * it while a course is chosen instead navigates back to the bare
 * `/transcripts` landing address, since the course it named no longer makes
 * sense under a different project. `routing/useRoute.ts`'s own `navigate`
 * already no-ops a call that would push the address already on screen, so
 * this never fights the seeding effect above (which only ever seeds when
 * the route names something this screen has not already applied) or
 * stacks a redundant history entry.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ApiError,
  exportTranscript,
  getCourse,
  listCourses,
  listProjects,
  listTranscriptAccessLog,
  listTranscriptExports,
  listTranscriptStudents,
  readTranscript,
  transcriptExportDownloadUrl,
  type TranscriptFilters,
} from '../api/client.js'
import type {
  Course,
  CourseSummary,
  Project,
  TranscriptAccessLogEntry,
  TranscriptEntry,
  TranscriptExport,
  TranscriptStudent,
} from '../api/types.js'
import type { Route } from '../routing/route.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { FormField } from '../components/FormField.js'
import { textInputClasses } from '../components/fieldStyles.js'
import {
  DownloadIcon,
  FailureIcon,
  PendingIcon,
  SuccessIcon,
} from '../icons.js'

export interface TranscriptsScreenProps {
  organizationId: string
  /** Whether the caller's own membership in this organization is `'owner'` — see this file's own module comment for why the Access log section is withheld rather than merely disabled for anyone else. */
  isOwner: boolean
  /** WEB-36 — the route's own course, from a transcript link elsewhere in the app (`components/CoursePeople.tsx`) or a bookmarked/copied address; `undefined` for this screen's ordinary landing address. */
  courseId?: string
  /** WEB-36 — the route's own person within `courseId`; only ever present alongside one (`routing/route.ts#TranscriptsRoute`'s own comment on why the two cannot be split). */
  personId?: string
  /** WEB-32/WEB-34's own `navigate`, threaded down from `pages/Shell.tsx` — this screen's own module comment on when it is called. */
  navigate: (route: Route, options?: { replace?: boolean }) => void
}

/** A `<input type="date">` value's own start-of-day/end-of-day boundary, in epoch milliseconds — `undefined` for an empty picker, so an unset filter is genuinely omitted rather than sent as `NaN`. */
function dayStart(value: string): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(`${value}T00:00:00`)
  return Number.isNaN(parsed) ? undefined : parsed
}
function dayEnd(value: string): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(`${value}T23:59:59.999`)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Every export this course has requested is still `pending` a moment after being requested — polled, not pushed, the same "poll a job's own status" convention `pages/CourseEditor.tsx`'s own scaffold job polling already uses. */
const EXPORTS_POLL_MS = 2000

/** The same threshold, and the same reasoning, `components/ScaffoldButton.tsx`'s own `DEFAULT_STILL_QUEUED_HINT_AFTER_MS` already uses — long enough that an ordinary claim delay never trips it, short enough that a genuinely stuck export (no background worker running) does not read as a silent hang for minutes. Compared against `exportRow.createdAt` directly (a server timestamp already on the row) rather than client-side polling state, so it reads correctly even on the very first render after a page reload, before this screen has polled even once. */
const STILL_QUEUED_HINT_AFTER_MS = 8_000

function exportStatusIcon(status: TranscriptExport['status']) {
  switch (status) {
    case 'ready':
      return (
        <SuccessIcon aria-hidden="true" className="size-4 text-success-600" />
      )
    case 'failed':
      return (
        <FailureIcon aria-hidden="true" className="size-4 text-danger-600" />
      )
    case 'pending':
      return (
        <PendingIcon aria-hidden="true" className="size-4 text-neutral-400" />
      )
  }
}

/** Also-fix of the ADMIN-1..5 rework: a bare timestamp with no label read identically for `pending` and for `ready` — `components/ScaffoldButton.tsx`'s own explicit per-status labelling is the precedent this slice's brief already named. */
function exportStatusLabel(status: TranscriptExport['status']): string {
  switch (status) {
    case 'ready':
      return 'Ready'
    case 'failed':
      return 'Failed'
    case 'pending':
      return 'Queued…'
  }
}

/** ADMIN-2 — a plain past-tense verb for the audit row's own `kind`, matching `entries`' own `entry.direction === 'from_person' ? 'asked' : 'answered'` convention just below. */
function accessLogVerb(kind: TranscriptAccessLogEntry['kind']): string {
  return kind === 'export' ? 'exported' : 'read'
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

  const [students, setStudents] = useState<TranscriptStudent[]>([])
  const [personId, setPersonId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const [entries, setEntries] = useState<TranscriptEntry[] | undefined>(
    undefined
  )
  const [exports, setExports] = useState<TranscriptExport[]>([])
  // ADMIN-2 — this file's own module comment. Only ever fetched for an
  // owner (the effect below skips the request entirely otherwise); stays
  // `[]` for anyone else, so the section renders nothing rather than an
  // empty-looking one nobody asked to see.
  const [accessLog, setAccessLog] = useState<TranscriptAccessLogEntry[]>([])
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)

  // WEB-36 rework round 1 — this file's own module comment has the full
  // reasoning for both. `epochRef` is bumped by every "this course/entries
  // context starts over" moment (a fresh seed beginning, or a project/
  // course pick below); every asynchronous stage in this file captures the
  // current epoch before it starts and checks it again before calling any
  // `setState`, so whichever request is actually current is the only one
  // that can still paint the screen. `seedRef` names the seed this
  // screen's own project/course/student state is currently governed by, if
  // any — `null` when none is; set here, cleared on a failure anywhere
  // along the chain, but deliberately *not* cleared on success (this file's
  // own module comment on why) — and `seededCourseRef` carries only the
  // resolved `Course` the disabled-course exception (this file's own
  // module comment) needs.
  const epochRef = useRef(0)
  const seedRef = useRef<{
    courseId: string
    personId: string | undefined
  } | null>(null)
  const seededCourseRef = useRef<Course | undefined>(undefined)
  // WEB-36 rework round 1, must-fix 4 — a second, separate counter, bumped
  // only by a genuinely new *read* (an "Apply filters" click, the ordinary
  // apply-on-courseId-change effect below, or the seed's own explicit
  // read), and checked only around `setEntries`/the read's own
  // loading/error state. Kept apart from `epochRef` deliberately: that one
  // is bumped by every course-*selection* change (a project or course
  // pick), including ones — like the auto-search effect's own `runSearch`
  // call landing in the same commit as a fresh course selection — that
  // must not invalidate a sibling fetch (the course or student list) still
  // loading for that same selection. Two readers writing `entries`
  // (`runSearch` and the seed's own explicit read) is exactly the race
  // this counter exists to settle: whichever call bumped it last is the
  // only one still allowed to paint the screen.
  const readEpochRef = useRef(0)
  // WEB-36 rework round 1 (e2e finding, not covered by the unit suite: its
  // own props never actually change in response to a `navigate` call the
  // way a live route does) — the last `(courseId, personId)` pair this
  // effect has already started applying, from *any* source: a seed, or an
  // ordinary pick. `navigate`, live in the app, feeds straight back down
  // through `pages/Shell.tsx` as this component's own next
  // `courseId`/`personId` props — so a plain click on the Course `<select>`
  // below both sets state directly *and*, one render later, arrives here
  // again as a "new" route to react to. Comparing against this ref (kept
  // in lockstep by every `<select>`'s own `onChange`, below) is what tells
  // that echo apart from a genuine external change (Back, the drawer's own
  // landing address, a fresh `CoursePeople.tsx` link) — without it, every
  // ordinary pick re-ran the entire seed chain a second time, dispatching
  // (and ADMIN-2-auditing) a duplicate `transcripts.read`.
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
  // reasoning: reacts to *every* change of `routeCourseId`/`routePersonId`
  // (a different course, a same-project course, a person added, removed or
  // swapped with the course unchanged, or the route losing its course
  // entirely), and owns the whole seeded chain itself rather than leaning
  // on the ordinary project/course effects below to react to a `projectId`/
  // `courseId` change that a same-project or same-course reseed never
  // actually produces.
  useEffect(() => {
    // WEB-36 rework round 1 — `appliedRouteRef`'s own comment on why this
    // check exists at all: an ordinary pick below already applied this
    // exact `(courseId, personId)` pair itself, and updated this ref to
    // match *before* calling `navigate` — so if the route now arriving
    // here is exactly that, it is that same pick's own address landing
    // back down as props, not a genuinely new one to seed from.
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

    if (routeCourseId === undefined) {
      // The route lost its course (the drawer's own bare landing address —
      // this file's own module comment on why that means "this tab's
      // plain landing screen"): reset exactly what the address governs,
      // the same fields an ordinary "clear the Course select" already
      // clears. The project is not part of the address (this file's own
      // module comment on why), so it is left as is.
      seedRef.current = null
      seededCourseRef.current = undefined
      setCourseId('')
      setPersonId('')
      setStudents([])
      setEntries(undefined)
      return
    }

    seedRef.current = { courseId: routeCourseId, personId: routePersonId }
    getCourse(organizationId, routeCourseId).then(
      (course) => {
        if (epochRef.current !== epoch) return
        seededCourseRef.current = course
        const seed = seedRef.current
        if (!seed) return

        // Always performed directly, whether or not `projectId`/`courseId`
        // actually change — a same-project or same-course reseed would
        // otherwise leave the ordinary effects below with nothing to react
        // to (this file's own module comment on why that was the actual
        // defect, not merely an oversight in a bail condition).
        setProjectId(course.projectId)
        setCourseId(seed.courseId)
        setEntries(undefined)

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

        listTranscriptStudents(organizationId, seed.courseId).then(
          (result) => {
            if (epochRef.current !== epoch) return
            setStudents(result)
            setPersonId(seed.personId ?? '')
            setError(undefined)
            setLoading(true)
            // must-fix 4 — this seed's own read gets its own token, the
            // same way `runSearch` below gets its own for an ordinary
            // read; whichever of the two lands last under a *different*
            // token was already superseded, and must not paint `entries`.
            const readEpoch = ++readEpochRef.current
            readTranscript(
              organizationId,
              seed.courseId,
              seed.personId ? { personId: seed.personId } : {}
            ).then(
              (searchResult) => {
                if (epochRef.current === epoch) {
                  if (readEpochRef.current === readEpoch) {
                    setEntries(searchResult.entries)
                    refreshAccessLog()
                  }
                  setLoading(false)
                  // WEB-36 rework round 1, must-fix 1/2 — `seedRef`/
                  // `seededCourseRef` are deliberately *not* cleared here,
                  // on success: this file's own module comment on why a
                  // mocked (and sometimes a genuinely fast) chain of
                  // `getCourse` -> `listCourses`/`listTranscriptStudents`
                  // -> `readTranscript` can fully resolve, several
                  // `setState` calls deep, before React ever commits the
                  // *first* of those state changes and runs the ordinary
                  // project/course effects' own dependency-triggered pass
                  // for it — those effects, once they do run, would see
                  // `courseId` already at the seeded value but find nothing
                  // recorded to skip on, and duplicate this exact fetch (or
                  // this exact audited read) a second time. Leaving this
                  // set means "this screen's project/course/student state
                  // currently reflects this seed," true for as long as it
                  // actually does — cleared only when something supersedes
                  // it: a new route-seed overwriting it with a fresh target
                  // (below), the route losing its course, or an ordinary
                  // pick (the three `<select>`s' own `onChange` handlers,
                  // all of which null it explicitly before setting
                  // anything else).
                }
              },
              (caught: unknown) => {
                if (epochRef.current === epoch) {
                  setLoading(false)
                  seedRef.current = null
                  seededCourseRef.current = undefined
                  if (readEpochRef.current === readEpoch) {
                    if (caught instanceof ApiError) setError(caught)
                    else throw caught
                  }
                }
              }
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
          // silently empty screen (this file's own module comment on why).
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

  // The ordinary "an instructor picked a different course" fetch — same
  // stand-aside-during-a-seed reasoning as the project effect above.
  // Clearing `personId`/`entries`/`students` on an ordinary pick is done
  // explicitly, in the `<select>`'s own `onChange` below, rather than here
  // — this effect only ever loads the list for whichever `courseId` is
  // already current.
  useEffect(() => {
    if (seedRef.current) return
    setStudents([])
    if (!courseId) return
    const epoch = epochRef.current
    listTranscriptStudents(organizationId, courseId).then(
      (result) => {
        if (epochRef.current !== epoch) return
        setStudents(result)
      },
      (caught: unknown) => {
        if (epochRef.current !== epoch) return
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [organizationId, courseId])

  // ADMIN-2 — this file's own module comment: fetched only for an owner
  // (`transcripts.listAccessLog` would otherwise refuse it, the same
  // "withhold rather than offer a click that would refuse" discipline
  // `pages/Usage.tsx`'s own `isOwner` gate already takes). Re-run after
  // `runSearch`/`handleExport` below, not only on a course switch — the
  // read (or export) this very screen just made is itself an ADMIN-2 event,
  // and an owner reading their own access log should see it without a
  // manual refresh.
  const refreshAccessLog = useCallback(() => {
    if (!isOwner || !courseId) {
      setAccessLog([])
      return
    }
    listTranscriptAccessLog(organizationId, courseId).then(
      (result) => setAccessLog(result),
      (caught: unknown) => {
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [organizationId, courseId, isOwner])

  useEffect(() => {
    refreshAccessLog()
  }, [refreshAccessLog])

  const currentFilters = useCallback((): TranscriptFilters => {
    const startAt = dayStart(startDate)
    const endAt = dayEnd(endDate)
    return {
      ...(personId ? { personId } : {}),
      ...(startAt !== undefined ? { startAt } : {}),
      ...(endAt !== undefined ? { endAt } : {}),
    }
  }, [personId, startDate, endDate])

  // WEB-36 rework round 1, must-fix 4 — bumps its own epoch on every call
  // (an "Apply filters" click, or the ordinary apply-on-courseId-change
  // effect below) and checks it again once `readTranscript` resolves, so a
  // slower, earlier response (from this function or from the seeding
  // effect above) can never land after a newer one already painted the
  // screen under a different course's own heading.
  const runSearch = useCallback(async () => {
    if (!courseId) return
    // must-fix 4 — this function's own read token (`readEpochRef`'s own
    // comment on why this is a separate counter from `epochRef`).
    const epoch = ++readEpochRef.current
    setError(undefined)
    setLoading(true)
    try {
      const result = await readTranscript(
        organizationId,
        courseId,
        currentFilters()
      )
      if (readEpochRef.current !== epoch) return
      setEntries(result.entries)
      // This read is itself an ADMIN-2 event — an owner watching the
      // Access log section sees it without a manual refresh (this file's
      // own module comment on `refreshAccessLog`).
      refreshAccessLog()
    } catch (caught) {
      if (readEpochRef.current !== epoch) return
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      if (readEpochRef.current === epoch) setLoading(false)
    }
  }, [organizationId, courseId, currentFilters, refreshAccessLog])

  // Deliberately keyed on `organizationId`/`courseId` alone, not on
  // `runSearch` (which itself closes over the current filters): a filter
  // change applies when the instructor presses "Apply filters" below, not
  // on every keystroke — ADMIN-2 audits every read, so this screen must
  // not fire one per character typed into a date field.
  //
  // WEB-36 — stands aside entirely whenever `seedRef.current` is set
  // (`seedRef`'s own comment on why that stays true well past the point
  // its own asynchronous work actually finishes): this fires off the exact
  // same `courseId` change the seeding effect above produces, but that
  // effect already issues its own explicit read, with the route's own
  // person rather than whatever `personId` happens to be in state at
  // whichever instant this effect actually gets to run — the two are not
  // guaranteed to be the same instant (this file's own module comment on
  // why, must-fix 1/2).
  useEffect(() => {
    if (courseId && !seedRef.current) void runSearch()
  }, [organizationId, courseId])

  // ADMIN-3's own "collect the file when it is ready" — polled while any
  // export for this course is still pending, stopped once none are.
  const refreshExports = useCallback(() => {
    if (!courseId) return
    listTranscriptExports(organizationId, courseId).then(
      (result) => setExports(result),
      (caught: unknown) => {
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [organizationId, courseId])

  useEffect(() => {
    refreshExports()
  }, [refreshExports])

  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  useEffect(() => {
    const stillPending = exports.some((entry) => entry.status === 'pending')
    if (stillPending && !pollRef.current) {
      pollRef.current = setInterval(refreshExports, EXPORTS_POLL_MS)
    } else if (!stillPending && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = undefined
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = undefined
      }
    }
  }, [exports, refreshExports])

  const handleExport = async () => {
    if (!courseId) return
    setError(undefined)
    setExporting(true)
    try {
      await exportTranscript(organizationId, courseId, currentFilters())
      refreshExports()
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setExporting(false)
    }
  }

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
              setProjectId(nextProjectId)
              // WEB-36 rework round 1 — clearing on a project change is
              // explicit here now, not a side effect the `[organizationId,
              // projectId]` effect above used to bake in for every caller,
              // seeded or not (this file's own module comment on why that
              // coupling was the actual defect).
              setCourseId('')
              setPersonId('')
              setStudents([])
              setEntries(undefined)
              // This screen's own module comment: there is no project id in
              // the address, so changing the project itself never
              // navigates — but it does clear `courseId`, which the address
              // does name, so that address is corrected back to the bare
              // landing screen rather than going on naming a course this
              // screen no longer shows.
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
              setCourseId(next)
              // WEB-36 rework round 1 — explicit here now, not left to the
              // `[organizationId, courseId]` effect above (this file's own
              // module comment on why that coupling was the actual defect).
              setPersonId('')
              setStudents([])
              setEntries(undefined)
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
        <>
          <div className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4 sm:flex-row sm:items-end">
            <FormField label="Student">
              <select
                aria-label="Student"
                value={personId}
                onChange={(event) => {
                  const next = event.target.value
                  setPersonId(next)
                  // `appliedRouteRef`'s own comment on why this is kept in
                  // lockstep with the `navigate` call just below.
                  appliedRouteRef.current = {
                    courseId,
                    personId: next || undefined,
                  }
                  // WEB-36 — same "the address names the screen" choice as
                  // the course select above; `courseId` is always present
                  // here (this select only renders once one is chosen).
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
                className={textInputClasses}
              >
                <option value="">Every student</option>
                {students.map((student) => (
                  <option key={student.personId} value={student.personId}>
                    {student.personDisplayName ?? student.personId}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="From">
              <input
                aria-label="From date"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                className={textInputClasses}
              />
            </FormField>
            <FormField label="To">
              <input
                aria-label="To date"
                type="date"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
                className={textInputClasses}
              />
            </FormField>
            <Button
              variant="primary"
              onClick={() => void runSearch()}
              disabled={loading}
            >
              {loading ? 'Loading…' : 'Apply filters'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void handleExport()}
              disabled={exporting}
            >
              {exporting ? 'Requesting export…' : 'Export'}
            </Button>
          </div>

          {!personId && (
            // ADMIN-1..5 rework, must-fix 1 — an export with no student
            // filter carries every entry in this course, and
            // `apps/worker/src/handlers/transcripts.ts`'s own
            // `identityFieldsOmitted` flag (D-48) only removes `personId`/
            // `personDisplayName` and replaces them with a pseudonym
            // stable within that one file; it says nothing about the
            // *message text itself*, which this platform's own opening
            // line for a conversation (`packages/openai/src/conversations.ts`)
            // deliberately seeds with a student's own name, and a reply
            // may echo. Said here, next to the button, rather than left
            // for an instructor to notice only inside the JSON.
            <p className="text-xs text-neutral-600">
              This export carries every student in the course. Student ids and
              names are replaced with a pseudonym unique to this file (unstable
              across two exports of the same course) — but the conversation text
              itself is not filtered, and may still name a student.
            </p>
          )}

          {entries === undefined ? (
            <p role="status" className="text-sm text-neutral-500">
              Loading…
            </p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No messages match these filters.
            </p>
          ) : (
            <ul
              className="flex flex-col gap-2"
              data-testid="transcript-entries"
            >
              {entries.map((entry, index) => (
                <li
                  key={index}
                  className="flex flex-col gap-1 rounded-md border border-neutral-200 p-3"
                >
                  <div className="flex items-center justify-between text-xs text-neutral-500">
                    <span>
                      {entry.personDisplayName ?? entry.personId} —{' '}
                      {entry.direction === 'from_person' ? 'asked' : 'answered'}
                    </span>
                    <time dateTime={new Date(entry.createdAt).toISOString()}>
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-neutral-900">
                    {entry.content}
                  </p>
                </li>
              ))}
            </ul>
          )}

          {exports.length > 0 && (
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold text-neutral-900">
                Exports
              </h2>
              <ul
                className="flex flex-col gap-2"
                data-testid="transcript-exports"
              >
                {exports.map((exportRow) => {
                  const stillQueued =
                    exportRow.status === 'pending' &&
                    Date.now() - exportRow.createdAt >
                      STILL_QUEUED_HINT_AFTER_MS
                  return (
                    <li
                      key={exportRow.id}
                      className="flex flex-col gap-1 rounded-md border border-neutral-200 p-3 text-sm"
                    >
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2 text-neutral-700">
                          {exportStatusIcon(exportRow.status)}
                          {exportStatusLabel(exportRow.status)} —{' '}
                          {new Date(exportRow.createdAt).toLocaleString()}
                        </span>
                        {exportRow.status === 'ready' && (
                          <a
                            href={transcriptExportDownloadUrl(
                              organizationId,
                              exportRow.id
                            )}
                            className="flex items-center gap-1 text-brand-700 underline-offset-2 hover:underline"
                          >
                            <DownloadIcon
                              aria-hidden="true"
                              className="size-4"
                            />
                            Download
                          </a>
                        )}
                      </div>
                      {exportRow.status === 'failed' &&
                        exportRow.failureReason && (
                          <p className="text-sm text-danger-700">
                            {exportRow.failureReason}
                          </p>
                        )}
                      {stillQueued && (
                        <p role="status" className="text-sm text-warning-600">
                          Still queued — make sure the background worker (
                          <code>npm run worker:dev</code>) is running.
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {/* ADMIN-2 — this file's own module comment: withheld entirely
              for anyone but an owner, not merely rendered empty. */}
          {isOwner && (
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold text-neutral-900">
                Access log
              </h2>
              {accessLog.length === 0 ? (
                <p className="text-sm text-neutral-500">
                  No reads recorded yet.
                </p>
              ) : (
                <ul
                  className="flex flex-col gap-2"
                  data-testid="transcript-access-log"
                >
                  {accessLog.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 p-3 text-xs text-neutral-500"
                    >
                      <span>
                        {entry.actorDisplayName} {accessLogVerb(entry.kind)}{' '}
                        {entry.personDisplayName ?? 'the whole course'}
                      </span>
                      <time dateTime={new Date(entry.createdAt).toISOString()}>
                        {new Date(entry.createdAt).toLocaleString()}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
