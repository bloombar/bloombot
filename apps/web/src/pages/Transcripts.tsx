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
 * read — `routeCourseId`/`routePersonId` below are the route's own reading
 * of `routing/route.ts#TranscriptsRoute`, applied once through
 * `pendingCourseIdRef`/`pendingPersonIdRef` and `seedingRef`, rather than as
 * ordinary seeds to `useState`: `projectId`/`courseId`/`personId` are
 * genuinely derived state here (the `[organizationId, projectId]` effect
 * clears `courseId`, the `[organizationId, courseId]` effect clears
 * `personId`, both unchanged from before this slice), and a naive seed
 * would be clobbered by exactly those clears the moment `projectId` is set
 * to the seeded course's own project. Each ref hands its effect the one
 * value to apply *instead of* clearing, consumed the instant that effect
 * reads it, so a later, ordinary project or course change clears
 * `courseId`/`personId` exactly as it always has (the ref is empty by
 * then). `seedingRef` additionally suppresses the ordinary
 * apply-on-courseId-change read (below) for the one render where seeding
 * itself is still in flight, and the seeded read is issued explicitly, with
 * the seeded `personId` rather than whatever is in state at that instant —
 * see the effect chain below for why relying on the ordinary effect there
 * would silently read one render too early, missing the seeded person.
 *
 * This screen has no project id of its own in the address (only a course
 * does — `routing/route.ts#TranscriptsRoute`'s own comment on why) — a
 * seeded course's project is resolved via `getCourse`, the same read
 * `pages/CourseEditor.tsx` already makes for the course editor itself. A
 * course this account cannot read (deleted, or another organization's)
 * surfaces through the same `ApiError` this screen already renders for
 * every other refusal, rather than an empty screen. A *disabled* course
 * still resolves (a person does not stop having a transcript because their
 * course was disabled afterward) even though the course picker below is
 * otherwise limited to enabled courses only (ADMIN-1's own choice,
 * unchanged) — folded into `courses` as the one exception, found through
 * the same `getCourse` call, never through relaxing that filter generally.
 *
 * WEB-36/D-8x (`docs/DECISIONS.md`): choosing a different course or person
 * *within* this screen also rewrites the address (`navigate`, below) —
 * project does not, since it has none in the address to write to; changing
 * it while a course is chosen instead navigates back to the bare
 * `/transcripts` landing address, since the course it named no longer makes
 * sense under a different project. `routing/useRoute.ts`'s own `navigate`
 * already no-ops a call that would push the address already on screen, so
 * this never fights the seeding effect above (which only ever seeds when
 * the route names a course this screen has not already loaded) or stacks a
 * redundant history entry.
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

  // WEB-36 — this file's own module comment has the fuller reasoning: each
  // ref hands the effect about to clear `courseId`/`personId` the one value
  // to seed instead, consumed the instant that effect reads it.
  // `seededCourseRef` also carries the whole `Course` the seed resolved, so
  // the course-list effect below can show it selected even when it is
  // disabled (that effect's own comment on why). `seedingRef` marks the
  // window during which the ordinary apply-on-courseId-change read (below)
  // must stand aside for the seeded read.
  const pendingCourseIdRef = useRef<string | undefined>(undefined)
  const pendingPersonIdRef = useRef<string | undefined>(undefined)
  const seededCourseRef = useRef<Course | undefined>(undefined)
  const seedingRef = useRef(false)

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

  // WEB-36 — resolves a route-named course into the project it belongs to
  // (this screen's own module comment on why: no project id in the
  // address). Guarded by `routeCourseId !== courseId` rather than firing on
  // mount alone: this screen's own onChange handlers below already carry
  // `courseId` (state) to the same value a resulting `navigate` call feeds
  // back down as `routeCourseId`, so a user's own pick — which pushes the
  // very address this effect would otherwise read — never re-triggers it.
  useEffect(() => {
    if (routeCourseId === undefined || routeCourseId === courseId) return
    let stale = false
    seedingRef.current = true
    getCourse(organizationId, routeCourseId).then(
      (course) => {
        if (stale) return
        seededCourseRef.current = course
        pendingCourseIdRef.current = routeCourseId
        pendingPersonIdRef.current = routePersonId
        setProjectId(course.projectId)
      },
      (caught: unknown) => {
        if (stale) return
        seedingRef.current = false
        // A course this account cannot read (deleted, or another
        // organization's) surfaces through the same `ErrorMessage` every
        // other refusal on this screen already renders — never a silently
        // empty screen (this file's own module comment on why).
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
    return () => {
      stale = true
    }
  }, [organizationId, routeCourseId, courseId])

  useEffect(() => {
    setCourses(undefined)
    // WEB-36 — a pending seed from the effect above takes the place of the
    // ordinary clear-to-blank below; consumed by the students-loading
    // effect further down, not here, since this effect does not yet know
    // whether the seeded course actually exists in this project's list.
    const seededCourseId = pendingCourseIdRef.current
    setCourseId(seededCourseId ?? '')
    if (!projectId) return
    listCourses(organizationId, projectId).then(
      (result) => {
        const enabled = result.filter((course) => course.enabled)
        // WEB-36 — a person linked from a disabled course must still open
        // with that course selected (this file's own module comment on
        // why); the one exception to "enabled courses only" (ADMIN-1's own
        // long-standing choice for this picker, unchanged otherwise),
        // added only for the seeded course itself, found by the same
        // `getCourse` the seed already made — never by relaxing the filter
        // in general.
        if (
          seededCourseId &&
          seededCourseRef.current?.id === seededCourseId &&
          !enabled.some((candidate) => candidate.id === seededCourseId)
        ) {
          setCourses([...enabled, seededCourseRef.current])
        } else {
          setCourses(enabled)
        }
      },
      (caught: unknown) => {
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [organizationId, projectId])

  useEffect(() => {
    setEntries(undefined)
    setStudents([])
    // WEB-36 — the seed's own last leg: `pendingPersonIdRef` (paired with
    // the `courseId` the effect above just applied) takes the place of the
    // ordinary clear-to-blank, and both refs are cleared immediately so a
    // later, ordinary course change — the seed is only ever consumed once —
    // clears `personId` exactly as it always has.
    const seededPersonId = pendingPersonIdRef.current
    pendingCourseIdRef.current = undefined
    pendingPersonIdRef.current = undefined
    setPersonId(seededPersonId ?? '')
    if (!courseId) return
    listTranscriptStudents(organizationId, courseId).then(
      (result) => {
        setStudents(result)
        if (seedingRef.current) {
          // WEB-36 — the explicit "already read" this file's own module
          // comment calls for. The ordinary apply-on-courseId-change effect
          // below fires off this very same `courseId` change too, but its
          // closure over `personId` would still read the value from
          // *before* `setPersonId` above lands (both effects fire in the
          // same render) — left to run, it would read the whole course
          // first and only correct itself, one further audited read later,
          // once state caught up. `seedingRef` suppresses that one; this
          // reads directly, with the seeded person this effect already
          // knows, rather than trusting state to have caught up in time.
          seedingRef.current = false
          setError(undefined)
          setLoading(true)
          readTranscript(
            organizationId,
            courseId,
            seededPersonId ? { personId: seededPersonId } : {}
          ).then(
            (searchResult) => {
              setEntries(searchResult.entries)
              refreshAccessLog()
              setLoading(false)
            },
            (caught: unknown) => {
              setLoading(false)
              if (caught instanceof ApiError) setError(caught)
              else throw caught
            }
          )
        }
      },
      (caught: unknown) => {
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

  const runSearch = useCallback(async () => {
    if (!courseId) return
    setError(undefined)
    setLoading(true)
    try {
      const result = await readTranscript(
        organizationId,
        courseId,
        currentFilters()
      )
      setEntries(result.entries)
      // This read is itself an ADMIN-2 event — an owner watching the
      // Access log section sees it without a manual refresh (this file's
      // own module comment on `refreshAccessLog`).
      refreshAccessLog()
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setLoading(false)
    }
  }, [organizationId, courseId, currentFilters, refreshAccessLog])

  // Deliberately keyed on `organizationId`/`courseId` alone, not on
  // `runSearch` (which itself closes over the current filters): a filter
  // change applies when the instructor presses "Apply filters" below, not
  // on every keystroke — ADMIN-2 audits every read, so this screen must
  // not fire one per character typed into a date field.
  //
  // WEB-36 — stands aside entirely while `seedingRef.current` is set: this
  // fires off the exact same `courseId` change the seeding effect above
  // does, in the same render, but `runSearch`'s own closure over `personId`
  // would still read the value from before that effect's own `setPersonId`
  // lands — left running, a route naming both a course and a person would
  // read the whole course's transcript first and only correct itself,
  // one further audited read later. The seeded read itself is issued
  // explicitly, with the right person already known, once the seed
  // actually finishes (the students-loading effect above).
  useEffect(() => {
    if (courseId && !seedingRef.current) void runSearch()
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
              setProjectId(event.target.value)
              // WEB-36 — this screen's own module comment: there is no
              // project id in the address, so changing the project itself
              // never navigates — but it does clear `courseId` (the effect
              // above, unchanged), which the address does name, so that
              // address is corrected back to the bare landing screen rather
              // than going on naming a course this screen no longer shows.
              if (courseId) navigate({ kind: 'transcripts', organizationId })
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
              setCourseId(next)
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
                {course.title}
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
