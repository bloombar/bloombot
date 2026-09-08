/**
 * FILE-1..3 — the OpenAI calls `apps/worker`'s knowledge-file handler makes:
 * upload a file, create a vector store for a course that has none yet,
 * attach an uploaded file to one, and undo both a detach. The same call
 * shape `client.ts`/`conversations.ts` already use — `postJson` for every
 * JSON call (`http.ts`, widened in this slice to carry a `method` too), and
 * failures classified the same way (`errors.ts`) so a transient failure
 * (a timeout, a rate limit, a 5xx) is a caller's decision to retry, never
 * this file's own.
 *
 * `uploadFile` is the one exception: OpenAI's `POST /files` takes
 * `multipart/form-data`, not JSON, so it builds its own request with the
 * platform runtime's own `FormData`/`Blob` rather than going through
 * `postJson` — everything else about it (the abort/timeout dance, the same
 * error classification) still matches `http.ts`'s own shape as closely as
 * a different body encoding allows.
 */

import { classifyHttpError, timeoutError, ModelRequestError } from './errors.js'
import { postJson, type PostJsonOptions } from './http.js'

/** The four fields every call in this file needs — the same shape `client.ts`'s own `HttpOptions` already threads through its own helpers. */
export interface FilesHttpOptions {
  fetchFn: typeof fetch
  baseUrl: string
  apiKey: string
  timeoutMs: number
}

function stripTrailingSlashes(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * Upload one file's bytes to OpenAI (FILE-1), returning the provider's own
 * file id. `purpose` is always `'assistants'` — the purpose file-search
 * (MDL-3's own tool) reads uploaded files under.
 *
 * Built directly against `fetch` rather than `postJson` (this file's own
 * module comment: a multipart body, not JSON) — but the same timeout and
 * error-classification discipline `http.ts` holds every other call in this
 * package to: the request is bounded by `AbortController`, and a non-2xx
 * response is classified through `errors.ts` the same way `client.ts`'s own
 * `postResponses` classifies one.
 */
export async function uploadFile(
  options: FilesHttpOptions,
  input: { filename: string; contentType: string; bytes: Uint8Array }
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const form = new FormData()
    form.set('purpose', 'assistants')
    // `Blob`/`File` both accept a `BlobPart[]` — a fresh `Uint8Array` view
    // over the same bytes, never mutated by anything downstream.
    form.set(
      'file',
      new File([input.bytes], input.filename, { type: input.contentType })
    )

    let response: Response
    try {
      response = await options.fetchFn(
        `${stripTrailingSlashes(options.baseUrl)}/files`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.apiKey}` },
          body: form,
          signal: controller.signal,
        }
      )
    } catch (error) {
      if (controller.signal.aborted) {
        throw timeoutError(options.timeoutMs, error)
      }
      throw error
    }

    const text = await response.text()
    const body: unknown = text ? JSON.parse(text) : undefined
    if (!response.ok) {
      throw classifyHttpError(response.status, body)
    }
    const id = (body as { id?: unknown } | undefined)?.id
    if (typeof id !== 'string') {
      throw new ModelRequestError(
        'client_error',
        'OpenAI files.create response had no string "id" field'
      )
    }
    return id
  } finally {
    clearTimeout(timer)
  }
}

/** Create a fresh, empty vector store (FILE-1 — created for a course the first time any file is attached this way; see `docs/DECISIONS.md` for what happens to a course's own hand-typed `vectorStoreId`). Returns the provider's own store id. */
export async function createVectorStore(
  options: PostJsonOptions,
  name: string
): Promise<string> {
  const response = await postJson('/vector_stores', { name }, options)
  if (!response.ok) {
    throw classifyHttpError(response.status, response.body)
  }
  const id = (response.body as { id?: unknown } | undefined)?.id
  if (typeof id !== 'string') {
    throw new ModelRequestError(
      'client_error',
      'OpenAI vector_stores.create response had no string "id" field'
    )
  }
  return id
}

/** What attaching a file to a vector store resolved to — mirrors the two outcomes FILE-2 asks a caller to distinguish. */
export type AttachFileToVectorStoreResult =
  { status: 'completed' } | { status: 'failed'; reason: string }

/**
 * Attach an already-uploaded file to a vector store (FILE-1). OpenAI's own
 * API processes this asynchronously in general (`status` can come back
 * `in_progress`); this adapter treats anything other than an immediate
 * `completed` or `failed` as a transient `server_error` (MDL-5's own
 * retryable class) — `apps/worker`'s job queue is what actually supplies
 * the retry, exactly the way an ordinary transient HTTP failure already
 * does for every other call in this package, so this file adds no polling
 * loop of its own.
 */
export async function attachFileToVectorStore(
  options: PostJsonOptions,
  vectorStoreId: string,
  fileId: string
): Promise<AttachFileToVectorStoreResult> {
  const response = await postJson(
    `/vector_stores/${vectorStoreId}/files`,
    { file_id: fileId },
    options
  )
  if (!response.ok) {
    throw classifyHttpError(response.status, response.body)
  }
  const body = response.body as
    { status?: unknown; last_error?: { message?: unknown } } | undefined
  if (body?.status === 'completed') return { status: 'completed' }
  if (body?.status === 'failed') {
    const reason =
      typeof body.last_error?.message === 'string'
        ? body.last_error.message
        : 'OpenAI rejected this file for reasons it did not explain'
    return { status: 'failed', reason }
  }
  // Still `in_progress` (or a shape this adapter does not recognise) —
  // worth a retry, the same as any other transient failure (see this
  // function's own doc comment).
  throw new ModelRequestError(
    'server_error',
    `OpenAI vector_stores.files.create did not complete synchronously (status: ${String(body?.status)})`
  )
}

/** Remove a file from a vector store (FILE-3) — what actually stops it grounding answers; the file object itself is a separate call (`deleteFile`, below). */
export async function deleteVectorStoreFile(
  options: PostJsonOptions,
  vectorStoreId: string,
  fileId: string
): Promise<void> {
  const response = await postJson(
    `/vector_stores/${vectorStoreId}/files/${fileId}`,
    undefined,
    { ...options, method: 'DELETE' }
  )
  if (!response.ok) {
    throw classifyHttpError(response.status, response.body)
  }
}

/** Delete the file object itself (FILE-3) — the provider no longer holds a copy at all, not merely "not searched" (`deleteVectorStoreFile`, above, is what stops the searching; this reclaims the storage). */
export async function deleteFile(
  options: PostJsonOptions,
  fileId: string
): Promise<void> {
  const response = await postJson(`/files/${fileId}`, undefined, {
    ...options,
    method: 'DELETE',
  })
  if (!response.ok) {
    throw classifyHttpError(response.status, response.body)
  }
}
