/** Public surface of `@bloombot/openai` — the OpenAI Responses API adapter behind `@bloombot/core`'s model port (MDL-1). */

export {
  createOpenAiModelClient,
  type CreateOpenAiModelClientOptions,
} from './client.js'

export { ModelRequestError, type ModelErrorKind } from './errors.js'

// FILE-1..3 — the provider calls `apps/worker`'s knowledge-file handler
// makes: upload, vector-store creation/attach, and the two deletes a
// detach reaches (`files.ts`'s own module comment). `deleteVectorStore` is
// PROJ-8's own addition (cheap-fix 2, rework round 2) — deleting the store
// itself once every file in it, and the course that owned it, are gone.
export {
  uploadFile,
  createVectorStore,
  attachFileToVectorStore,
  deleteVectorStoreFile,
  deleteFile,
  deleteVectorStore,
  type FilesHttpOptions,
  type AttachFileToVectorStoreResult,
} from './files.js'
