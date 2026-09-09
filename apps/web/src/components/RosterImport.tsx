/**
 * WEB-21: the screen a roster import was missing entirely — ROST-9..12
 * already parse an instructor's roster CSV, enrol each row and report what
 * could not be done, and `roster.import` already enqueues that job, but
 * nothing before this component ever offered any of it in the panel: the
 * capability was reachable only by dispatching an action by hand.
 *
 * **The format is stated on screen, not left to documentation an instructor
 * does not have open.** The five columns, which are required and which may
 * be blank, and a worked example row are written out below, matching
 * `packages/schemas/src/roster.ts` — the parser this job actually runs
 * (that file's own module comment is the authority this text is kept in
 * sync with by hand, the same "this app does not import `@bloombot/schemas`'
 * parsing code, only describes it" boundary `RosterImportReport`
 * (`api/types.ts`) already holds for the job's own report shape).
 *
 * **A job, polled the same way `ScaffoldButton.tsx`/`CourseAttachments.tsx`
 * already poll one** — this is the third component in this app to hit the
 * "a queued job with no worker running to claim it must not read as a
 * silent hang" problem, so it reuses the identical `getJobStatus` poll and
 * "still queued" hint rather than inventing a second mechanism.
 *
 * **Every field of `RosterImportReport` is rendered somewhere** — ROST-12's
 * own "an import says what it could not do." Rework finding (must-fix):
 * `ambiguousHandles`, `unresolvedRoles` and `limitations` were declared in
 * `api/types.ts` but never read here, which is not a cosmetic gap —
 * `apps/worker`'s own handler still creates a channel for an ambiguous or
 * unresolved-role row, just without that student's own access grant, so an
 * instructor reading only the counts this component used to show would see
 * an unqualified success on a run that actually left a real student locked
 * out of their own channel. All three now render in the same "name the row
 * or value it concerns" style as `parseErrors`/`unresolvedHandles` above
 * them.
 *
 * **ROST-15's checkbox, checked by default.** A course with a roster larger
 * than what it happens to have scaffolded used to strand every extra
 * student under `channelsNotCreated`, one at a time — this screen now
 * offers to create the student categories a roster needs, on by default
 * (requirement 1), with a base-name field defaulting to `courseTitle`
 * (this component's own new prop) plus `" - STUDENTS"`, editable for a
 * course that names its categories differently. Both travel with every
 * dispatch (`api/client.ts`'s own `importRoster`), never left for the
 * action's own default to fill in silently — see that function's own doc
 * comment.
 */

import { useEffect, useRef, useState } from 'react'

import { ApiError, getJobStatus, importRoster } from '../api/client.js'
import type { JobStatus, RosterImportReport } from '../api/types.js'
import { ImportIcon } from '../icons.js'
import { Button } from './Button.js'
import { ErrorMessage } from './ErrorMessage.js'
import { FileDropZone } from './FileDropZone.js'
import { fileToText } from './file-text.js'
import { FormField } from './FormField.js'

export interface RosterImportProps {
  organizationId: string
  courseId: string
  /** ROST-15: the course's own title — this component's own base-name field defaults to `${courseTitle} - STUDENTS`, CFG-4's own convention. */
  courseTitle: string
  /** Test-only override of `DEFAULT_STILL_QUEUED_HINT_AFTER_MS`. */
  stillQueuedHintAfterMs?: number
  /** Test-only override of `DEFAULT_POLL_INTERVAL_MS`. */
  pollIntervalMs?: number
}

// The same thresholds `ScaffoldButton.tsx`'s own defaults use, and the same
// reasoning: generous enough that an ordinary claim delay never trips it,
// short enough that a genuinely stuck job does not read as a silent hang.
const DEFAULT_STILL_QUEUED_HINT_AFTER_MS = 8_000
const DEFAULT_POLL_INTERVAL_MS = 2_000

/** A roster is small text (this app's own `roster.import` action's module comment) — generous for a large class list, well inside the raised body limit the actions route itself carries (`ACTION_JSON_BODY_LIMIT_BYTES`), and small enough that a truly wrong file (a spreadsheet exported as `.xlsx`, say) is refused here rather than uploaded and only then reported as unparseable. */
const MAX_ROSTER_BYTES = 10 * 1024 * 1024

function isRosterImportReport(value: unknown): value is RosterImportReport {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { parseErrors?: unknown }).parseErrors)
  )
}

export function RosterImport({
  organizationId,
  courseId,
  courseTitle,
  stillQueuedHintAfterMs = DEFAULT_STILL_QUEUED_HINT_AFTER_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: RosterImportProps) {
  const [selectedFile, setSelectedFile] = useState<File | undefined>(undefined)
  const [importing, setImporting] = useState(false)
  const [job, setJob] = useState<JobStatus | undefined>(undefined)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [stillQueued, setStillQueued] = useState(false)
  const pollingSinceRef = useRef<number | undefined>(undefined)
  // ROST-15: requirement 1 — checked by default, and a base name defaulting
  // to the course's own title plus `" - STUDENTS"` (CFG-4's own
  // convention). `useState`'s lazy initializer reads `courseTitle` only
  // once, on mount — an instructor who has already edited the base name
  // field is not overwritten by a later title change elsewhere on the page.
  const [createStudentCategories, setCreateStudentCategories] = useState(true)
  const [studentCategoryBaseName, setStudentCategoryBaseName] = useState(
    () => `${courseTitle} - STUDENTS`
  )

  const settled = job?.status === 'succeeded' || job?.status === 'failed'

  // Poll a running import the same way `ScaffoldButton.tsx` polls a
  // scaffold job — see that component's own module comment for the "still
  // queued" reasoning, reused verbatim here.
  useEffect(() => {
    if (!job || settled) return
    pollingSinceRef.current ??= Date.now()
    const poll = () => {
      getJobStatus(organizationId, job.id).then(
        (status) => {
          setJob(status)
          setStillQueued(
            status.status === 'pending' &&
              Date.now() - (pollingSinceRef.current ?? Date.now()) >
                stillQueuedHintAfterMs
          )
        },
        (caught: unknown) => {
          if (caught instanceof ApiError) setError(caught)
          else throw caught
        }
      )
    }
    const timer = setInterval(poll, pollIntervalMs)
    return () => clearInterval(timer)
  }, [organizationId, job, settled, stillQueuedHintAfterMs, pollIntervalMs])

  useEffect(() => {
    if (settled) {
      pollingSinceRef.current = undefined
      setStillQueued(false)
    }
  }, [settled])

  const chooseFile = (file: File): void => {
    setError(undefined)
    setSelectedFile(file)
  }

  const handleImport = async () => {
    if (!selectedFile) return
    setError(undefined)
    setImporting(true)
    setStillQueued(false)
    try {
      const csvText = await fileToText(selectedFile)
      // Review round 2's "kinder" fix: a base name an instructor cleared
      // (or never touched, if it started blank for some reason) falls back
      // to the same default the field itself displays, rather than
      // dispatching `''` — which `roster.import`'s own input schema
      // rejects outright, as a bare `ActionInputError` with no field-level
      // message the panel could show next to this control.
      // Round 3: the guard is on the *value*, not on the checkbox. The
      // field only renders while the box is ticked, but its state survives
      // unticking — so tick, clear the field, untick, import, and this
      // dispatched `''` anyway, which is exactly the refusal this fallback
      // exists to prevent. The base name is sent on every import
      // regardless of the checkbox, so an empty one is never sendable.
      const effectiveBaseName =
        studentCategoryBaseName.trim().length === 0
          ? `${courseTitle} - STUDENTS`
          : studentCategoryBaseName
      const { jobId } = await importRoster(
        organizationId,
        courseId,
        csvText,
        createStudentCategories,
        effectiveBaseName
      )
      const status = await getJobStatus(organizationId, jobId)
      pollingSinceRef.current = Date.now()
      setJob(status)
      setSelectedFile(undefined)
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setImporting(false)
    }
  }

  const report =
    job?.status === 'succeeded' && isRosterImportReport(job.result)
      ? job.result
      : undefined

  return (
    <div className="flex flex-col gap-3" data-testid="roster-import">
      <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-700">
        <p className="font-medium text-neutral-900">Roster file format</p>
        <p className="mt-1">
          A CSV with exactly these five column headers, spelled and capitalized
          this way:
        </p>
        <p className="mt-1 font-mono text-xs">
          First,Last,Email,Discord,GitHub
        </p>
        <ul className="mt-2 list-disc pl-5">
          <li>
            <strong>Email</strong> and <strong>Discord</strong> are required in
            every row — Discord is a row&apos;s own identity, and Email must
            contain &quot;@&quot; with something before it.
          </li>
          <li>
            <strong>First</strong>, <strong>Last</strong> and{' '}
            <strong>GitHub</strong> may be left blank.
          </li>
        </ul>
        <p className="mt-2">Example row:</p>
        <p className="font-mono text-xs">
          Ada,Lovelace,ada@example.edu,adalovelace,adalovelace-gh
        </p>
      </div>

      <FileDropZone
        label="Roster CSV"
        help="Up to 10 MB — the five columns described above."
        accept=".csv,text/csv"
        maxBytes={MAX_ROSTER_BYTES}
        selectedFile={selectedFile}
        disabled={importing || (job !== undefined && !settled)}
        onFileChosen={chooseFile}
      />

      {/* ROST-15: requirement 1 — offered here, checked by default, with a
          base name field an instructor can override for a course that does
          not follow CFG-4's own `<title> - STUDENTS` convention. */}
      <div className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3">
        <label className="flex items-center gap-2 text-sm text-neutral-800">
          <input
            type="checkbox"
            checked={createStudentCategories}
            disabled={importing || (job !== undefined && !settled)}
            onChange={(event) =>
              setCreateStudentCategories(event.target.checked)
            }
          />
          Create student categories if they don&apos;t exist
        </label>
        {createStudentCategories && (
          <FormField
            label="Base name for new categories"
            help="Created as <base name> 01, <base name> 02, and so on."
          >
            <input
              type="text"
              value={studentCategoryBaseName}
              disabled={importing || (job !== undefined && !settled)}
              onChange={(event) =>
                setStudentCategoryBaseName(event.target.value)
              }
              className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
            />
          </FormField>
        )}
      </div>

      <div>
        <Button
          variant="secondary"
          icon={<ImportIcon aria-hidden="true" className="size-4" />}
          onClick={() => void handleImport()}
          disabled={
            !selectedFile || importing || (job !== undefined && !settled)
          }
        >
          {importing ? 'Starting…' : 'Import roster'}
        </Button>
      </div>

      {job && (
        <p role="status" className="text-sm text-neutral-700">
          {job.status === 'pending' && 'Queued…'}
          {job.status === 'running' && 'Running…'}
          {job.status === 'succeeded' && 'Done.'}
          {job.status === 'failed' && 'Failed.'}
        </p>
      )}
      {job?.status === 'failed' && job.lastError && (
        <p className="text-sm text-danger-700">{job.lastError}</p>
      )}
      {stillQueued && !settled && (
        <p role="status" className="text-sm text-warning-600">
          Still queued — make sure the background worker (
          <code>npm run worker:dev</code>) is running.
        </p>
      )}
      {error && <ErrorMessage error={error} />}

      {report && (
        <div
          className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3 text-sm"
          data-testid="roster-import-report"
        >
          <p className="font-medium text-neutral-900">Import report</p>
          <p className="text-neutral-700">
            {report.peopleCreated.length} added, {report.peopleMerged.length}{' '}
            merged, {report.channelsCreated.length} channels created,{' '}
            {report.channelsAlreadyPresent.length} channels already present.
          </p>

          {report.parseErrors.length > 0 && (
            <div>
              <p className="font-medium text-danger-700">
                Rows that could not be read:
              </p>
              <ul className="list-disc pl-5 text-danger-700">
                {report.parseErrors.map((issue) => (
                  <li key={`${issue.line}-${issue.message}`}>
                    Line {issue.line}: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.unresolvedHandles.length > 0 && (
            <div>
              <p className="font-medium text-warning-700">
                Discord handles not found in the server yet — kept, and joined
                automatically once that student joins:
              </p>
              <ul className="list-disc pl-5 text-neutral-700">
                {report.unresolvedHandles.map((entry) => (
                  <li key={`${entry.line}-${entry.discord}`}>
                    Line {entry.line}: {entry.discord} ({entry.email})
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(report.channelsNotCreated.length > 0 ||
            report.channelsFailed.length > 0) && (
            <div>
              <p className="font-medium text-danger-700">
                Channels that could not be created:
              </p>
              <ul className="list-disc pl-5 text-danger-700">
                {report.channelsNotCreated.map((entry) => (
                  <li key={`not-created-${entry.line}`}>
                    Line {entry.line}: {entry.email} — {entry.reason}
                  </li>
                ))}
                {report.channelsFailed.map((entry) => (
                  <li key={`failed-${entry.line}`}>
                    Line {entry.line}: {entry.email} — {entry.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ROST-14: a disambiguated channel is an ordinary channel this
              run created (or matched), not a failure — rendered in the
              neutral style `unresolvedHandles` above uses, never the danger
              styling `channelsNotCreated`/`channelsFailed` get, so an
              instructor does not read a successfully-created `ada-school`
              as something that went wrong. */}
          {report.channelNameDisambiguated.length > 0 && (
            <div>
              <p className="font-medium text-warning-700">
                Rows whose email shares a name with another address in this
                roster — given a domain-disambiguated channel name instead:
              </p>
              <ul className="list-disc pl-5 text-neutral-700">
                {report.channelNameDisambiguated.map((entry) => (
                  <li key={`disambiguated-${entry.line}`}>
                    Line {entry.line}: {entry.email} → #{entry.channelName}{' '}
                    (shares &quot;{entry.baseChannelName}&quot; with{' '}
                    {entry.sharesSlugWith.join(', ')})
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ROST-16: a name match this run refused because the channel it
              found already belonged to a different student — the student
              still got a channel, under a different name, rather than being
              granted (or silently denied) somebody else's. */}
          {report.channelOwnershipConflicts.length > 0 && (
            <div>
              <p className="font-medium text-warning-700">
                Rows whose matched channel already belonged to a different
                student — given a new channel of their own instead:
              </p>
              <ul className="list-disc pl-5 text-neutral-700">
                {report.channelOwnershipConflicts.map((entry) => (
                  <li key={`ownership-${entry.line}`}>
                    Line {entry.line}: {entry.email} — #
                    {entry.conflictingChannelName} was already somebody
                    else&apos;s, created #{entry.newChannelName} instead
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Round 2's honesty finding: a name is unique, not permanent
              (docs/SPEC.md's own amendment to ROST-14) — a student whose
              name drifted between two imports now has two channels, the
              old one still granting them and left untouched. Not this
              slice's to fix (ROST-17 is), but it must not be silent. */}
          {report.channelsOrphaned.length > 0 && (
            <div>
              <p className="font-medium text-warning-700">
                Rows whose new channel means an older one is now stranded —
                still granting the student, and not deleted or merged:
              </p>
              <ul className="list-disc pl-5 text-neutral-700">
                {report.channelsOrphaned.map((entry) => (
                  <li key={`orphaned-${entry.line}`}>
                    Line {entry.line}: {entry.email} — #
                    {entry.previousChannelName} is stranded; now using #
                    {entry.newChannelName}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Rework finding (must-fix): this run left a row's channel with
              no student overwrite at all — the same real consequence
              `unresolvedHandles` above already reports, just for a handle
              that matched more than one member rather than none. Naming
              which display names it matched is what lets an instructor
              actually correct the roster's own handle. */}
          {report.ambiguousHandles.length > 0 && (
            <div>
              <p className="font-medium text-warning-700">
                Discord handles that matched more than one server member — no
                channel access was granted, to avoid guessing which student:
              </p>
              <ul className="list-disc pl-5 text-neutral-700">
                {report.ambiguousHandles.map((entry) => (
                  <li key={`${entry.line}-${entry.discord}`}>
                    Line {entry.line}: {entry.discord} ({entry.email}) matched{' '}
                    {entry.matchedDisplayNames.join(', ')}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* SRV-10: a role the server lacked is created automatically now,
              never merely reported missing — named here the same way a
              created channel is above, so an instructor can see what the
              run did on their behalf. */}
          {report.rolesCreated.length > 0 && (
            <div>
              <p className="font-medium text-neutral-700">
                Roles created because the server did not have them yet:
              </p>
              <ul className="list-disc pl-5 text-neutral-700">
                {report.rolesCreated.map((role) => (
                  <li key={role}>{role}</li>
                ))}
              </ul>
            </div>
          )}

          {/* SRV-10: this run tried to create the role and Discord refused
              — a real failure (a bot missing the Manage Roles permission,
              say), not "not found," so every channel this run created is
              still missing that role's own access grant. `reason` says why
              the attempt failed, the same as `channelsFailed` above. */}
          {report.unresolvedRoles.length > 0 && (
            <div>
              <p className="font-medium text-warning-700">
                Roles this run tried to create and could not — every channel
                this run created is missing that role&apos;s own access grant:
              </p>
              <ul className="list-disc pl-5 text-neutral-700">
                {report.unresolvedRoles.map((entry) => (
                  <li key={entry.role}>
                    {entry.role} — {entry.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ROST-15: a student category this run created because the
              roster needed more room than already existed — named here the
              same way a created role or channel is above. */}
          {report.categoriesCreated.length > 0 && (
            <div>
              <p className="font-medium text-neutral-700">
                Student categories created because the roster needed more room:
              </p>
              <ul className="list-disc pl-5 text-neutral-700">
                {report.categoriesCreated.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </div>
          )}

          {/* ROST-15: a category this run tried to create and the server
              permanently refused — the students who would have landed in
              it are reported under `channelsNotCreated`/`channelsFailed`
              above, the same as any other full-up run. */}
          {report.categoriesFailed.length > 0 && (
            <div>
              <p className="font-medium text-warning-700">
                Student categories this run tried to create and could not:
              </p>
              <ul className="list-disc pl-5 text-neutral-700">
                {report.categoriesFailed.map((entry) => (
                  <li key={entry.name}>
                    {entry.name} — {entry.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ROST-15, round 2: an adopted category (one this run did not
              just create) whose own permissions did not match what the
              course asks for, and could not be repaired — still used for
              placement (ROST-16's per-channel overwrites hold regardless),
              but named here rather than left silently "as whatever a
              person set by hand." */}
          {report.categoriesPermissionsNotRepaired.length > 0 && (
            <div>
              <p className="font-medium text-warning-700">
                Student categories already in the server whose permissions do
                not match what this course asks for, and could not be repaired:
              </p>
              <ul className="list-disc pl-5 text-neutral-700">
                {report.categoriesPermissionsNotRepaired.map((entry) => (
                  <li key={entry.name}>
                    {entry.name} — {entry.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Rework finding (must-fix): what this run structurally cannot
              do (ROST-6's own pinned welcome message, today) — stated here
              so this screen is the one place an instructor needs to read,
              not `docs/DECISIONS.md`. */}
          {report.limitations.length > 0 && (
            <div>
              <p className="font-medium text-neutral-900">This run does not:</p>
              <ul className="list-disc pl-5 text-neutral-700">
                {report.limitations.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
