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
 * destroys real teaching material, on a live OpenAI account, permanently.
 * A candidate (`purpose: 'assistants'`) is deletable only when ALL hold:
 *
 *   1. its id appears in no `course_attachments.provider_file_id` — it is
 *      not what any attachment currently points at; AND
 *   2. there is a `course_attachments` row ("the proving attachment") whose
 *      `filename` and `size_bytes` both match the candidate's own, whose
 *      `provider_file_id` is non-null and different from the candidate's
 *      id, and whose course has a `vector_store_id`; AND
 *   3. that proving attachment's own tracked file (`provider_file_id`) IS
 *      actually present in that course's vector store — otherwise the
 *      "original" this candidate would be a duplicate *of* was itself never
 *      attached (FILE-8's bug can land either side of a retry), and pruning
 *      would leave the course grounded on nothing; the whole attachment is
 *      reported instead, as needing a re-attach, not a prune; AND
 *   4. the *candidate itself* is present in that same, specific course's
 *      vector store — filename and size matching a tracked attachment is
 *      not proof by itself: two different courses (two different
 *      organizations, even) can each hold a hand-uploaded copy of the same
 *      document under the same name and size, and only the store lookup
 *      tells a genuine leftover duplicate apart from an unrelated file that
 *      merely looks like one.
 *
 * Condition 1 rules out anything a `course_attachments` row still points
 * at. Conditions 2-4 are what turn "unreferenced" into "provably a leftover
 * copy of a specific, tracked attachment" rather than something else —
 * FILE-1's own text describes courses whose `vectorStoreId` was typed in
 * from a vendor dashboard, whose files were uploaded outside this platform
 * and appear in no `course_attachments` row at all. Deleting one of those
 * would be the worst possible outcome of running this script, so anything
 * unreferenced that fails any of 2-4 is only ever reported, never touched,
 * not even with `--apply`.
 *
 * A candidate created within the last hour (OpenAI's own `created_at`) is
 * always skipped too, so this can never race an upload still in flight —
 * and a `created_at` this script cannot parse is treated the same way
 * (skip, not "assume it's old enough"), never treated as eligible by
 * accident.
 *
 * Dry run by default; `--apply` is what actually deletes. Pure, exported
 * functions carry every synchronous decision above; `classifyFiles` itself
 * is async because conditions 3 and 4 need to ask OpenAI whether a specific
 * file is really in a specific vector store — no way to answer that without
 * a network round trip — but every OpenAI call it makes is injected
 * (`verifyMembership`), so the classifier itself is still fully testable
 * against a stub, never a live account.
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

/**
 * The page size `listAllFiles` asks OpenAI's `GET /files` for. Large enough
 * that a droplet's whole backlog of orphans usually fits on one page — this
 * is a *request* size, not a promise from the API, so `listAllFiles` still
 * pages correctly if the account holds more than this in one call.
 */
export const DEFAULT_FILES_PAGE_LIMIT = 10_000

/** Bounds every OpenAI call this script makes, the same `AbortController` discipline `packages/openai/src/http.ts`'s own `postJson` uses — one stalled request must not hang the whole run. */
export const DEFAULT_TIMEOUT_MS = 30_000

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
// The synchronous half is pure: given the file list this platform's OpenAI
// account actually holds and the attachment rows this platform actually
// tracks, decide which files are even worth a network round trip. The
// vector-store membership checks (conditions 3 and 4, this file's own
// module comment) are async and go through an injected `verifyMembership`,
// so `classifyFiles` itself never touches a real network but still covers
// the decisions that matter.

/** The set of provider file ids this platform has ever recorded against an attachment — condition 1's "referenced" set. */
function referencedFileIds(attachments) {
  return new Set(
    attachments
      .map((attachment) => attachment.providerFileId)
      .filter((id) => id != null)
  )
}

/**
 * Condition 2's filename/size match, on its own — exported and tested
 * directly (rather than only through `classifyFiles`) because two of its
 * four clauses are otherwise invisible to the test suite: a mutation
 * dropping `providerFileId != null` or `providerFileId !== file.id` changes
 * nothing `classifyFiles` itself would ever observe, since a file whose id
 * *is* some attachment's `providerFileId` is already excluded earlier, by
 * `referencedFileIds` — this function is the one place both clauses are
 * actually load-bearing on their own.
 */
export function matchesAttachment(file, attachment) {
  return (
    attachment.filename === file.filename &&
    attachment.sizeBytes === file.bytes &&
    attachment.providerFileId != null &&
    attachment.providerFileId !== file.id
  )
}

/**
 * Whether `file` was created within the last hour of `nowMs`, using
 * OpenAI's own `created_at` (Unix seconds). A `created_at` this cannot
 * parse into a finite number is treated as "too recent" — the safe
 * direction for a `NaN` comparison to fail into, since `NaN < anything` is
 * always `false` and would otherwise silently wave a candidate with no
 * trustworthy age straight through the grace window it exists to enforce.
 */
function isTooRecent(file, nowMs) {
  const createdAtMs = Number(file.created_at) * 1000
  if (!Number.isFinite(createdAtMs)) return true
  return nowMs - createdAtMs < RECENT_FILE_GRACE_MS
}

/**
 * Classify every candidate file against the safety rule (this file's own
 * module comment), returning:
 *
 *   - `deletable` — `{ file, attachment }` pairs: both files and the
 *     specific `course_attachments` row (and its course's vector store)
 *     that proved each one a genuine leftover duplicate.
 *   - `tooRecent` — otherwise a candidate, but created too recently to act on.
 *   - `unresolved` — unreferenced, but nothing proved it a duplicate:
 *     report only, never act, since FILE-1's hand-uploaded files, and a
 *     same-named-and-sized file that merely never made it into any tracked
 *     course's store, both land here.
 *   - `needsReattach` — attachments whose own tracked file is *not* found
 *     in their course's vector store. None of that attachment's candidate
 *     duplicates are ever used to prove a deletion (condition 3): the
 *     "original" would itself be missing, and pruning around it would
 *     leave the course grounded on nothing.
 *
 * A file that is itself referenced (condition 1 fails) is not a candidate
 * at all and appears in none of these buckets.
 *
 * `verifyMembership(vectorStoreId, fileId)` resolves to `true` (attached),
 * `false` (a clean 404 — definitely not attached) or `null` (the check
 * itself failed and the answer is unknown) — `null` is treated the same as
 * `false` for a deletion decision: an unproven duplicate is never deleted
 * just because the network call that would have disproven it happened to
 * fail. `now` defaults to `Date.now()` but takes an explicit value so a
 * test never depends on the wall clock.
 */
export async function classifyFiles(
  files,
  attachments,
  { now = Date.now(), verifyMembership } = {}
) {
  const referenced = referencedFileIds(attachments)
  const deletable = []
  const tooRecent = []
  const unresolved = []
  const needsReattachIds = new Set()
  const needsReattach = []

  // Whether a proving attachment's own tracked file is actually in its
  // course's store — memoized per attachment id, since several candidate
  // duplicates typically share the same proving attachment and this
  // question has one answer regardless of which candidate is asking it.
  const keptPresentCache = new Map()
  async function isKeptPresent(attachment) {
    if (!attachment.courseVectorStoreId) return false
    if (!keptPresentCache.has(attachment.id)) {
      keptPresentCache.set(
        attachment.id,
        verifyMembership(
          attachment.courseVectorStoreId,
          attachment.providerFileId
        )
      )
    }
    return keptPresentCache.get(attachment.id)
  }

  for (const file of files) {
    if (referenced.has(file.id)) continue
    if (isTooRecent(file, now)) {
      tooRecent.push(file)
      continue
    }

    const candidateAttachments = attachments.filter((attachment) =>
      matchesAttachment(file, attachment)
    )

    let provedBy = null
    for (const attachment of candidateAttachments) {
      const keptPresent = await isKeptPresent(attachment)
      if (keptPresent !== true) {
        // Condition 3 fails (or is unproven) — this attachment can never
        // prove a deletion, and needs a human's attention of its own.
        if (keptPresent === false && !needsReattachIds.has(attachment.id)) {
          needsReattachIds.add(attachment.id)
          needsReattach.push(attachment)
        }
        continue
      }

      const candidatePresent = await verifyMembership(
        attachment.courseVectorStoreId,
        file.id
      )
      if (candidatePresent === true) {
        provedBy = attachment
        break
      }
    }

    if (provedBy) {
      deletable.push({ file, attachment: provedBy })
    } else {
      unresolved.push(file)
    }
  }

  return { deletable, tooRecent, unresolved, needsReattach }
}

// --- the network half --------------------------------------------------------

/**
 * One OpenAI API call, bounded by `timeoutMs` the same way
 * `packages/openai/src/http.ts`'s own `postJson` bounds every call it
 * makes — a stalled request must not hang the whole run. Returns
 * `{ status, ok, body }` on any response, 2xx or not; callers decide what a
 * given status means (a 404 is "success" for the vector-store removal
 * below, but not for anything else).
 */
async function callOpenAi(
  method,
  path,
  { apiKey, baseUrl, fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchFn(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
    const text = await response.text()
    const body = text ? JSON.parse(text) : undefined
    return { status: response.status, ok: response.ok, body }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Every OpenAI file with `purpose: 'assistants'`, across every page.
 *
 * The documented `GET /v1/files` response is `{"object":"list","data":[…]}`
 * — no `has_more`/`last_id` at all; those belong to the newer, Assistants-
 * era list endpoints (`/vector_stores`, `/vector_stores/{id}/files`), not
 * this one. Relying on `has_more` here silently stopped after page one on
 * the documented shape, reporting a full account as fully examined after
 * seeing only its first `limit` files. Completeness is inferred from the
 * page itself instead: a page smaller than what was asked for is the last
 * one, mirroring how the official client pages `/files`, by the last item's
 * own id via `after`. A page that comes back exactly `limit`-sized but with
 * no new id to cursor on (a proxy that never advances, or one that reports
 * `has_more: true` behind a constant `last_id`) stops rather than looping
 * forever — there is no cursor left that would ever change the request.
 */
export async function listAllFiles(options) {
  const limit = options.limit ?? DEFAULT_FILES_PAGE_LIMIT
  const files = []
  let after
  for (;;) {
    // The cursor this specific request is sent with — captured before the
    // call, so the "did this actually make progress" check below compares
    // against what was *asked for*, not against a value this same
    // iteration is about to overwrite.
    const requestAfter = after
    const query = requestAfter
      ? `?purpose=assistants&limit=${limit}&after=${requestAfter}`
      : `?purpose=assistants&limit=${limit}`
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
    const page = body?.data ?? []
    const lastId = page[page.length - 1]?.id

    // A page whose own last id equals the cursor we just requested *after*
    // means the API (or a proxy in front of it) handed back the same tail
    // again without advancing — a `has_more: true` with a static `last_id`
    // is exactly this. Stopping here, before ever pushing this repeat page,
    // is what turns "loop forever" into "stop, having made no further
    // progress", without silently double-counting the repeated files.
    if (requestAfter && lastId === requestAfter) break

    files.push(...page)
    if (page.length < limit) break
    if (!lastId) break
    after = lastId
  }
  return files
}

/**
 * Whether `fileId` is currently attached to `vectorStoreId` —
 * `GET /vector_stores/{vectorStoreId}/files/{fileId}`. `true` on a 200,
 * `false` on a clean 404 ("definitely not attached"), `null` on anything
 * else (an unexpected status, or the call itself throwing) — `null` is a
 * distinct "the network could not answer this" outcome from `false`, so a
 * caller never mistakes "the check failed" for "this proves not attached".
 */
export async function verifyVectorStoreMembership(
  vectorStoreId,
  fileId,
  options
) {
  try {
    const { ok, status } = await callOpenAi(
      'GET',
      `/vector_stores/${vectorStoreId}/files/${fileId}`,
      options
    )
    if (ok) return true
    if (status === 404) return false
    return null
  } catch {
    return null
  }
}

/**
 * Removes one deletable file from the specific vector store that proved it
 * a genuine duplicate (`entry.attachment.courseVectorStoreId` — the store
 * `classifyFiles` actually found this file attached to, this file's own
 * module comment's condition 4), then the file object itself — in that
 * order, so no dangling vector-store entry is ever left behind pointing at
 * a file that no longer exists.
 *
 * Returns `{ ok: true }` or `{ ok: false, error }`; never throws, so one
 * file's failure cannot abort the run — `pruneAll`, below, is what collects
 * these across every file. If the vector-store removal already succeeded
 * and only the file-object deletion then fails (a 429 on the very last
 * call, say), the error names that split explicitly — re-running finds this
 * file's vector-store entry already gone and only needs to delete the file
 * object, which matters to whoever reads the failure and decides what a
 * retry will actually do.
 */
export async function deleteFileEverywhere(entry, options) {
  const { file, attachment } = entry
  const vectorStoreId = attachment.courseVectorStoreId
  let removedFromStore = false
  try {
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
    removedFromStore = true

    const deletion = await callOpenAi('DELETE', `/files/${file.id}`, options)
    if (!deletion.ok) {
      throw new Error(
        `DELETE /files/${file.id} -> ${deletion.status}: ${JSON.stringify(deletion.body)}` +
          ' (the vector-store removal above already succeeded — a retry only needs to delete the file object)'
      )
    }
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: removedFromStore
        ? message.includes('already succeeded')
          ? message
          : `${message} (the vector-store removal already succeeded before this failed)`
        : message,
    }
  }
}

/**
 * Prunes every deletable file, one at a time, collecting every failure
 * rather than stopping at the first — the same discipline
 * `scripts/deploy.sh`'s own `reload_everything` uses. Returns
 * `{ succeeded, failed }`, where `failed` pairs each entry with its error.
 */
export async function pruneAll(deletableEntries, options) {
  const succeeded = []
  const failed = []
  for (const entry of deletableEntries) {
    const result = await deleteFileEverywhere(entry, options)
    if (result.ok) {
      succeeded.push(entry)
    } else {
      failed.push({ entry, error: result.error })
    }
  }
  return { succeeded, failed }
}

// --- the database half -------------------------------------------------------

/**
 * Reads the facts this script is checked against, straight off the
 * database rather than through `@bloombot/db` (this file's own module
 * comment: no dependency on the workspace's own TypeScript packages). Opens
 * read-only — this script only ever proves things against the row data, it
 * never writes to it. `course_attachments` is joined against `courses` so
 * each attachment carries the one thing `course_attachments` itself does
 * not: its own course's vector store id, which condition 3/4's membership
 * checks need.
 */
export function readTrackedState(databasePath) {
  const db = new BetterSqlite3(databasePath, {
    readonly: true,
    fileMustExist: true,
  })
  try {
    const attachments = db
      .prepare(
        `SELECT
           ca.id AS id,
           ca.filename AS filename,
           ca.size_bytes AS sizeBytes,
           ca.provider_file_id AS providerFileId,
           ca.course_id AS courseId,
           ca.organization_id AS organizationId,
           c.vector_store_id AS courseVectorStoreId
         FROM course_attachments ca
         JOIN courses c ON c.id = ca.course_id`
      )
      .all()
    const [{ vectorStoreCount }] = db
      .prepare(
        'SELECT COUNT(DISTINCT vector_store_id) AS vectorStoreCount FROM courses WHERE vector_store_id IS NOT NULL'
      )
      .all()
    return { attachments, vectorStoreCount }
  } finally {
    db.close()
  }
}

// --- reporting ---------------------------------------------------------------

/** One human-readable line per file. */
function describeFile(file) {
  return `${file.filename} (id: ${file.id}, ${file.bytes} bytes)`
}

/**
 * One line per deletable entry, auditable on its own: which course,
 * organization and attachment proved it, and which vector store it was
 * actually found in — an operator must be able to spot a cross-course (or
 * cross-organization) coincidence before ever typing `--apply`, not
 * discover one after the fact.
 */
function describeDeletable({ file, attachment }) {
  return (
    `${describeFile(file)} — proved by attachment ${attachment.id} ` +
    `(course: ${attachment.courseId}, organization: ${attachment.organizationId}, ` +
    `found in vector store: ${attachment.courseVectorStoreId})`
  )
}

/** One line per attachment whose own tracked file was not found in its course's store. */
function describeNeedsReattach(attachment) {
  return (
    `attachment ${attachment.id} (course: ${attachment.courseId}, ` +
    `organization: ${attachment.organizationId}) — its own provider_file_id ` +
    `${attachment.providerFileId} is not attached to vector store ` +
    `${attachment.courseVectorStoreId}; this needs a re-attach, not pruning`
  )
}

/** Prints the plan — what this run found, before anything (if anything) is deleted. Makes a dry run's "nothing changed" obvious by construction: it never mentions deleting anything unless `apply` is true. */
function printPlan({
  databasePath,
  attachmentCount,
  vectorStoreCount,
  files,
  deletable,
  tooRecent,
  unresolved,
  needsReattach,
  apply,
}) {
  // Echoed first, so a run against a stale `.env` (a fixture database, say)
  // is visible in the plan itself rather than producing a confident-looking
  // report built from the wrong rows with no signal at all.
  console.log(
    `Database: ${databasePath} (${attachmentCount} attachment row(s), ${vectorStoreCount} distinct known vector store(s))`
  )
  console.log(`Examined ${files.length} file(s) with purpose "assistants".`)

  console.log(
    `${deletable.length} deletable duplicate(s)${apply ? '' : ' (dry run — would be removed with --apply)'}:`
  )
  for (const entry of deletable)
    console.log(`  DELETE ${describeDeletable(entry)}`)

  console.log(`${tooRecent.length} skipped as created within the last hour:`)
  for (const file of tooRecent) console.log(`  SKIP   ${describeFile(file)}`)

  console.log(
    `${unresolved.length} left alone — unreferenced but not a provable duplicate ` +
      '(may be hand-uploaded course material; a human should look):'
  )
  for (const file of unresolved) console.log(`  REVIEW ${describeFile(file)}`)

  console.log(
    `${needsReattach.length} attachment(s) whose tracked file is missing from its own course's vector store — needs re-attaching, not pruning:`
  )
  for (const attachment of needsReattach) {
    console.log(`  REATTACH ${describeNeedsReattach(attachment)}`)
  }
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
    for (const { entry, error } of failed) {
      console.error(`  FAILED ${describeDeletable(entry)}: ${error}`)
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
  databasePath,
  files,
  attachments,
  vectorStoreCount,
  options,
  verifyMembership,
  now,
}) {
  const { deletable, tooRecent, unresolved, needsReattach } =
    await classifyFiles(files, attachments, { now, verifyMembership })

  printPlan({
    databasePath,
    attachmentCount: attachments.length,
    vectorStoreCount,
    files,
    deletable,
    tooRecent,
    unresolved,
    needsReattach,
    apply,
  })

  if (!apply) {
    printSummary({ apply, succeeded: [], failed: [] })
    return 0
  }

  const { succeeded, failed } = await pruneAll(deletable, options)
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
  const { attachments, vectorStoreCount } = readTrackedState(databasePath)

  const files = await listAllFiles(options)

  process.exitCode = await execute({
    apply,
    databasePath,
    files,
    attachments,
    vectorStoreCount,
    options,
    verifyMembership: (vectorStoreId, fileId) =>
      verifyVectorStoreMembership(vectorStoreId, fileId, options),
  })
}

// Only run when invoked directly, so the test can import the pure functions.
if (process.argv[1]?.endsWith('prune-orphan-openai-files.mjs')) {
  await main()
}
