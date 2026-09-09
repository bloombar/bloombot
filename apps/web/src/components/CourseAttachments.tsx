/**
 * WEB-18/FILE-1..3, FILE-7: the screen a course's knowledge files were
 * missing entirely — the action layer (`courseAttachments.attach/.list/
 * .detach`), the worker's own upload job and the provider round trip all
 * already existed, but nothing before this component ever offered any of
 * it in the panel; the capability was reachable only by dispatching an
 * action by hand. This lists what a course is grounded in, queues and
 * uploads several files in one pass (FILE-7), shows each file's own FILE-2
 * status (pending, ready or failed, with the provider's own reason), and
 * detaches one with a single click — a product decision, not an oversight:
 * the undo story is that the instructor re-uploads, so this does not ask
 * first the way a destructive action elsewhere in this app might.
 *
 * **Never a vector store id.** The store is this platform's own
 * bookkeeping (`courses.vectorStoreId`) — an instructor uploads a syllabus
 * and removes it, and never learns the concept exists. `CourseAttachmentSummary`
 * (`api/types.ts`) does not even carry one, or the provider's own file id,
 * for exactly this reason — there is nothing here for this component to
 * accidentally render.
 *
 * **Attach is a job — legible, not a black box.** `ScaffoldButton.tsx` is
 * this app's own precedent for "a background job queued with no worker
 * running to claim it must read differently from a hang," and this
 * component follows the same shape: poll, and once something has sat
 * unresolved past a threshold, say so — copy that works for a student on
 * production and a developer on a dev machine alike (FILE-8: the previous
 * copy named `npm run worker:dev` by name, which read as nonsense advice on
 * production, the only place this screen's own stuck-job message could
 * possibly be seen by someone who cannot run it).
 * *What* it polls differs deliberately, though: `ScaffoldButton` tracks one
 * job id it already knows (from the single action it just dispatched) and
 * polls `jobs.get`. A course's knowledge files are a *list*, most of which
 * this component never dispatched anything for — reopening this screen
 * after a reload only ever has the attachment rows themselves, never a job
 * id to resume polling. So this component polls `courseAttachments.list`
 * instead, the same read `FILE-2` already promises is authoritative (that
 * action's own doc comment: "what the panel's own 'knowledge files' screen
 * reads"), and tracks *per row* how long it has been observed pending (or,
 * for a detach, still present) — the same "queued past a threshold" signal
 * `ScaffoldButton` gives, driven by the record a reload cannot lose instead
 * of a job id a reload always would.
 *
 * **Detach is also a job**, and the row it names has no dedicated
 * "detaching" status of its own — `courseAttachments.detach` only ever
 * removes the row once the provider calls it makes have succeeded
 * (`apps/worker`'s own handler). So a confirmed detach is tracked locally
 * (`detachingIds`) until the row actually disappears from the next poll,
 * with the same "still queued" hint if that takes too long — a course must
 * never look like a detach silently did nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ApiError,
  attachCourseFile,
  detachCourseAttachment,
  listCourseAttachments,
} from '../api/client.js'
import type { CourseAttachmentSummary } from '../api/types.js'
import {
  AttachIcon,
  DeleteIcon,
  FailureIcon,
  PendingIcon,
  SuccessIcon,
} from '../icons.js'
import { Button } from './Button.js'
import { ErrorMessage } from './ErrorMessage.js'
import { describeSize, FileDropZone } from './FileDropZone.js'

export interface CourseAttachmentsProps {
  organizationId: string
  courseId: string
  /** Test-only override of `DEFAULT_STILL_QUEUED_HINT_AFTER_MS`. */
  stillQueuedHintAfterMs?: number
  /** Test-only override of `DEFAULT_POLL_INTERVAL_MS`. */
  pollIntervalMs?: number
}

// This file's own module comment on why this component polls
// `courseAttachments.list` rather than a job id — the thresholds
// themselves are `ScaffoldButton.tsx`'s own defaults, unchanged: the same
// "generous enough that an ordinary claim delay never trips it, short
// enough that a genuinely stuck job does not read as a silent hang for
// minutes" reasoning applies to a knowledge-file upload exactly as it does
// to a scaffold job — both are one `apps/worker` job away from running.
const DEFAULT_STILL_QUEUED_HINT_AFTER_MS = 8_000
const DEFAULT_POLL_INTERVAL_MS = 2_000

function statusIcon(status: CourseAttachmentSummary['status']) {
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
        <PendingIcon aria-hidden="true" className="size-4 text-neutral-500" />
      )
  }
}

function statusLabel(status: CourseAttachmentSummary['status']): string {
  switch (status) {
    case 'ready':
      return 'Ready — grounding answers.'
    case 'failed':
      return 'Failed.'
    case 'pending':
      return 'Pending…'
  }
}

/**
 * FILE-7: a course's attachments, all of them added together, may total at
 * most 100 MiB — the authoritative number lives in
 * `packages/actions/src/actions/course-attachments.ts`'s own
 * `MAX_COURSE_ATTACHMENTS_TOTAL_BYTES`, enforced there against every
 * existing row before a new one is written. This app cannot import
 * `@bloombot/actions` (`api/client.ts`'s own module comment on why that
 * package is off-limits to this bundle — it is not even a declared
 * dependency of `apps/web`), so this restates the same 100 MiB by hand
 * rather than silently inventing a second, unrelated magic number: if the
 * server's own budget ever changes, this comment is the pointer back to
 * where the real number lives. This is a courtesy only — refusing here
 * means an instructor learns the limit before waiting for an upload the
 * server was always going to reject, but the server enforces it
 * regardless of anything checked here.
 */
const MAX_COURSE_ATTACHMENTS_TOTAL_BYTES = 100 * 1024 * 1024

/** Bytes rendered in whole MB — the same rounding `packages/actions`'s own `overBudgetMessage` uses server-side, so the client-side courtesy check and the server's real refusal read identically. */
function describeMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024))
}

/** The same wording `createAttachCourseAttachmentAction`'s own server-side refusal uses (`packages/actions/src/actions/course-attachments.ts`) — an instructor should not learn two different sentences for the same rule depending on which side caught it. */
function overBudgetMessage(existingBytes: number): string {
  const totalMb = describeMb(MAX_COURSE_ATTACHMENTS_TOTAL_BYTES)
  const usedMb = describeMb(existingBytes)
  return `That file would put this course over its ${totalMb} MB total. ${usedMb} MB of ${totalMb} MB is already used.`
}

/**
 * A browser `File`'s bytes, base64-encoded — what `courseAttachments.attach`'s
 * own `contentBase64` field wants. `FileReader#readAsDataURL` does the
 * encoding natively rather than this app looping over bytes itself
 * (`String.fromCharCode(...bytes)` on a file anywhere near the 100 MB
 * course budget overflows the call stack a spread that large hits) — only
 * the part after the comma in `data:<mime>;base64,<data>` is the payload
 * `courseAttachments.attach`'s schema wants.
 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('FileReader did not return a data URL'))
        return
      }
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () =>
      reject(reader.error ?? new Error('could not read the selected file'))
    reader.readAsDataURL(file)
  })
}

export function CourseAttachments({
  organizationId,
  courseId,
  stillQueuedHintAfterMs = DEFAULT_STILL_QUEUED_HINT_AFTER_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: CourseAttachmentsProps) {
  const [attachments, setAttachments] = useState<
    CourseAttachmentSummary[] | undefined
  >(undefined)
  const [loadError, setLoadError] = useState<ApiError | undefined>(undefined)
  // FILE-7: a queue, not a single `File` — choosing (or dropping) several
  // files at once, or in two passes, appends to this rather than replacing
  // it, and "Attach N files" sends the whole queue in one action per file.
  const [queuedFiles, setQueuedFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  // FILE-7: how far a sequential upload has gotten, for the button's own
  // "Uploading 2 of 5…" — `undefined` while nothing is uploading.
  const [uploadProgress, setUploadProgress] = useState<
    { current: number; total: number } | undefined
  >(undefined)
  const [uploadError, setUploadError] = useState<ApiError | undefined>(
    undefined
  )
  // Attachments a confirmed detach has been dispatched for, but whose row
  // has not yet actually disappeared from a poll (this file's own module
  // comment on why detach has no status of its own to read instead).
  const [detachingIds, setDetachingIds] = useState<Set<string>>(new Set())
  const [detachError, setDetachError] = useState<ApiError | undefined>(
    undefined
  )
  const [stillQueuedIds, setStillQueuedIds] = useState<Set<string>>(new Set())

  // First-observed-active time per attachment id ("active" = pending, or a
  // detach still awaiting its row's removal) — the same bookkeeping
  // `ScaffoldButton.tsx`'s own `pollingSinceRef` keeps for its one job, one
  // entry per row here instead of one for the whole component.
  const observedSinceRef = useRef<Map<string, number>>(new Map())

  const refresh = useCallback(
    () =>
      listCourseAttachments(organizationId, courseId).then(
        (list) => {
          setAttachments(list)
          setLoadError(undefined)
          // A detach whose row is now actually gone has nothing left to
          // track — reconciled here, the one place both the polling loop
          // and a fresh mount already call through.
          setDetachingIds(
            (current) =>
              new Set(
                [...current].filter((id) => list.some((a) => a.id === id))
              )
          )
          return list
        },
        (caught: unknown) => {
          if (caught instanceof ApiError) setLoadError(caught)
          else throw caught
          return undefined
        }
      ),
    [organizationId, courseId]
  )

  // Initial load, and whenever the course itself changes.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // Poll while anything is still active (a `pending` attachment, or a
  // detach not yet reflected as gone) — see this file's own module comment
  // for why this polls the list rather than a job id, and for the "still
  // queued" hint this drives, the same copy `ScaffoldButton.tsx` uses.
  useEffect(() => {
    const pendingIds = (attachments ?? [])
      .filter((a) => a.status === 'pending')
      .map((a) => a.id)
    const activeIds = new Set([...pendingIds, ...detachingIds])
    if (activeIds.size === 0) {
      observedSinceRef.current.clear()
      if (stillQueuedIds.size > 0) setStillQueuedIds(new Set())
      return
    }

    const timer = setInterval(() => {
      void refresh().then((list) => {
        if (!list) return
        const nowActive = new Set([
          ...list.filter((a) => a.status === 'pending').map((a) => a.id),
          ...[...detachingIds].filter((id) => list.some((a) => a.id === id)),
        ])
        const now = Date.now()
        const nextStillQueued = new Set<string>()
        for (const id of nowActive) {
          const since = observedSinceRef.current.get(id) ?? now
          observedSinceRef.current.set(id, since)
          if (now - since > stillQueuedHintAfterMs) nextStillQueued.add(id)
        }
        for (const id of observedSinceRef.current.keys()) {
          if (!nowActive.has(id)) observedSinceRef.current.delete(id)
        }
        setStillQueuedIds(nextStillQueued)
      })
    }, pollIntervalMs)
    return () => clearInterval(timer)
    // `stillQueuedIds` itself is deliberately not a dependency — it is only
    // ever written by this effect, never read to decide whether to
    // re-create the interval (this file's own `useEffect(..., [])` re-runs
    // are driven by `attachments`/`detachingIds` changing, which is exactly
    // "the set of active ids may have changed").
  }, [
    attachments,
    detachingIds,
    pollIntervalMs,
    stillQueuedHintAfterMs,
    refresh,
  ])

  // The drop zone owns the picker and its reset, so choosing files is just
  // state here — clearing the last upload's error is the only extra step.
  // FILE-7: appends rather than replaces, deduplicated by name+size — an
  // instructor picking readings in two passes is the normal case, and
  // choosing the same file twice by mistake should not queue it twice.
  const chooseFiles = (files: File[]): void => {
    setUploadError(undefined)
    setQueuedFiles((current) => {
      const next = [...current]
      for (const file of files) {
        const alreadyQueued = next.some(
          (queued) => queued.name === file.name && queued.size === file.size
        )
        if (!alreadyQueued) next.push(file)
      }
      return next
    })
  }

  const removeFromQueue = (file: File): void => {
    setQueuedFiles((current) => current.filter((queued) => queued !== file))
  }

  const handleUpload = async () => {
    if (queuedFiles.length === 0) return
    setUploadError(undefined)

    // FILE-7 — a client-side courtesy, not the gate: sum what is already
    // listed plus what this queue would add, and refuse with the same
    // wording `createAttachCourseAttachmentAction`'s own server-side check
    // would use — an instructor learns the limit before waiting on an
    // upload the server was always going to reject. The server checks
    // again regardless, against the real, current total, since this read
    // can be stale the moment another upload elsewhere completes first.
    const alreadyUsedBytes = (attachments ?? []).reduce(
      (total, attachment) => total + attachment.sizeBytes,
      0
    )
    const queuedBytes = queuedFiles.reduce(
      (total, file) => total + file.size,
      0
    )
    if (alreadyUsedBytes + queuedBytes > MAX_COURSE_ATTACHMENTS_TOTAL_BYTES) {
      setUploadError(
        new ApiError(409, {
          error: 'action_conflict',
          conflict: { message: overBudgetMessage(alreadyUsedBytes) },
        })
      )
      return
    }

    setUploading(true)
    try {
      // FILE-7 — one `attachCourseFile` at a time, never in parallel: each
      // carries up to 100 MB of base64, and a handful of those in flight at
      // once would be a real memory and bandwidth spike for no benefit an
      // instructor would notice. A failure stops the loop where it is —
      // the files already sent stay sent (removed from the queue as each
      // one succeeds), and the ones after the failure are left queued so
      // the instructor can retry without re-choosing them.
      let index = 0
      for (const file of queuedFiles) {
        index += 1
        setUploadProgress({ current: index, total: queuedFiles.length })
        const contentBase64 = await fileToBase64(file)
        await attachCourseFile(organizationId, courseId, {
          filename: file.name,
          // A file this browser could not classify (an empty `File.type`,
          // some OS/extension combinations) still has to satisfy
          // `courseAttachments.attach`'s own `contentType: z.string().min(1)`
          // — the provider gets to decide whether it can use it, not this
          // form.
          contentType: file.type || 'application/octet-stream',
          contentBase64,
        })
        setQueuedFiles((current) => current.filter((f) => f !== file))
      }
    } catch (caught) {
      if (caught instanceof ApiError) setUploadError(caught)
      else throw caught
    } finally {
      setUploadProgress(undefined)
      setUploading(false)
      // Whatever got through before a failure (or all of it, on success)
      // is already uploaded — refresh so the list reflects it immediately
      // rather than waiting for the next poll.
      await refresh()
    }
  }

  const handleDetach = async (attachment: CourseAttachmentSummary) => {
    setDetachError(undefined)
    // FILE-7: one click, no confirmation — a product decision, not an
    // oversight. The undo story is that the instructor re-uploads.
    setDetachingIds((current) => new Set(current).add(attachment.id))
    try {
      await detachCourseAttachment(organizationId, attachment.id)
      // Left in `detachingIds` deliberately — the polling effect above
      // reconciles it once the row is actually gone (this file's own
      // module comment on why detach has no status of its own to read).
    } catch (caught) {
      // The dispatch itself was refused (a stale id, a race) — nothing was
      // queued, so nothing to keep tracking.
      setDetachingIds((current) => {
        const next = new Set(current)
        next.delete(attachment.id)
        return next
      })
      if (caught instanceof ApiError) setDetachError(caught)
      else throw caught
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="course-attachments">
      {loadError && <ErrorMessage error={loadError} />}

      {attachments && attachments.length === 0 && (
        <p className="text-sm text-neutral-500">No files attached yet.</p>
      )}

      {attachments && attachments.length > 0 && (
        <ul className="flex flex-col gap-2">
          {attachments.map((attachment) => {
            const detaching = detachingIds.has(attachment.id)
            const stillQueued = stillQueuedIds.has(attachment.id)
            return (
              <li
                key={attachment.id}
                className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 p-3"
              >
                <div className="flex min-w-0 items-start gap-2">
                  {statusIcon(attachment.status)}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-neutral-900">
                      {attachment.filename}
                    </p>
                    <p role="status" className="text-sm text-neutral-500">
                      {detaching ? 'Removing…' : statusLabel(attachment.status)}
                    </p>
                    {attachment.status === 'failed' &&
                      attachment.failureReason && (
                        <p className="text-sm text-danger-700">
                          {attachment.failureReason}
                        </p>
                      )}
                    {stillQueued && (
                      // FILE-8 — this used to name `npm run worker:dev`,
                      // dev-only advice that is the only thing this screen
                      // says on production when a job is stuck there too.
                      // This copy works for both audiences: it says what is
                      // true either way (the file is still being processed,
                      // and it is taking longer than expected) without
                      // assuming a dev machine.
                      <p role="status" className="text-sm text-warning-600">
                        Still processing — this is taking longer than expected.
                      </p>
                    )}
                  </div>
                </div>
                {/* FILE-7: icon-only, no confirmation — one click detaches.
                    `aria-label` still names the file, so screen readers (and
                    this file's own tests) find it exactly as they did when
                    the button also carried visible text. */}
                <Button
                  variant="ghost"
                  aria-label={`Detach ${attachment.filename}`}
                  icon={<DeleteIcon aria-hidden="true" className="size-4" />}
                  onClick={() => void handleDetach(attachment)}
                  disabled={detaching}
                />
              </li>
            )
          })}
        </ul>
      )}

      {detachError && <ErrorMessage error={detachError} />}

      <div className="flex flex-col gap-2">
        <FileDropZone
          label="Course files"
          help={`Up to ${describeMb(MAX_COURSE_ATTACHMENTS_TOTAL_BYTES)} MB total for this course — ${describeMb(
            Math.max(
              0,
              MAX_COURSE_ATTACHMENTS_TOTAL_BYTES -
                (attachments ?? []).reduce(
                  (total, attachment) => total + attachment.sizeBytes,
                  0
                ) -
                queuedFiles.reduce((total, file) => total + file.size, 0)
            )
          )} MB left. Notes, syllabus, schedule — choose or drop several at once.`}
          multiple
          disabled={uploading}
          onFilesChosen={chooseFiles}
        />

        {queuedFiles.length > 0 && (
          <ul className="flex flex-col gap-1">
            {queuedFiles.map((file) => (
              <li
                key={`${file.name}-${file.size}`}
                className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 px-3 py-1.5 text-sm"
              >
                <span className="min-w-0 truncate">
                  {file.name}{' '}
                  {/* FILE-7 rework finding — `describeSize` (`FileDropZone.js`),
                      not the whole-MB `describeMb` the budget sentence
                      below uses: a sub-megabyte file (most syllabi, most
                      schedules) would otherwise round to "0 MB" here. */}
                  <span className="text-neutral-500">
                    ({describeSize(file.size)})
                  </span>
                </span>
                <Button
                  variant="ghost"
                  aria-label={`Remove ${file.name} from the queue`}
                  icon={<DeleteIcon aria-hidden="true" className="size-4" />}
                  onClick={() => removeFromQueue(file)}
                  disabled={uploading}
                />
              </li>
            ))}
          </ul>
        )}

        <Button
          variant="secondary"
          icon={<AttachIcon aria-hidden="true" className="size-4" />}
          onClick={() => void handleUpload()}
          disabled={queuedFiles.length === 0 || uploading}
        >
          {uploadProgress
            ? `Uploading ${uploadProgress.current} of ${uploadProgress.total}…`
            : queuedFiles.length === 1
              ? 'Attach 1 file'
              : `Attach ${queuedFiles.length} files`}
        </Button>
      </div>
      {uploadError && <ErrorMessage error={uploadError} />}
    </div>
  )
}
