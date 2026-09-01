/**
 * Environment configuration, validated once against a zod schema (CFG-5).
 *
 * The Python system this replaces reads the environment with bare `os.getenv`,
 * so a missing value is `None` until something dereferences it — often hours
 * into a deployment, in a code path nobody was watching. Here the environment is
 * parsed against a schema, and a bad environment fails immediately with *every*
 * problem listed at once rather than one per restart.
 *
 * Nothing is parsed at import time (PLAT-5). `CONFIG` reads lazily on first
 * property access, so importing this module can never throw, crash a test
 * collector, or capture an environment a test had not finished setting up.
 */

import { z } from 'zod'

/** A port number as it can appear in an environment variable: a decimal string. */
const port = (defaultValue: number) =>
  z.coerce.number().int().min(1).max(65535).default(defaultValue)

export const envSchema = z.object({
  // Which deployment this process believes it is. Deliberately required: a
  // wrong guess here changes logging, cookies and error detail, so it is
  // safer to refuse to start than to default to something plausible.
  NODE_ENV: z.enum(['development', 'test', 'production']),

  // Minimum severity written to the logs. No `trace`: response_bot.py
  // uppercases this straight into `logging.basicConfig(level=…)`, and
  // Python's `logging` module has no TRACE level — `logging._checkLevel`
  // raises `ValueError` on it, crashing the live bot on startup.
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  // Directory the per-process JSONL log files are written into.
  LOGS_DIR: z.string().min(1).default('./logs'),

  // SQLite file holding users, messages and tenancy.
  DATABASE_PATH: z.string().min(1).default('./data/data.db'),

  // Public origin of the control panel, used to build links in outbound email.
  PUBLIC_APP_URL: z.url(),

  // Port the Express API listens on.
  API_PORT: port(3000),

  // Port the Discord bot's health endpoint listens on.
  BOT_HEALTH_PORT: port(3001),

  // Port apps/worker's health endpoint listens on (JOB-5).
  WORKER_HEALTH_PORT: port(3002),

  // Comma-separated platform administrator emails (AUTH-4). May be empty.
  // Read through `isAdminEmail`, never from here — see the note in admin.ts.
  ADMIN_EMAILS: z.string().default(''),

  // JOB-2..3: the background queue's own policy. See docs/DECISIONS.md for
  // why these particular numbers. `@bloombot/jobs` takes every one of these
  // as an explicit argument rather than reading `CONFIG` itself (CORE-4's
  // "dependencies as arguments" discipline) — `apps/worker` is the one place
  // that reads them, at startup, the same as every other `CONFIG` value
  // apps/bot and apps/api already read once in their own `main()`.
  //
  // No `JOB_MAX_ATTEMPTS` here (rework finding 4) — the bound on attempts
  // is `job.maxAttempts` on the row itself (`repos/jobs.ts#NewJob`,
  // required per-enqueue, enforced in `packages/jobs/src/runner.ts`), not a
  // policy default; an earlier variable of this name existed but was never
  // read by anything, so raising it changed nothing an operator could
  // observe.
  JOB_CLAIM_LEASE_MS: z.coerce.number().int().min(1).default(300_000),
  JOB_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(1_000),
  JOB_RETRY_BACKOFF_FACTOR: z.coerce.number().min(1).default(2),
  // How long apps/worker sleeps between claim attempts once the queue is
  // found empty.
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(1).default(2_000),
  // Rework finding 5 — bounds how long a single handler call may run before
  // `runNextJob` gives up on it and fails the attempt, rather than awaiting
  // it unbounded and stalling every later claim (`apps/worker` runs one job
  // at a time). Defaults under `JOB_CLAIM_LEASE_MS`'s own default so a
  // timeout fires — and this worker can move on to its next claim — while
  // the lease this attempt claimed the job under is still comfortably held;
  // see docs/DECISIONS.md for the full reasoning and what a handler still
  // running underneath a fired timeout means for idempotency.
  JOB_HANDLER_TIMEOUT_MS: z.coerce.number().int().min(1).default(240_000),

  // JOB-4: the bound on concurrent model calls, and how long a request
  // waits for a slot before it is told plainly it could not be served —
  // both configuration, not a constant compiled into a client (JOB-4's own
  // text). Read once at startup by whichever process actually answers —
  // `apps/bot`'s own `main()` today — not by `@bloombot/core`'s `answer.ts`
  // itself: `packages/core` never reads `CONFIG` at all (see
  // docs/DECISIONS.md's "why `packages/core` itself never reads `CONFIG`"
  // for the coupling that first version hit and why this slice moved the
  // read to the process instead).
  MODEL_ADMISSION_LIMIT: z.coerce.number().int().min(1).default(5),
  MODEL_ADMISSION_WAIT_MS: z.coerce.number().int().min(0).default(15_000),

  // Upstream base URLs. These exist so tests can point every outbound call at a
  // fake upstream and no vendor host is ever hardcoded in a client (QA-2).
  // Each defaults to the real service, so production needs none of them set.
  DISCORD_API_BASE: z.url().default('https://discord.com/api/v10'),
  DISCORD_OAUTH_BASE: z.url().default('https://discord.com/api/oauth2'),
  OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  GOOGLE_ISSUER: z.url().default('https://accounts.google.com'),

  // Google OAuth client id (AUTH-2). Checked as the `aud` claim on every ID
  // token `packages/auth`'s `google.ts` verifies — an unset audience must
  // never be treated as "accept any audience", so an empty value here makes
  // the real verifier refuse every token rather than skip the check.
  GOOGLE_CLIENT_ID: z.string().default(''),
})

/** The validated environment. */
export type Env = z.infer<typeof envSchema>

/**
 * Thrown when the environment does not satisfy the schema. The message lists
 * every offending variable, because fixing them one restart at a time is the
 * failure mode this whole module exists to prevent.
 */
export class EnvValidationError extends Error {
  /** One human-readable line per offending variable. */
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(
      `Invalid environment. Fix all of the following:\n${problems.map((p) => `  - ${p}`).join('\n')}`
    )
    this.name = 'EnvValidationError'
    this.problems = problems
  }
}

/**
 * Validate a plain object as the environment.
 *
 * Takes an explicit source rather than reading `process.env` so tests can parse
 * a fixture without mutating global state.
 *
 * @throws {EnvValidationError} listing every missing or invalid variable.
 */
export function parseEnv(source: Record<string, unknown>): Env {
  const result = envSchema.safeParse(source)
  if (result.success) return result.data

  // zod collects every issue; keep them all rather than reporting the first.
  const problems = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)'
    return `${key}: ${issue.message}`
  })
  throw new EnvValidationError(problems)
}

/** Memoized result of parsing `process.env`, so validation happens once. */
let cached: Env | undefined

/**
 * The process environment, parsed on first call and cached thereafter.
 */
export function loadConfig(): Env {
  cached ??= parseEnv(process.env as Record<string, unknown>)
  return cached
}

/** Drop the memoized environment. Tests use this after changing `process.env`. */
export function resetConfigCache(): void {
  cached = undefined
}

/**
 * Refuses a write to `CONFIG`. Without this, an assignment like
 * `CONFIG.LOG_LEVEL = 'debug'` would silently write to the Proxy's empty
 * target instead of the cached environment, turning that key into a
 * read-only, non-configurable data property. Every later read of it then
 * throws from inside the `get` trap — a `TypeError` `resetConfigCache()`
 * cannot clear, because the broken property lives on the target, not the
 * cache.
 */
function rejectWrite(property: string | symbol): never {
  throw new Error(
    `CONFIG.${String(property)} is read-only. CONFIG reflects the process ` +
      'environment; it cannot be assigned to. To run against a different ' +
      'environment, call parseEnv() with the values you want, or change ' +
      'process.env and call resetConfigCache() before the next read.'
  )
}

/**
 * The validated environment, as an ordinary object.
 *
 * It is a proxy rather than a parsed constant so that *importing* this module
 * has no side effect (PLAT-5) while *using* it still fails fast. `CONFIG.API_PORT`
 * validates the whole environment on the first access and reports everything
 * wrong with it at once.
 */
export const CONFIG: Env = new Proxy({} as Env, {
  get: (_target, property: string | symbol) =>
    loadConfig()[property as keyof Env],
  has: (_target, property: string | symbol) => property in loadConfig(),
  ownKeys: () => Reflect.ownKeys(loadConfig()),
  getOwnPropertyDescriptor: (_target, property: string | symbol) =>
    Reflect.getOwnPropertyDescriptor(loadConfig(), property),
  set: (_target, property) => rejectWrite(property),
  defineProperty: (_target, property) => rejectWrite(property),
  deleteProperty: (_target, property) => rejectWrite(property),
})
