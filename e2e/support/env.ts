/**
 * Fixed values the e2e harness's two processes (`start-api.ts`, and
 * `apps/web`'s own `vite preview`) and the Playwright specs all need to
 * agree on. Fixed rather than dynamically allocated: this slice runs one
 * Playwright project at a time, not several in parallel, so a free-port
 * search would be solving a problem this harness does not have yet — ports
 * chosen away from the dev defaults (`env.example`'s `3000`/`5173`) so this
 * suite does not collide with a `npm run dev` a developer already has
 * running locally.
 */

import { join } from 'node:path'

export const E2E_API_PORT = 3919
export const E2E_WEB_PORT = 5919
export const E2E_PUBLIC_APP_URL = `http://127.0.0.1:${E2E_WEB_PORT}`
export const E2E_API_ORIGIN = `http://127.0.0.1:${E2E_API_PORT}`

// e2e/tmp/ — the throwaway path `.claude/hooks/guard-paths.sh` already
// documents and tests for (its own comment: "the test suites and Playwright
// deliberately write throwaway databases under tmp/ and e2e/tmp/").
const TMP_ROOT = join(import.meta.dirname, '..', 'tmp')
export const E2E_DATABASE_PATH = join(TMP_ROOT, 'e2e.db')
export const E2E_LOGS_DIR = join(TMP_ROOT, 'logs')
export const E2E_MAIL_PATH = join(TMP_ROOT, 'mail.jsonl')
// FILE-1..5 — a course attachment's bytes, same `tmp/` reasoning as every
// other path above: `createPlatformRegistry`'s own fallback
// (`packages/actions/src/actions/index.ts`) is a literal `./data/attachments`
// — the repository's own protected directory — so this harness must thread
// its own path explicitly rather than let `start-api.ts`'s `buildApp` call
// fall through to it.
export const E2E_ATTACHMENT_STORAGE_DIR = join(TMP_ROOT, 'attachments')
