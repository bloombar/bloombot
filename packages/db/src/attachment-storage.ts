/**
 * FILE-5 — where a course attachment's own bytes live on disk, and what
 * stops anyone who guesses (or is handed) an id from reading, overwriting or
 * traversing outside them.
 *
 * The layout is `<rootDir>/<organizationId>/<attachmentId>/content`.
 * `organizationId` and `attachmentId` are both application-generated UUIDs
 * (`crypto.randomUUID()`, `repos/course-attachments.ts` — the same
 * convention every other id in this platform already follows, this
 * package's own module comment on `schema.ts`), so a directory listing
 * gives an attacker nothing to enumerate from, and reaching one at all
 * requires already knowing its id — which itself requires organization-
 * scoped access to the row that names it (`repos/course-attachments.ts`,
 * TEN-2). The instructor's own filename is never part of the path at all —
 * it lives only as a display column (`schema.ts`'s `courseAttachments.filename`)
 * — so a filename like `../../etc/passwd` has nowhere to act: the on-disk
 * name is always the literal `content`, regardless of what a browser upload
 * called the file.
 *
 * `safeSegment` below still refuses a non-UUID-shaped `organizationId` or
 * `attachmentId` outright, and every resolved path is checked to still
 * fall inside `rootDir` before use — belt and braces against a future
 * caller that reaches this module with something other than a value it
 * generated itself, not a defense this implementation expects to trip in
 * ordinary operation.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { CONFIG } from '@bloombot/config'

/** The one filename ever written under an attachment's own directory — never the instructor's. */
const CONTENT_FILENAME = 'content'

/**
 * Refuses anything but a plain, single path segment: no `/`, no `\`, no
 * `..`, no leading `.`. `organizationId`/`attachmentId` are always
 * `crypto.randomUUID()` output in practice, so this never legitimately
 * rejects a real caller — it exists to fail loudly, rather than silently
 * traverse, if either is ever something this platform did not generate
 * itself.
 */
function safeSegment(label: string, value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(
      `@bloombot/db attachment-storage: ${label} "${value}" is not a safe path segment`
    )
  }
  return value
}

/** Where a course attachment's bytes are written, read and removed (FILE-1, FILE-3, FILE-5). */
export interface AttachmentStorage {
  /** Writes `bytes` for one attachment, creating its directory if needed. A second write under the same id overwrites the first — idempotent, so a retried upload never leaves a partial file behind it. */
  write(
    organizationId: string,
    attachmentId: string,
    bytes: Uint8Array
  ): Promise<void>
  /** Reads an attachment's bytes back — what `apps/worker`'s handler hands the provider on upload (FILE-1). `undefined` when nothing was ever written, or it has already been removed. */
  read(
    organizationId: string,
    attachmentId: string
  ): Promise<Buffer | undefined>
  /** Deletes an attachment's directory and everything in it (FILE-3: detaching removes the bytes, not only the database row). A no-op, not an error, when there is nothing there. */
  remove(organizationId: string, attachmentId: string): Promise<void>
}

/**
 * A filesystem-backed `AttachmentStorage`, rooted at `rootDir` (defaults to
 * `CONFIG.ATTACHMENT_STORAGE_DIR`, the same "explicit parameter, `CONFIG`
 * default" shape `openDatabase` (`client.ts`) already uses for
 * `DATABASE_PATH` — a test passes its own `tmp/` directory; a process reads
 * the real one once, at startup).
 */
export function createFilesystemAttachmentStorage(
  rootDir: string = CONFIG.ATTACHMENT_STORAGE_DIR
): AttachmentStorage {
  const resolvedRoot = resolve(rootDir)

  /**
   * The directory one attachment's bytes live in, `safeSegment`-checked and
   * then re-checked to still resolve inside `resolvedRoot` (this file's own
   * module comment) before any caller reads, writes or deletes through it.
   */
  function attachmentDir(organizationId: string, attachmentId: string): string {
    const dir = join(
      resolvedRoot,
      safeSegment('organizationId', organizationId),
      safeSegment('attachmentId', attachmentId)
    )
    if (dir !== resolvedRoot && !dir.startsWith(resolvedRoot + sep)) {
      throw new Error(
        `@bloombot/db attachment-storage: refusing a path outside the storage root: ${dir}`
      )
    }
    return dir
  }

  return {
    async write(organizationId, attachmentId, bytes) {
      const dir = attachmentDir(organizationId, attachmentId)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, CONTENT_FILENAME), bytes)
    },
    async read(organizationId, attachmentId) {
      const dir = attachmentDir(organizationId, attachmentId)
      try {
        return await readFile(join(dir, CONTENT_FILENAME))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined
        }
        throw error
      }
    },
    async remove(organizationId, attachmentId) {
      const dir = attachmentDir(organizationId, attachmentId)
      await rm(dir, { recursive: true, force: true })
    },
  }
}
