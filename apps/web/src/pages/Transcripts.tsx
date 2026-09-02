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
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ApiError,
  exportTranscript,
  listCourses,
  listProjects,
  listTranscriptExports,
  listTranscriptStudents,
  readTranscript,
  transcriptExportDownloadUrl,
  type TranscriptFilters,
} from '../api/client.js'
import type {
  CourseSummary,
  Project,
  TranscriptEntry,
  TranscriptExport,
  TranscriptStudent,
} from '../api/types.js'
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

export function Transcripts({ organizationId }: TranscriptsScreenProps) {
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
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)

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

  useEffect(() => {
    setCourses(undefined)
    setCourseId('')
    if (!projectId) return
    listCourses(organizationId, projectId).then(
      (result) => setCourses(result.filter((course) => course.enabled)),
      (caught: unknown) => {
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [organizationId, projectId])

  useEffect(() => {
    setEntries(undefined)
    setStudents([])
    setPersonId('')
    if (!courseId) return
    listTranscriptStudents(organizationId, courseId).then(
      (result) => setStudents(result),
      (caught: unknown) => {
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [organizationId, courseId])

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
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setLoading(false)
    }
  }, [organizationId, courseId, currentFilters])

  // Deliberately keyed on `organizationId`/`courseId` alone, not on
  // `runSearch` (which itself closes over the current filters): a filter
  // change applies when the instructor presses "Apply filters" below, not
  // on every keystroke — ADMIN-2 audits every read, so this screen must
  // not fire one per character typed into a date field.
  useEffect(() => {
    if (courseId) void runSearch()
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
            onChange={(event) => setProjectId(event.target.value)}
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
            onChange={(event) => setCourseId(event.target.value)}
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
                onChange={(event) => setPersonId(event.target.value)}
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
                {exports.map((exportRow) => (
                  <li
                    key={exportRow.id}
                    className="flex items-center justify-between rounded-md border border-neutral-200 p-3 text-sm"
                  >
                    <span className="flex items-center gap-2 text-neutral-700">
                      {exportRow.status === 'ready' && (
                        <SuccessIcon
                          aria-hidden="true"
                          className="size-4 text-success-600"
                        />
                      )}
                      {exportRow.status === 'failed' && (
                        <FailureIcon
                          aria-hidden="true"
                          className="size-4 text-danger-600"
                        />
                      )}
                      {exportRow.status === 'pending' && (
                        <PendingIcon
                          aria-hidden="true"
                          className="size-4 text-neutral-400"
                        />
                      )}
                      {new Date(exportRow.createdAt).toLocaleString()}
                      {exportRow.status === 'failed' &&
                        exportRow.failureReason &&
                        ` — ${exportRow.failureReason}`}
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
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  )
}
