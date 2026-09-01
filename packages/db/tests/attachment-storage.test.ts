/**
 * FILE-5 — `createFilesystemAttachmentStorage`. Every test uses its own
 * throwaway directory under `tmp/`, never `data/` (QA-2, QA-3).
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createFilesystemAttachmentStorage } from '@bloombot/db'

const TMP_ROOT = join(process.cwd(), 'tmp', 'db-tests', 'attachment-storage')

let rootDir: string

beforeEach(() => {
  rootDir = join(TMP_ROOT, randomUUID())
  mkdirSync(rootDir, { recursive: true })
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('createFilesystemAttachmentStorage', () => {
  it('writes and reads back the same bytes', async () => {
    const storage = createFilesystemAttachmentStorage(rootDir)
    const orgId = randomUUID()
    const attachmentId = randomUUID()
    const bytes = Buffer.from('hello syllabus')

    await storage.write(orgId, attachmentId, bytes)
    const read = await storage.read(orgId, attachmentId)

    expect(read).toEqual(bytes)
  })

  it('read returns undefined for an attachment nothing was ever written for', async () => {
    const storage = createFilesystemAttachmentStorage(rootDir)
    expect(await storage.read(randomUUID(), randomUUID())).toBeUndefined()
  })

  // FILE-3: detaching removes the bytes, not only the database row.
  it('remove deletes the bytes; a later read returns undefined', async () => {
    const storage = createFilesystemAttachmentStorage(rootDir)
    const orgId = randomUUID()
    const attachmentId = randomUUID()
    await storage.write(orgId, attachmentId, Buffer.from('bye'))

    await storage.remove(orgId, attachmentId)

    expect(await storage.read(orgId, attachmentId)).toBeUndefined()
  })

  it('remove is a no-op, not an error, when nothing is there', async () => {
    const storage = createFilesystemAttachmentStorage(rootDir)
    await expect(
      storage.remove(randomUUID(), randomUUID())
    ).resolves.toBeUndefined()
  })

  it("writes an attachment's bytes under its own id, never the instructor's filename — the on-disk name is never read back from anywhere a caller supplies", async () => {
    const storage = createFilesystemAttachmentStorage(rootDir)
    const orgId = randomUUID()
    const attachmentId = randomUUID()
    await storage.write(orgId, attachmentId, Buffer.from('x'))

    const entries = await readdir(join(rootDir, orgId, attachmentId))
    expect(entries).toEqual(['content'])
  })

  // FILE-5 — the concrete case the brief names: a hostile id shaped like a
  // filename cannot escape the storage root.
  it('refuses an attachment id containing "../" — nothing is written outside the storage root', async () => {
    const storage = createFilesystemAttachmentStorage(rootDir)
    const orgId = randomUUID()

    await expect(
      storage.write(orgId, '../../../../etc/passwd', Buffer.from('pwned'))
    ).rejects.toThrow(/not a safe path segment/)

    // Nothing escaped: the storage root's own parent gained nothing new.
    expect(existsSync('/etc/pwned')).toBe(false)
    expect(existsSync(join(rootDir, '..', '..', '..', '..', 'etc'))).toBe(false)
  })

  it('refuses an organizationId containing a path separator the same way', async () => {
    const storage = createFilesystemAttachmentStorage(rootDir)
    await expect(
      storage.write('../escape', randomUUID(), Buffer.from('x'))
    ).rejects.toThrow(/not a safe path segment/)
  })

  it("two organizations' attachments live in separate directories", async () => {
    const storage = createFilesystemAttachmentStorage(rootDir)
    const orgA = randomUUID()
    const orgB = randomUUID()
    const attachmentId = randomUUID()

    await storage.write(orgA, attachmentId, Buffer.from('org a bytes'))

    // Same attachment id, different organization: nothing to read.
    expect(await storage.read(orgB, attachmentId)).toBeUndefined()
    expect(await storage.read(orgA, attachmentId)).toEqual(
      Buffer.from('org a bytes')
    )
  })
})
