/** Public surface of `@bloombot/openai` — the OpenAI Responses API adapter behind `@bloombot/core`'s model port (MDL-1). */

export {
  createOpenAiModelClient,
  type CreateOpenAiModelClientOptions,
} from './client.js'

export { ModelRequestError, type ModelErrorKind } from './errors.js'
