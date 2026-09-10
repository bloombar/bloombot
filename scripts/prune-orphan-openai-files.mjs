/**
 * Removes the duplicate OpenAI files FILE-8's retry bug created, runnable as
 * `npm run files:prune-orphans`.
 *
 * Before FILE-8 (merged), `attachFileToVectorStore` treated the vector-store
 * attach endpoint's normal asynchronous `in_progress` response as a
 * transient failure. The job queue then retried the whole handler — and
 * step 2 of that handler re-uploaded the file's bytes, because it did not
 * check for an already-recorded `providerFileId`. So every failing
 * attachment uploaded the same bytes up to five times, and most of those
 * copies really did attach to the course's vector store. Only one file id
 * per attachment is ever recorded in `course_attachments.provider_file_id`;
 * the rest sit on the OpenAI account, unreferenced, grounding answers on
 * several identical copies of the same document and paying storage on all
 * of them.
 *
 * The safety rule this script exists to get right — deleting the wrong file
 * destroys real teaching material, on a live OpenAI account, permanently:
 *
 *   Delete an OpenAI file only when it is a PROVABLE DUPLICATE of something
 *   this platform tracks. A candidate (`purpose: 'assistants'`) is
 *   deletable when BOTH hold:
 *     1. its id appears in no `course_attachments.provider_file_id`; AND
 *     2. there IS a `course_attachments` row whose `filename` and
 *        `size_bytes` both match the candidate's own `filename` and
 *        `bytes`, and whose `provider_file_id` is non-null and different.
 *
 *   Condition 2 is what proves the file is a leftover copy of a *tracked*
 *   attachment, rather than something else. FILE-1's own text describes
 *   courses whose `vectorStoreId` was typed in from a vendor dashboard,
 *   whose files were uploaded outside this platform and appear in no
 *   `course_attachments` row at all — unreferenced, but not proven
 *   anything. Deleting those would be the worst possible outcome of running
 *   this script, so anything unreferenced that fails condition 2 is only
 *   ever reported, never touched, not even with `--apply`.
 *
 *   A candidate created within the last hour (OpenAI's own `created_at`) is
 *   always skipped too, so this can never race an upload still in flight.
 *
 * Dry run by default; `--apply` is what actually deletes. Pure, exported
 * functions carry every decision above so they are testable without a
 * network or a database; the network/database halves below are the thin
 * wiring around them.
 *
 * Follows `scripts/reparent-orphan-channels.mjs`'s own shape closely (same
 * dry-run-by-default and `loadDotEnvOnce()` conventions) and deliberately
 * has no dependency on this workspace's own TypeScript packages — the same
 * "must run on a droplet without a build" reason that file, and
 * `scripts/check-discord-oauth.mjs`, both give.
 */

import BetterSqlite3 from 'better-sqlite3'

import { loadDotEnvOnce } from './load-dotenv.mjs'

/** OpenAI's own default base URL, mirroring `OPENAI_BASE_URL`'s default in `packages/config/src/env.ts`. */
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

/** `DATABASE_PATH`'s own default, mirroring `packages/config/src/env.ts` — duplicated rather than imported, per this file's own module comment. */
const DEFAULT_DATABASE_PATH = './data/data.db'

/** How long a freshly created file is left alone, so this can never race an upload still in flight. */
export const RECENT_FILE_GRACE_MS = 60 * 60 * 1000

/** Parse the command line into `{ apply }`. Dry run unless `--apply` is given, and nothing else is recognised. */
export function parseArgs(argv) {
  let apply = false
  for (const arg of argv) {
    if (arg === '--apply') {
      apply = true
    } else {
      throw new Error(`unrecognised argument: ${arg}`)
    }
  }
  return { apply }
}

/** `DATABASE_PATH`, resolved the same way `CONFIG.DATABASE_PATH` is — an explicit override, or `./data/data.db`. */
export function resolveDatabasePath(env = process.env) {
  return env.DATABASE_PATH && env.DATABASE_PATH.length > 0
    ? env.DATABASE_PATH
    : DEFAULT_DATABASE_PATH
}

// --- the classifier ---------------------------------------------------------
// Everything below is pure: given the file list this platform's OpenAI
// account actually holds and the attachment rows this platform actually
// tracks, decide what happens to each file. No network, no database.

/** The set of provider file ids this platform has ever recorded against an attachment — condition 1's "referenced" set. */
function referencedFileIds(attachments) {
  return new Set(
    attachments
      .map((attachment) => attachment.providerFileId)
      .filter((id) => id != null)
  )
}

/** Condition 2 — some tracked attachment matches this file's own filename and size, and is recorded under a *different* provider file id. */
function hasDuplicateAttachment(file, attachments) {
  return attachments.some(
    (attachment) =>
      attachment.filename === file.filename &&
      attachment.sizeBytes === file.bytes &&
      attachment.providerFileId != null &&
      attachment.providerFileId !== file.id
  )
}

/** Whether `file` was created within the last hour of `nowMs`, using OpenAI's own `created_at` (Unix seconds). */
function isTooRecent(file, nowMs) {
  return nowMs - file.created_at * 1000 < RECENT_FILE_GRACE_MS
}

/**
 * Classify every candidate file against the safety rule (this file's own
 * module comment), splitting them into four buckets:
 *
 *   - `deletable` — both conditions hold: safe to prune.
 *   - `tooRecent` — otherwise a candidate, but created too recently to act on.
 *   - `unresolved` — unreferenced, but condition 2 does not hold: report only,
 *     never act, since FILE-1's hand-uploaded files land here too.
 *   - `referenced` — condition 1 fails: this file is exactly what a
 *     `course_attachments` row currently points at, so it is not a candidate
 *     at all and is not reported.
 *
 * `now` defaults to `Date.now()` but takes an explicit value so a test never
 * depends on the wall clock.
 */
export function classifyFiles(files, attachments, now = Date.now()) {
  const referenced = referencedFileIds(attachments)
  const deletable = []
  const tooRecent = []
  const unresolved = []

  for (const file of files) {
    if (referenced.has(file.id)) continue
    if (isTooRecent(file, now)) {
      tooRecent.push(file)
    } else if (hasDuplicateAttachment(file, attachments)) {
      deletable.push(file)
    } else {
      unresolved.push(file)
    }
  }

  return { deletable, tooRecent, unresolved }
}

// --- the network half --------------------------------------------------------

/** One OpenAI API call. Returns `{ status, body }` on any response, 2xx or not — callers decide what a given status means (a 404 is "success" for the vector-store removal below, but not for anything else). */
async function callOpenAi(method, path, { apiKey, baseUrl, fetchFn = fetch }) {
  const response = await fetchFn(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : undefined
  return { status: response.status, ok: response.ok, body }
}

/**
 * Every OpenAI file with `purpose: 'assistants'`, across every page —
 * `GET /files` paginates, and a droplet with hundreds of orphans will have
 * several; a script that silently stopped after the first page would look
 * complete while pruning almost nothing.
 */
export async function listAllFiles(options) {
  const files = []
  let after
  for (;;) {
    const query = after
      ? `?purpose=assistants&limit=100&after=${after}`
      : '?purpose=assistants&limit=100'
    const { ok, status, body } = await callOpenAi(
      'GET',
      `/files${query}`,
      options
    )
    if (!ok) {
      throw new Error(
        `GET /files${query} -> ${status}: ${JSON.stringify(body)}`
      )
    }
    files.push(...(body?.data ?? []))
    if (!body?.has_more) break
    after = body?.last_id ?? files[files.length - 1]?.id
    if (!after) break
  }
  return files
}

/**
 * Removes one deletable file from every vector store this platform knows
 * about, then the file object itself — in that order, so no dangling
 * vector-store entry is ever left behind pointing at a file that no longer
 * exists.
 *
 * `vectorStoreIds` is the full, authoritative list from `courses.vector_store_id`
 * (this platform never blindly enumerates the whole OpenAI account's vector
 * stores) — a deletable file's own store is not recorded anywhere, so every
 * known store is tried. A 404 removing it from a given store means it was
 * never attached there, which is success, not a failure, for that store.
 *
 * Returns `{ ok: true }` or `{ ok: false, error }`; never throws, so one
 * file's failure cannot abort the run — `pruneAll`, below, is what collects
 * these across every file.
 */
export async function deleteFileEverywhere(file, vectorStoreIds, options) {
  try {
    for (const vectorStoreId of vectorStoreIds) {
      const removal = await callOpenAi(
        'DELETE',
        `/vector_stores/${vectorStoreId}/files/${file.id}`,
        options
      )
      if (!removal.ok && removal.status !== 404) {
        throw new Error(
          `DELETE /vector_stores/${vectorStoreId}/files/${file.id} -> ${removal.status}: ${JSON.stringify(removal.body)}`
        )
      }
    }
    const deletion = await callOpenAi('DELETE', `/files/${file.id}`, options)
    if (!deletion.ok) {
      throw new Error(
        `DELETE /files/${file.id} -> ${deletion.status}: ${JSON.stringify(deletion.body)}`
      )
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Prunes every deletable file, one at a time, collecting every failure
 * rather than stopping at the first — the same discipline
 * `scripts/deploy.sh`'s own `reload_everything` uses. Returns
 * `{ succeeded, failed }`, where `failed` pairs each file with its error.
 */
export async function pruneAll(deletableFiles, vectorStoreIds, options) {
  const succeeded = []
  const failed = []
  for (const file of deletableFiles) {
    const result = await deleteFileEverywhere(file, vectorStoreIds, options)
    if (result.ok) {
      succeeded.push(file)
    } else {
      failed.push({ file, error: result.error })
    }
  }
  return { succeeded, failed }
}

// --- the database half -------------------------------------------------------

/**
 * Reads the two facts this script is checked against, straight off the
 * database rather than through `@bloombot/db` (this file's own module
 * comment: no dependency on the workspace's own TypeScript packages). Opens
 * read-only — this script only ever proves things against the row data, it
 * never writes to it.
 */
export function readTrackedState(databasePath) {
  const db = new BetterSqlite3(databasePath, {
    readonly: true,
    fileMustExist: true,
  })
  try {
    const attachments = db
      .prepare(
        'SELECT filename, size_bytes AS sizeBytes, provider_file_id AS providerFileId FROM course_attachments'
      )
      .all()
    const vectorStoreIds = db
      .prepare(
        'SELECT DISTINCT vector_store_id AS vectorStoreId FROM courses WHERE vector_store_id IS NOT NULL'
      )
      .all()
      .map((row) => row.vectorStoreId)
    return { attachments, vectorStoreIds }
  } finally {
    db.close()
  }
}

// --- reporting ---------------------------------------------------------------

/** One human-readable line per file, for both the plan and the summary. */
function describeFile(file) {
  return `${file.filename} (id: ${file.id}, ${file.bytes} bytes)`
}

/** Prints the plan — what this run found, before anything (if anything) is deleted. Makes a dry run's "nothing changed" obvious by construction: it never mentions deleting anything unless `apply` is true. */
function printPlan({ files, deletable, tooRecent, unresolved, apply }) {
  console.log(`Examined ${files.length} file(s) with purpose "assistants".`)
  console.log(
    `${deletable.length} deletable duplicate(s)${apply ? '' : ' (dry run — would be removed with --apply)'}:`
  )
  for (const file of deletable) console.log(`  DELETE ${describeFile(file)}`)

  console.log(`${tooRecent.length} skipped as created within the last hour:`)
  for (const file of tooRecent) console.log(`  SKIP   ${describeFile(file)}`)

  console.log(
    `${unresolved.length} left alone — unreferenced but not a provable duplicate ` +
      '(may be hand-uploaded course material; a human should look):'
  )
  for (const file of unresolved) console.log(`  REVIEW ${describeFile(file)}`)
}

/** Prints the summary after acting (or after a dry run decided not to). */
function printSummary({ apply, succeeded, failed }) {
  if (!apply) {
    console.log('\nDRY RUN — nothing changed. Re-run with --apply to delete.')
    return
  }
  console.log(`\nDeleted ${succeeded.length} file(s).`)
  if (failed.length > 0) {
    console.error(`${failed.length} failure(s):`)
    for (const { file, error } of failed) {
      console.error(`  FAILED ${describeFile(file)}: ${error}`)
    }
  }
}

// --- entry point --------------------------------------------------------------

/**
 * Runs the whole plan-then-act flow given an already-fetched file list and
 * already-read database state, and returns the exit code to use. This is
 * the one thing worth pinning with a test that a dry run truly never
 * writes: `apply: false` never so much as calls `pruneAll` (and so never
 * calls the network functions that issue `DELETE`) — it only classifies and
 * prints.
 */
export async function execute({
  apply,
  files,
  attachments,
  vectorStoreIds,
  options,
  now,
}) {
  const { deletable, tooRecent, unresolved } = classifyFiles(
    files,
    attachments,
    now
  )

  printPlan({ files, deletable, tooRecent, unresolved, apply })

  if (!apply) {
    printSummary({ apply, succeeded: [], failed: [] })
    return 0
  }

  const { succeeded, failed } = await pruneAll(
    deletable,
    vectorStoreIds,
    options
  )
  printSummary({ apply, succeeded, failed })
  return failed.length > 0 ? 1 : 0
}

async function main() {
  loadDotEnvOnce()

  let apply
  try {
    ;({ apply } = parseArgs(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error('Usage: node scripts/prune-orphan-openai-files.mjs [--apply]')
    process.exitCode = 1
    return
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.error('OPENAI_API_KEY is not set.')
    process.exitCode = 1
    return
  }
  const baseUrl = (
    process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL
  ).replace(/\/+$/, '')
  const options = { apiKey, baseUrl }

  const databasePath = resolveDatabasePath(process.env)
  const { attachments, vectorStoreIds } = readTrackedState(databasePath)

  const files = await listAllFiles(options)

  process.exitCode = await execute({
    apply,
    files,
    attachments,
    vectorStoreIds,
    options,
  })
}

// Only run when invoked directly, so the test can import the pure functions.
if (process.argv[1]?.endsWith('prune-orphan-openai-files.mjs')) {
  await main()
}
