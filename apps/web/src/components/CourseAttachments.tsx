/**
 * WEB-18/FILE-1..3: the screen a course's knowledge files were missing
 * entirely — the action layer (`courseAttachments.attach/.list/.detach`),
 * the worker's own upload job and the provider round trip all already
 * existed, but nothing before this component ever offered any of it in the
 * panel; the capability was reachable only by dispatching an action by
 * hand. This lists what a course is grounded in, takes an upload, shows
 * each file's own FILE-2 status (pending, ready or failed, with the
 * provider's own reason), and detaches one behind a confirmation — FILE-3's
 * removal reaches the provider and cannot be undone.
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
 * unresolved past a threshold, say so by name (`npm run worker:dev`).
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
import { FileDropZone } from './FileDropZone.js'
import { useModal } from './modal/ModalProvider.js'

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
 * The largest file this screen will send.
 *
 * The server's own ceiling is `ACTION_JSON_BODY_LIMIT_BYTES` (28 MB), which is
 * a *base64* budget — encoding inflates by about a third, so 20 MB of file is
 * roughly 27 MB on the wire and the two numbers agree rather than one being a
 * rounder version of the other. Refusing here means an instructor learns the
 * limit before waiting for an upload the server was always going to reject.
 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * A browser `File`'s bytes, base64-encoded — what `courseAttachments.attach`'s
 * own `contentBase64` field wants. `FileReader#readAsDataURL` does the
 * encoding natively rather than this app looping over bytes itself
 * (`String.fromCharCode(...bytes)` on a file anywhere near FILE-1's own
 * 20 MB ceiling overflows the call stack a spread that large hits) — only
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
  const [selectedFile, setSelectedFile] = useState<File | undefined>(undefined)
  const [uploading, setUploading] = useState(false)
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
  const { confirm } = useModal()

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

  // The drop zone owns the picker and its reset, so choosing a file is just
  // state here — clearing the last upload's error is the only extra step.
  const chooseFile = (file: File): void => {
    setUploadError(undefined)
    setSelectedFile(file)
  }

  const handleUpload = async () => {
    if (!selectedFile) return
    setUploadError(undefined)
    setUploading(true)
    try {
      const contentBase64 = await fileToBase64(selectedFile)
      await attachCourseFile(organizationId, courseId, {
        filename: selectedFile.name,
        // A file this browser could not classify (an empty `File.type`,
        // some OS/extension combinations) still has to satisfy
        // `courseAttachments.attach`'s own `contentType: z.string().min(1)`
        // — the provider gets to decide whether it can use it, not this
        // form.
        contentType: selectedFile.type || 'application/octet-stream',
        contentBase64,
      })
      setSelectedFile(undefined)
      await refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setUploadError(caught)
      else throw caught
    } finally {
      setUploading(false)
    }
  }

  const handleDetach = async (attachment: CourseAttachmentSummary) => {
    setDetachError(undefined)
    // FILE-3/WEB-18: detaching reaches the provider and cannot be undone —
    // the existing modal primitive, not a bespoke dialog (WEB-15).
    const confirmed = await confirm({
      title: `Detach "${attachment.filename}"?`,
      description:
        'This removes it from what the course is grounded in and reaches the provider to delete it — it cannot be undone.',
      confirmLabel: 'Detach',
      destructive: true,
    })
    if (!confirmed) return

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
                      <p role="status" className="text-sm text-warning-600">
                        Still queued — make sure the background worker (
                        <code>npm run worker:dev</code>) is running.
                      </p>
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  aria-label={`Detach ${attachment.filename}`}
                  icon={<DeleteIcon aria-hidden="true" className="size-4" />}
                  onClick={() => void handleDetach(attachment)}
                  disabled={detaching}
                >
                  Detach
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      {detachError && <ErrorMessage error={detachError} />}

      <div className="flex flex-col gap-2">
        <FileDropZone
          label="Course file"
          help="Up to 20 MB — notes, syllabus or schedule."
          maxBytes={MAX_ATTACHMENT_BYTES}
          selectedFile={selectedFile}
          disabled={uploading}
          onFileChosen={chooseFile}
        />
        <Button
          variant="secondary"
          icon={<AttachIcon aria-hidden="true" className="size-4" />}
          onClick={() => void handleUpload()}
          disabled={!selectedFile || uploading}
        >
          {uploading ? 'Uploading…' : 'Attach file'}
        </Button>
      </div>
      {uploadError && <ErrorMessage error={uploadError} />}
    </div>
  )
}
