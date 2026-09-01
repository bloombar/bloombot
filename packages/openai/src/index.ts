/** Public surface of `@bloombot/openai` — the OpenAI Responses API adapter behind `@bloombot/core`'s model port (MDL-1). */

export {
  createOpenAiModelClient,
  type CreateOpenAiModelClientOptions,
} from './client.js'

export { ModelRequestError, type ModelErrorKind } from './errors.js'

// FILE-1..3 — the provider calls `apps/worker`'s knowledge-file handler
// makes: upload, vector-store creation/attach, and the two deletes a
// detach reaches (`files.ts`'s own module comment).
export {
  uploadFile,
  createVectorStore,
  attachFileToVectorStore,
  deleteVectorStoreFile,
  deleteFile,
  type FilesHttpOptions,
  type AttachFileToVectorStoreResult,
} from './files.js'
