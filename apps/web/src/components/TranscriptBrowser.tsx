/**
 * ADMIN-1/ADMIN-2/ADMIN-3/WEB-64 — everything `pages/Transcripts.tsx` does
 * *once a course is chosen*: the student and date-range filters, the
 * entries list, requesting and collecting an export, and (an owner only)
 * the ADMIN-2 access log — extracted so this exists once and is used both
 * by that screen (once its own project/course picker has settled on a
 * course) and by the course editor's own Transcripts tab
 * (`pages/CourseEditor.tsx`, WEB-64), which has no picker at all — its
 * course is simply a prop.
 *
 * `courseId` is fixed for the life of one mounted instance — this
 * component has no course-switching logic of its own at all. A caller that
 * *does* let a course change (`pages/Transcripts.tsx`) mounts a fresh
 * instance per course with a `key` (React's own "start over" primitive)
 * rather than this component tracking a `courseId` prop change itself —
 * which is what removes the need for this half of the WEB-36 rework's own
 * `epochRef`/`seedRef` machinery entirely: there is no in-flight fetch here
 * that a *later* courseId can ever race, because there is no later
 * courseId. The one race this file still guards (`readEpochRef`, below) is
 * narrower: an explicit "Apply filters" landing after a newer one already
 * did.
 *
 * **`initialPersonId` seeds the Student filter once, at mount, and is never
 * read again** — WEB-36's own transcript link (`components/CoursePeople.tsx`)
 * opens `pages/Transcripts.tsx` with a person already chosen, and that
 * screen re-keys this component (bumping its own seed generation, its own
 * module comment) whenever the *route* names a genuinely new
 * (course, person) pair, so "seeded again" is "mounted again" here, not a
 * prop this component watches for changes. An ordinary Student pick, inside
 * this component, is reported upward through `onPersonIdChange` instead —
 * the course tab (WEB-64) has no address segment for a person at all, so it
 * simply does not pass one.
 *
 * **`startDate`/`endDate` are controlled, unlike `personId`.** WEB-36
 * rework round 1 found a date filter must *survive* an ordinary course
 * change on `pages/Transcripts.tsx` (only the student filter clears) —
 * since a course change there means a fresh instance of *this* component,
 * the dates cannot live in this component's own state, or they would reset
 * with it. `pages/Transcripts.tsx` owns them across course changes and
 * passes them down; the course tab, whose course never changes under one
 * mounted instance, simply leaves them out and lets this component own
 * them itself.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ApiError,
  exportTranscript,
  listTranscriptAccessLog,
  listTranscriptExports,
  listTranscriptStudents,
  readTranscript,
  transcriptExportDownloadUrl,
  type TranscriptFilters,
} from '../api/client.js'
import type {
  TranscriptAccessLogEntry,
  TranscriptEntry,
  TranscriptExport,
  TranscriptStudent,
} from '../api/types.js'
import { personIdentity } from '../person-identity.js'
import { surfaceLabel, TRANSCRIPT_SURFACES } from '../surface-label.js'
import { Button } from './Button.js'
import { ErrorMessage } from './ErrorMessage.js'
import { FormField } from './FormField.js'
import { textInputClasses } from './fieldStyles.js'
import { LoadingStatus, SkeletonRow } from './Skeleton.js'
import {
  DownloadIcon,
  FailureIcon,
  PendingIcon,
  SuccessIcon,
} from '../icons.js'

export interface TranscriptBrowserProps {
  organizationId: string
  /** Fixed for the life of this mounted instance — this file's own module comment on why. */
  courseId: string
  /** Whether the caller's own membership in this organization is `'owner'` — gates the Access log section, the same discipline `pages/Usage.tsx`/`pages/Transcripts.tsx` already hold themselves to. */
  isOwner: boolean
  /** WEB-36 — the Student filter's own starting value, applied once at mount; this file's own module comment on why it is read only once. */
  initialPersonId?: string
  /** Called on an ordinary Student pick, so a caller with its own address for it (`pages/Transcripts.tsx`) can navigate. */
  onPersonIdChange?: (personId: string | undefined) => void
  /** Controlled — this file's own module comment on why dates are not owned locally the way `personId` is. Omit both to let this component own the date fields itself (the course tab's own case). */
  startDate?: string
  onStartDateChange?: (value: string) => void
  endDate?: string
  onEndDateChange?: (value: string) => void
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

/** The same threshold, and the same reasoning, `components/ScaffoldButton.tsx`'s own `DEFAULT_STILL_QUEUED_HINT_AFTER_MS` already uses. */
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

/** ADMIN-2 — a plain past-tense verb for the audit row's own `kind`. */
function accessLogVerb(kind: TranscriptAccessLogEntry['kind']): string {
  return kind === 'export' ? 'exported' : 'read'
}

/**
 * WEB-65 — an entry's own heading: the student's own name alone
 * (`from_person`), or "Bloombot to `<name>`" (`to_person`) — replacing the
 * former "`<name>` — asked"/"`<name>` — answered" pairing. The name is
 * WEB-52's own rule, applied through `person-identity.ts`.
 */
function entryHeading(entry: TranscriptEntry): string {
  const name = personIdentity({
    personId: entry.personId,
    personFirstName: entry.personFirstName,
    personLastName: entry.personLastName,
    personEmail: entry.personEmail,
    personDiscordName: entry.personDisplayName,
  })
  return entry.direction === 'from_person' ? name : `Bloombot to ${name}`
}

/**
 * WEB-65 — where an entry arrived, and (Discord only) which category and
 * channel — `undefined` when the surface itself was never recorded, so
 * nothing is guessed at (`ChatMessage.tsx`'s own `messageOrigin` mirrors
 * this for the chat surface, across the two components' own duplicated-by-
 * necessity boundary — this file has no reason to import from a component
 * file, and vice versa).
 */
function entryOrigin(entry: TranscriptEntry): string | undefined {
  if (!entry.surface) return undefined
  const label = surfaceLabel(entry.surface)
  if (entry.surface !== 'discord') return label
  const place = [entry.categoryRef, entry.channelRef]
    .filter(Boolean)
    .join(' / ')
  return place ? `${label} — ${place}` : label
}

export function TranscriptBrowser({
  organizationId,
  courseId,
  isOwner,
  initialPersonId,
  onPersonIdChange,
  startDate: controlledStartDate,
  onStartDateChange,
  endDate: controlledEndDate,
  onEndDateChange,
}: TranscriptBrowserProps) {
  // `personId`'s own initializer runs once, at mount, reading
  // `initialPersonId` at that instant only — this file's own module comment
  // on why a *later* change to that prop is never watched here.
  const [personId, setPersonId] = useState(initialPersonId ?? '')
  // WEB-66 — uncontrolled, the same way `personId` above is: unlike
  // `startDate`/`endDate` (which must survive an ordinary course change,
  // this file's own module comment on why those are controlled), nothing
  // asks this filter to survive one, so a fresh mount starting unfiltered
  // is the right default, the same one `personId` already uses.
  const [surface, setSurface] = useState<'' | 'discord' | 'web' | 'mcp'>('')
  const [students, setStudents] = useState<TranscriptStudent[]>([])
  // Uncontrolled fallback for the course tab (WEB-64), which never passes
  // `startDate`/`endDate` at all — this file's own module comment on why
  // `pages/Transcripts.tsx` controls these instead.
  const [uncontrolledStartDate, setUncontrolledStartDate] = useState('')
  const [uncontrolledEndDate, setUncontrolledEndDate] = useState('')
  const startDate = controlledStartDate ?? uncontrolledStartDate
  const endDate = controlledEndDate ?? uncontrolledEndDate
  const setStartDate = onStartDateChange ?? setUncontrolledStartDate
  const setEndDate = onEndDateChange ?? setUncontrolledEndDate

  const [entries, setEntries] = useState<TranscriptEntry[] | undefined>(
    undefined
  )
  const [exports, setExports] = useState<TranscriptExport[]>([])
  const [accessLog, setAccessLog] = useState<TranscriptAccessLogEntry[]>([])
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)

  // The one race this component still guards — this file's own module
  // comment on why it is narrower than `pages/Transcripts.tsx`'s own pair of
  // epoch refs: an explicit "Apply filters" (or the mount-triggered first
  // read) landing after a *newer* one already painted the screen.
  const readEpochRef = useRef(0)

  useEffect(() => {
    listTranscriptStudents(organizationId, courseId).then(
      (result) => setStudents(result),
      (caught: unknown) => {
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [])

  const refreshAccessLog = useCallback(() => {
    if (!isOwner) {
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
  }, [isOwner])

  const currentFilters = useCallback((): TranscriptFilters => {
    const startAt = dayStart(startDate)
    const endAt = dayEnd(endDate)
    return {
      ...(personId ? { personId } : {}),
      ...(startAt !== undefined ? { startAt } : {}),
      ...(endAt !== undefined ? { endAt } : {}),
      // WEB-66 — combines with the filters above rather than replacing
      // them; the server (`transcripts.read`/`.export`) applies all of
      // them together, in the same query.
      ...(surface ? { surface } : {}),
    }
  }, [personId, startDate, endDate, surface])

  const runSearch = useCallback(async () => {
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
      // ADMIN-2 — this read is itself an audited event; an owner watching
      // the Access log section sees it without a manual refresh.
      refreshAccessLog()
    } catch (caught) {
      if (readEpochRef.current !== epoch) return
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      if (readEpochRef.current === epoch) setLoading(false)
    }
  }, [organizationId, courseId, currentFilters, refreshAccessLog])

  // Mount-only — the single read WEB-36's own test proves ("never an
  // unfiltered whole-course read followed by a filtered one"): `personId`'s
  // own initializer has already applied `initialPersonId` by the time this
  // runs, so a seeded read and an ordinary "course just chosen" read are the
  // same call.
  useEffect(() => {
    void runSearch()
    refreshAccessLog()
  }, [])

  const refreshExports = useCallback(() => {
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
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4 sm:flex-row sm:items-end">
        <FormField label="Student">
          <select
            aria-label="Student"
            value={personId}
            onChange={(event) => {
              const next = event.target.value
              setPersonId(next)
              onPersonIdChange?.(next || undefined)
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
        {/* WEB-66 — between the Student filter and From, listing the real
            surfaces plus an "any" default. */}
        <FormField label="Surface">
          <select
            aria-label="Surface"
            value={surface}
            onChange={(event) =>
              setSurface(event.target.value as typeof surface)
            }
            className={textInputClasses}
          >
            <option value="">Any surface</option>
            {TRANSCRIPT_SURFACES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {surfaceLabel(candidate)}
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

      {error && <ErrorMessage error={error} />}

      {!personId && (
        // ADMIN-1..5 rework, must-fix 1 — an export with no student filter
        // carries every entry in this course; said here, next to the
        // button, rather than left for an instructor to notice only inside
        // the JSON (`pages/Transcripts.tsx`'s own module comment has the
        // full reasoning, unchanged by this extraction).
        <p className="text-xs text-neutral-600">
          This export carries every student in the course. Student ids and names
          are replaced with a pseudonym unique to this file (unstable across two
          exports of the same course) — but the conversation text itself is not
          filtered, and may still name a student.
        </p>
      )}

      {entries === undefined ? (
        error ? null : (
          <div className="flex flex-col gap-2">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <LoadingStatus />
          </div>
        )
      ) : entries.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No messages match these filters.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="transcript-entries">
          {entries.map((entry, index) => (
            <li
              key={index}
              className="flex flex-col gap-1 rounded-md border border-neutral-200 p-3"
            >
              <div className="flex items-center justify-between text-xs text-neutral-500">
                {/* WEB-65 — a student's own name alone, or "Bloombot to
                    `<name>`" for the reply; replaces the former
                    "`<name>` — asked"/"`<name>` — answered" pairing. */}
                <span>
                  {entryHeading(entry)}
                  {entryOrigin(entry) && ` · ${entryOrigin(entry)}`}
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
          <h2 className="text-sm font-semibold text-neutral-900">Exports</h2>
          <ul className="flex flex-col gap-2" data-testid="transcript-exports">
            {exports.map((exportRow) => {
              const stillQueued =
                exportRow.status === 'pending' &&
                Date.now() - exportRow.createdAt > STILL_QUEUED_HINT_AFTER_MS
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
                        <DownloadIcon aria-hidden="true" className="size-4" />
                        Download
                      </a>
                    )}
                  </div>
                  {exportRow.status === 'failed' && exportRow.failureReason && (
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

      {/* ADMIN-2 — withheld entirely for anyone but an owner, not merely rendered empty. */}
      {isOwner && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-neutral-900">Access log</h2>
          {accessLog.length === 0 ? (
            <p className="text-sm text-neutral-500">No reads recorded yet.</p>
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
                    {/* WEB-66 — what the access covered, the same "what
                        it covered" the date columns already carry on this
                        row; omitted, not "any surface," when no filter was
                        applied (`entryOrigin`'s own doc comment above holds
                        the same discipline for an entry's own surface). */}
                    {entry.surface && ` · ${surfaceLabel(entry.surface)}`}
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
    </div>
  )
}
