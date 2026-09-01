/**
 * Actions over `packages/db`'s `course-attachments` repo (FILE-1..3, FILE-5).
 *
 * `courseAttachments.attach` is the one action in this package built by a
 * factory (`createAttachCourseAttachmentAction`) rather than exported as a
 * plain object: every other action's `execute` reaches only the database
 * (`ExecuteContext.db`), but this one also has to write the uploaded bytes
 * to disk before the job that uploads them to the provider can run — FILE-5's
 * own storage (`@bloombot/db`'s `AttachmentStorage`), which this package
 * has no way to construct for itself without reaching for `CONFIG` (the same
 * "dependencies as arguments, only the process reads `CONFIG`" discipline
 * `docs/DECISIONS.md` already holds `packages/core` to). `createPlatformRegistry`
 * (`actions/index.ts`) is the one place that builds a real
 * `AttachmentStorage` and passes it in — a test builds its own, pointed at
 * `tmp/`.
 *
 * **Bytes, not a file reference, and written here rather than deferred to
 * the job** — the opposite tradeoff `roster.import`'s own module comment
 * makes for a CSV, and deliberately so: a roster is small text, cheap to
 * carry inline in a job's own opaque `payload` (`repos/jobs.ts`'s "opaque
 * JSON" discipline); a course attachment is unbounded binary content an
 * instructor's browser uploads, and leaving it sitting base64-encoded in
 * the `jobs` table forever (`JOB-2`'s "a job that fails... stays visible" —
 * nothing in this platform ever deletes a job row) is exactly what FILE-5
 * exists to avoid: bytes belong in `AttachmentStorage`, addressed by an
 * unguessable id, not in a table anyone with `jobs.get` access can read
 * back as raw JSON. Writing them to disk is a local filesystem operation,
 * not the network call `JOB-1` exists to defer — so it happens here, in the
 * action itself, and the job this action enqueues carries only the
 * attachment's own id.
 */

import {
  courseAttachments,
  courses,
  jobs,
  type AttachmentStorage,
} from '@bloombot/db'
import { z } from 'zod'

import type { Action } from '../types.js'

type Course = NonNullable<ReturnType<typeof courses.getCourse>>
type Attachment = NonNullable<
  ReturnType<typeof courseAttachments.getAttachment>
>

// The job kinds `apps/worker`'s `handlers/course-attachments.ts` registers
// its two handlers under (that file's own constants) — literal strings
// here too, the same cross-referenced-by-comment convention
// `DISCORD_SCAFFOLD_JOB_KIND`/`ROSTER_IMPORT_JOB_KIND` already use: an app
// does not import from another app, and this package does not depend on
// `apps/worker`.
const ATTACH_JOB_KIND = 'courseAttachments.attach'
const DETACH_JOB_KIND = 'courseAttachments.detach'

// JOB-2's bound on attempts — the same reasoning every other job-enqueuing
// action's own constant gives (`discordServers.scaffold`'s own
// `SCAFFOLD_MAX_ATTEMPTS`): room for a transient provider failure to clear
// on retry, without a stuck job lingering indefinitely.
const ATTACHMENT_JOB_MAX_ATTEMPTS = 5

const attachInputSchema = z.object({
  courseId: z.string().min(1),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  /**
   * The file's own bytes, base64-encoded (this file's own module comment on
   * why a reference, not a job payload, is not the shape either — a browser
   * upload has nowhere else to land it inline in a JSON action call).
   * `z.base64()`, not a bare `z.string()` (a rework finding): `Buffer.from`
   * (this file's own `execute`, below) silently *truncates* malformed
   * base64 at the first character it cannot decode rather than throwing —
   * an unvalidated field let a malformed value through ACT-4's own
   * "validate" step to land as a corrupt, silently-shortened file on disk
   * instead of the bad input it actually was.
   */
  contentBase64: z.base64().min(1),
})
type AttachInput = z.infer<typeof attachInputSchema>

/**
 * FILE-1: attach a file to a course. Resolves the course (scoped to the
 * caller's organization, ACT-2), writes the decoded bytes to
 * `AttachmentStorage` under a freshly minted attachment id, records a
 * `pending` row, and enqueues a `courseAttachments.attach` job naming it —
 * the provider upload and the vector-store attach are `apps/worker`'s own
 * handler's concern once it claims the row, not this action's, the same
 * division `discordServers.scaffold`/`roster.import` already hold
 * themselves to.
 */
export function createAttachCourseAttachmentAction(
  attachmentStorage: AttachmentStorage
): Action<
  'courseAttachments.attach',
  AttachInput,
  Course,
  { attachmentId: string; jobId: string }
> {
  return {
    name: 'courseAttachments.attach',
    description:
      "Attach a file to a course's knowledge base (FILE-1): stores the bytes and enqueues the provider upload as a background job — this action does not itself reach the provider.",
    inputSchema: attachInputSchema,
    policy: {
      descriptor: { resource: 'course', access: 'write' },
      resolve: (input, context) =>
        courses.getCourse(context.organizationId, input.courseId, context.db),
    },
    execute: async ({ organizationId, input, entity, db }) => {
      const bytes = Buffer.from(input.contentBase64, 'base64')
      const attachmentId = crypto.randomUUID()

      // FILE-5 — the bytes land under this attachment's own id before the
      // row naming it exists at all, so there is never a moment where a
      // `pending` row points at nothing on disk.
      await attachmentStorage.write(organizationId, attachmentId, bytes)

      const attachment = courseAttachments.createPendingAttachment(
        organizationId,
        {
          id: attachmentId,
          courseId: entity.id,
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: bytes.byteLength,
        },
        db
      )

      const job = jobs.enqueueJob(
        organizationId,
        {
          kind: ATTACH_JOB_KIND,
          payload: { attachmentId: attachment.id },
          maxAttempts: ATTACHMENT_JOB_MAX_ATTEMPTS,
        },
        db
      )
      return { attachmentId: attachment.id, jobId: job.id }
    },
  }
}

const listInputSchema = z.object({
  courseId: z.string().min(1),
})
type ListInput = z.infer<typeof listInputSchema>

/** FILE-2: list a course's attachments, with their status — what the panel's own "knowledge files" screen reads. */
export const listCourseAttachmentsAction: Action<
  'courseAttachments.list',
  ListInput,
  Course,
  courseAttachments.CourseAttachment[]
> = {
  name: 'courseAttachments.list',
  description:
    "List a course's knowledge-file attachments (FILE-1, FILE-2), each with its own status: pending, ready, or failed (with the provider's own reason).",
  inputSchema: listInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'read' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, entity, db }) =>
    courseAttachments.listAttachmentsForCourse(organizationId, entity.id, db),
}

const detachInputSchema = z.object({
  attachmentId: z.string().min(1),
})
type DetachInput = z.infer<typeof detachInputSchema>

/**
 * FILE-3: detach a file. Resolves the attachment itself (scoped to the
 * caller's organization, ACT-2 — FILE-5's own "reachable only through it")
 * and enqueues a `courseAttachments.detach` job naming it — reaching the
 * provider (removing the file from its vector store, then deleting the
 * file object itself) and removing the local bytes and row are
 * `apps/worker`'s own handler's concern once it claims the row, the same
 * division every other job-backed action in this package holds itself to.
 */
export const detachCourseAttachmentAction: Action<
  'courseAttachments.detach',
  DetachInput,
  Attachment,
  { jobId: string }
> = {
  name: 'courseAttachments.detach',
  description:
    'Detach a knowledge-file attachment (FILE-3): enqueues removal from the provider and the local record as a background job — this action does not itself reach the provider.',
  inputSchema: detachInputSchema,
  policy: {
    descriptor: { resource: 'courseAttachment', access: 'write' },
    resolve: (input, context) =>
      courseAttachments.getAttachment(
        context.organizationId,
        input.attachmentId,
        context.db
      ),
  },
  execute: ({ organizationId, entity, db }) => {
    const job = jobs.enqueueJob(
      organizationId,
      {
        kind: DETACH_JOB_KIND,
        payload: { attachmentId: entity.id },
        maxAttempts: ATTACHMENT_JOB_MAX_ATTEMPTS,
      },
      db
    )
    return { jobId: job.id }
  },
}
