/**
 * `files.ts` (FILE-1..3) — upload, vector-store creation and attach, and
 * the two deletes a detach reaches — against the in-process fake, never a
 * real network call (MDL-7).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  attachFileToVectorStore,
  createVectorStore,
  deleteFile,
  deleteVectorStoreFile,
  uploadFile,
  type FilesHttpOptions,
} from '../src/files.js'
import { ModelRequestError } from '../src/errors.js'
import { FakeOpenAiServer } from './helpers/fake-openai-server.js'

describe('files.ts (FILE-1..3)', () => {
  let server: FakeOpenAiServer
  let options: FilesHttpOptions

  beforeEach(async () => {
    server = await FakeOpenAiServer.start()
    options = {
      fetchFn: fetch,
      baseUrl: server.baseUrl,
      apiKey: 'test-key',
      timeoutMs: 2000,
    }
  })

  afterEach(async () => {
    await server.stop()
  })

  describe('uploadFile', () => {
    it('sends the bytes and filename as multipart/form-data, purpose "assistants", and returns the id the provider assigned', async () => {
      server.respondToFiles({ status: 200, body: { id: 'file_abc123' } })

      const id = await uploadFile(options, {
        filename: 'syllabus.pdf',
        contentType: 'application/pdf',
        bytes: Buffer.from('%PDF-1.4 fake bytes'),
      })

      expect(id).toBe('file_abc123')
      expect(server.requests).toHaveLength(1)
      const [request] = server.requests
      expect(request?.path).toBe('/files')
      expect(request?.file?.filename).toBe('syllabus.pdf')
      expect(request?.file?.purpose).toBe('assistants')
      expect(request?.file?.content.toString('utf8')).toBe(
        '%PDF-1.4 fake bytes'
      )
    })

    it('classifies a non-2xx response the same way every other call in this package does', async () => {
      server.respondToFiles({
        status: 400,
        body: { error: { message: 'file too large' } },
      })

      await expect(
        uploadFile(options, {
          filename: 'huge.pdf',
          contentType: 'application/pdf',
          bytes: Buffer.from('x'),
        })
      ).rejects.toMatchObject({
        kind: 'client_error',
        message: 'file too large',
      })
    })

    it('refuses a 2xx response with no string "id" field', async () => {
      server.respondToFiles({ status: 200, body: { ok: true } })

      await expect(
        uploadFile(options, {
          filename: 'a.pdf',
          contentType: 'application/pdf',
          bytes: Buffer.from('x'),
        })
      ).rejects.toMatchObject({ kind: 'client_error' })
    })
  })

  describe('createVectorStore', () => {
    it('returns the id the provider assigned', async () => {
      server.respondToVectorStoreCreate({ status: 200, body: { id: 'vs_xyz' } })

      const id = await createVectorStore(options, 'Web Design knowledge')

      expect(id).toBe('vs_xyz')
      expect(server.requests[0]?.body).toEqual({ name: 'Web Design knowledge' })
    })

    it('throws a classified error on failure', async () => {
      server.respondToVectorStoreCreate({ status: 500, body: {} })

      await expect(createVectorStore(options, 'x')).rejects.toBeInstanceOf(
        ModelRequestError
      )
    })

    it('refuses a 2xx response with no string "id" field', async () => {
      server.respondToVectorStoreCreate({ status: 200, body: {} })

      await expect(createVectorStore(options, 'x')).rejects.toMatchObject({
        kind: 'client_error',
      })
    })
  })

  describe('attachFileToVectorStore', () => {
    it('reports completed when the provider finishes synchronously', async () => {
      server.respondToVectorStoreFileAttach({
        status: 200,
        body: { status: 'completed' },
      })

      const result = await attachFileToVectorStore(options, 'vs_1', 'file_1')

      expect(result).toEqual({ status: 'completed' })
      expect(server.requests[0]?.path).toBe('/vector_stores/vs_1/files')
      expect(server.requests[0]?.body).toEqual({ file_id: 'file_1' })
    })

    // FILE-2: the provider's own rejection reason is carried through, not
    // just "it failed".
    it("reports failed with the provider's own reason", async () => {
      server.respondToVectorStoreFileAttach({
        status: 200,
        body: {
          status: 'failed',
          last_error: { message: 'unsupported file format' },
        },
      })

      const result = await attachFileToVectorStore(options, 'vs_1', 'file_1')

      expect(result).toEqual({
        status: 'failed',
        reason: 'unsupported file format',
      })
    })

    it('falls back to a generic reason when the provider explains nothing', async () => {
      server.respondToVectorStoreFileAttach({
        status: 200,
        body: { status: 'failed' },
      })

      const result = await attachFileToVectorStore(options, 'vs_1', 'file_1')

      expect(result).toEqual({
        status: 'failed',
        reason: 'OpenAI rejected this file for reasons it did not explain',
      })
    })

    it('classifies a non-2xx response the same way every other call in this package does', async () => {
      server.respondToVectorStoreFileAttach({ status: 500, body: {} })

      await expect(
        attachFileToVectorStore(options, 'vs_1', 'file_1')
      ).rejects.toBeInstanceOf(ModelRequestError)
    })

    // FILE-8: the regression that shipped to production — the real API
    // returns `in_progress` on *success*, not as an error. Polling until it
    // settles is the fix; treating this as an immediate failure (the old
    // behaviour) is exactly what re-attached an already-attached file five
    // times over.
    it('FILE-8: an attach that returns in_progress and then completed on a later poll resolves completed, without ever throwing', async () => {
      server.respondToVectorStoreFileAttach({
        status: 200,
        body: { status: 'in_progress' },
      })
      server.respondToVectorStoreFileAttachPoll({
        status: 200,
        body: { status: 'in_progress' },
      })
      server.respondToVectorStoreFileAttachPoll({
        status: 200,
        body: { status: 'completed' },
      })

      const result = await attachFileToVectorStore(options, 'vs_1', 'file_1', {
        maxWaitMs: 100,
        pollIntervalMs: 5,
      })

      expect(result).toEqual({ status: 'completed' })
      const polls = server.requests.filter(
        (r) =>
          r.method === 'GET' && r.path === '/vector_stores/vs_1/files/file_1'
      )
      expect(polls).toHaveLength(2)
    })

    // FILE-8: the same asynchronous path, but the provider eventually
    // rejects the file rather than finishing it — the provider's own
    // rejection reason still comes through, from the poll rather than the
    // original create call.
    it('FILE-8: in_progress then failed on a later poll resolves failed with the providers own reason', async () => {
      server.respondToVectorStoreFileAttach({
        status: 200,
        body: { status: 'in_progress' },
      })
      server.respondToVectorStoreFileAttachPoll({
        status: 200,
        body: {
          status: 'failed',
          last_error: { message: 'unsupported file format' },
        },
      })

      const result = await attachFileToVectorStore(options, 'vs_1', 'file_1', {
        maxWaitMs: 100,
        pollIntervalMs: 5,
      })

      expect(result).toEqual({
        status: 'failed',
        reason: 'unsupported file format',
      })
    })

    // FILE-8: an immediate `completed` (rare, but the API's own docs do not
    // rule it out) must resolve without ever reaching the poll endpoint —
    // there is nothing left to wait for.
    it('FILE-8: an immediate completed resolves without any polling call', async () => {
      server.respondToVectorStoreFileAttach({
        status: 200,
        body: { status: 'completed' },
      })

      const result = await attachFileToVectorStore(options, 'vs_1', 'file_1', {
        maxWaitMs: 100,
        pollIntervalMs: 5,
      })

      expect(result).toEqual({ status: 'completed' })
      expect(server.requests.filter((r) => r.method === 'GET')).toHaveLength(0)
    })

    // FILE-8: the polling budget is explicit and finite — still
    // `in_progress` at the deadline is a retryable error, not an unbounded
    // loop. `maxWaitMs`/`pollIntervalMs` are both driven by the test, so
    // this never actually waits 120s.
    it('FILE-8: still in_progress at the deadline throws a retryable error, with a bounded number of polls', async () => {
      server.respondToVectorStoreFileAttach({
        status: 200,
        body: { status: 'in_progress' },
      })
      // Every poll (there is no queued default `completed`) keeps reporting
      // `in_progress` — the fake's own default would otherwise settle it.
      for (let i = 0; i < 10; i++) {
        server.respondToVectorStoreFileAttachPoll({
          status: 200,
          body: { status: 'in_progress' },
        })
      }

      await expect(
        attachFileToVectorStore(options, 'vs_1', 'file_1', {
          maxWaitMs: 40,
          pollIntervalMs: 10,
        })
      ).rejects.toMatchObject({
        kind: 'server_error',
        retryable: true,
        message: expect.stringContaining('still processing'),
      })

      const polls = server.requests.filter((r) => r.method === 'GET')
      // ceil(40 / 10) = 4 — bounded, not unbounded.
      expect(polls).toHaveLength(4)
    })

    // FILE-8: a poll itself can fail transiently (a timeout, a rate limit,
    // a 5xx) — classified through `errors.ts` exactly like every other call
    // in this package, not swallowed as "still in progress".
    it('FILE-8: a non-2xx on a poll is classified through errors.ts the same as any other call', async () => {
      server.respondToVectorStoreFileAttach({
        status: 200,
        body: { status: 'in_progress' },
      })
      server.respondToVectorStoreFileAttachPoll({ status: 500, body: {} })

      await expect(
        attachFileToVectorStore(options, 'vs_1', 'file_1', {
          maxWaitMs: 100,
          pollIntervalMs: 5,
        })
      ).rejects.toBeInstanceOf(ModelRequestError)
    })
  })

  describe('deleteVectorStoreFile and deleteFile (FILE-3)', () => {
    it('deleteVectorStoreFile reaches the right path with DELETE', async () => {
      await deleteVectorStoreFile(options, 'vs_1', 'file_1')

      expect(server.requests[0]).toMatchObject({
        method: 'DELETE',
        path: '/vector_stores/vs_1/files/file_1',
      })
    })

    it('deleteFile reaches the right path with DELETE', async () => {
      await deleteFile(options, 'file_1')

      expect(server.requests[0]).toMatchObject({
        method: 'DELETE',
        path: '/files/file_1',
      })
    })

    it('deleteFile throws a classified error on failure', async () => {
      server.respondToFileDelete({ status: 404, body: {} })

      await expect(deleteFile(options, 'file_1')).rejects.toBeInstanceOf(
        ModelRequestError
      )
    })
  })
})
