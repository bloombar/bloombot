/**
 * Tests for `scripts/prune-orphan-openai-files.mjs`. The safety rule is the
 * heart of the slice, so the classifier gets one test per condition in it
 * (that file's own module comment has the full rule); everything else —
 * pagination, ordering, 404-as-success, one failure not blocking the rest,
 * dry-run-by-default, timeouts — is exercised against a stubbed `fetch`,
 * the same approach `scripts/reparent-orphan-channels.test.mjs` takes with
 * Discord. The database half is exercised against a real, throwaway
 * SQLite file under the OS's own temp directory (`os.tmpdir()`, the same
 * as every other script's tests here) — `data/data.db` is never touched.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'

import {
  DEFAULT_TIMEOUT_MS,
  RECENT_FILE_GRACE_MS,
  classifyFiles,
  deleteFileEverywhere,
  execute,
  listAllFiles,
  matchesAttachment,
  parseArgs,
  pruneAll,
  readTrackedState,
  resolveDatabasePath,
  verifyVectorStoreMembership,
} from './prune-orphan-openai-files.mjs'

const NOW = Date.parse('2026-09-10T12:00:00Z')
const HOUR = 60 * 60 * 1000

/** An OpenAI file fixture, `createdAt` given as milliseconds before `NOW` (defaults to two hours, safely past the one-hour grace window). */
const openAiFile = (id, filename, bytes, { ageMs = 2 * HOUR } = {}) => ({
  id,
  filename,
  bytes,
  purpose: 'assistants',
  created_at: Math.floor((NOW - ageMs) / 1000),
})

/** A joined `course_attachments`+`courses` row fixture, the shape `readTrackedState` produces. */
const attachment = (
  id,
  filename,
  sizeBytes,
  providerFileId,
  {
    courseId = `course-${id}`,
    organizationId = `org-${id}`,
    courseVectorStoreId = `vs-${id}`,
  } = {}
) => ({
  id,
  filename,
  sizeBytes,
  providerFileId,
  courseId,
  organizationId,
  courseVectorStoreId,
})

/** A minimal `Response`-shaped stub. */
function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  }
}

/** A `verifyMembership` stub: `true` for every (vectorStoreId, fileId) pair in `present`, `false` otherwise — the shape `classifyFiles` itself is tested against, with no network at all. */
function membershipStub(present) {
  return async (vectorStoreId, fileId) =>
    present.some(([vs, id]) => vs === vectorStoreId && id === fileId)
}

// --- parseArgs ---------------------------------------------------------------

test('parseArgs defaults to a dry run', () => {
  assert.deepEqual(parseArgs([]), { apply: false })
})

test('--apply is the only thing that enables writes', () => {
  assert.deepEqual(parseArgs(['--apply']), { apply: true })
})

test('parseArgs rejects an unrecognised argument', () => {
  assert.throws(() => parseArgs(['--bogus']), /unrecognised argument/)
})

// --- resolveDatabasePath ------------------------------------------------------

test('resolveDatabasePath falls back to the same default CONFIG.DATABASE_PATH uses', () => {
  assert.equal(resolveDatabasePath({}), './data/data.db')
})

test('resolveDatabasePath honours an explicit override', () => {
  assert.equal(
    resolveDatabasePath({ DATABASE_PATH: 'tmp/prune-test.db' }),
    'tmp/prune-test.db'
  )
})

// --- matchesAttachment — pins the two clauses classifyFiles' own referenced-set exclusion otherwise hides ---

test('matchesAttachment is false when providerFileId is null, even with a filename+size match', () => {
  const file = openAiFile('file_new', 'syllabus.pdf', 1000)
  const pending = attachment('a1', 'syllabus.pdf', 1000, null)
  assert.equal(matchesAttachment(file, pending), false)
})

test('matchesAttachment is false when providerFileId equals the candidate file’s own id', () => {
  const file = openAiFile('file_x', 'syllabus.pdf', 1000)
  const self = attachment('a1', 'syllabus.pdf', 1000, 'file_x')
  assert.equal(matchesAttachment(file, self), false)
})

test('matchesAttachment is true for a genuine filename+size match under a different id', () => {
  const file = openAiFile('file_new', 'syllabus.pdf', 1000)
  const other = attachment('a1', 'syllabus.pdf', 1000, 'file_recorded')
  assert.equal(matchesAttachment(file, other), true)
})

// --- classifyFiles — the safety rule ------------------------------------------

test('a file matching all conditions (referenced elsewhere, kept copy attached, candidate itself attached) is deletable', async () => {
  const file = openAiFile('file_new', 'syllabus.pdf', 1000)
  const proving = attachment('a1', 'syllabus.pdf', 1000, 'file_recorded')
  const verifyMembership = membershipStub([
    ['vs-a1', 'file_recorded'],
    ['vs-a1', 'file_new'],
  ])
  const { deletable, tooRecent, unresolved, needsReattach } =
    await classifyFiles([file], [proving], { now: NOW, verifyMembership })
  assert.deepEqual(deletable, [{ file, attachment: proving }])
  assert.deepEqual(tooRecent, [])
  assert.deepEqual(unresolved, [])
  assert.deepEqual(needsReattach, [])
})

test('a file whose id IS referenced is not deletable, and not reported at all', async () => {
  const file = openAiFile('file_recorded', 'syllabus.pdf', 1000)
  const proving = attachment('a1', 'syllabus.pdf', 1000, 'file_recorded')
  const verifyMembership = async () => true
  const { deletable, unresolved, needsReattach } = await classifyFiles(
    [file],
    [proving],
    { now: NOW, verifyMembership }
  )
  assert.deepEqual(deletable, [])
  assert.deepEqual(unresolved, [])
  assert.deepEqual(needsReattach, [])
})

test('an unreferenced file with no filename+size match is left alone, not deleted', async () => {
  const file = openAiFile('file_mystery', 'vendor-upload.pdf', 5000)
  const proving = attachment('a1', 'syllabus.pdf', 1000, 'file_recorded')
  const verifyMembership = async () => true
  const { deletable, unresolved } = await classifyFiles([file], [proving], {
    now: NOW,
    verifyMembership,
  })
  assert.deepEqual(deletable, [])
  assert.deepEqual(unresolved, [file])
})

test('a filename match with a differing size is not deletable', async () => {
  const file = openAiFile('file_new', 'syllabus.pdf', 999)
  const proving = attachment('a1', 'syllabus.pdf', 1000, 'file_recorded')
  const verifyMembership = async () => true
  const { deletable, unresolved } = await classifyFiles([file], [proving], {
    now: NOW,
    verifyMembership,
  })
  assert.deepEqual(deletable, [])
  assert.deepEqual(unresolved, [file])
})

test('a size match with a differing filename is not deletable', async () => {
  const file = openAiFile('file_new', 'other.pdf', 1000)
  const proving = attachment('a1', 'syllabus.pdf', 1000, 'file_recorded')
  const verifyMembership = async () => true
  const { deletable, unresolved } = await classifyFiles([file], [proving], {
    now: NOW,
    verifyMembership,
  })
  assert.deepEqual(deletable, [])
  assert.deepEqual(unresolved, [file])
})

test('a candidate created within the last hour is skipped, even when it would otherwise be deletable', async () => {
  const file = openAiFile('file_new', 'syllabus.pdf', 1000, {
    ageMs: RECENT_FILE_GRACE_MS - 1000,
  })
  const proving = attachment('a1', 'syllabus.pdf', 1000, 'file_recorded')
  const verifyMembership = async () => true
  const { deletable, tooRecent, unresolved } = await classifyFiles(
    [file],
    [proving],
    { now: NOW, verifyMembership }
  )
  assert.deepEqual(deletable, [])
  assert.deepEqual(unresolved, [])
  assert.deepEqual(tooRecent, [file])
})

test('a candidate with a missing/unparseable created_at is treated as too recent, never as eligible', async () => {
  const file = {
    ...openAiFile('file_new', 'syllabus.pdf', 1000),
    created_at: undefined,
  }
  const proving = attachment('a1', 'syllabus.pdf', 1000, 'file_recorded')
  const verifyMembership = async () => true
  const { deletable, tooRecent } = await classifyFiles([file], [proving], {
    now: NOW,
    verifyMembership,
  })
  assert.deepEqual(deletable, [])
  assert.deepEqual(tooRecent, [file])
})

// --- the cross-organization/course collision this predicate must refuse -----

test('a candidate that matches another course’s attachment by filename+size, but was never actually attached to THAT course’s store, is left alone — not deleted', async () => {
  // Org A tracks chapter1.pdf (1048576 bytes) as file_A, attached to vs-A.
  // Org B's course has its own vendor-typed vector store and an instructor
  // hand-uploaded an identical-looking PDF as file_B, which appears in no
  // course_attachments row at all. file_B is unreferenced and matches org
  // A's row on filename+size — but was never attached to vs-A, so it must
  // not be deleted on the strength of that coincidence.
  const fileB = openAiFile('file_B', 'chapter1.pdf', 1048576)
  const orgAAttachment = attachment('a-A', 'chapter1.pdf', 1048576, 'file_A', {
    courseId: 'course-A',
    organizationId: 'org-A',
    courseVectorStoreId: 'vs-A',
  })
  // file_A (the kept copy) IS attached to vs-A; file_B never was.
  const verifyMembership = membershipStub([['vs-A', 'file_A']])
  const { deletable, unresolved } = await classifyFiles(
    [fileB],
    [orgAAttachment],
    { now: NOW, verifyMembership }
  )
  assert.deepEqual(deletable, [])
  assert.deepEqual(unresolved, [fileB])
})

test('a genuine duplicate attached to the SAME course’s store as the tracked file is deletable', async () => {
  const duplicate = openAiFile('file_dup', 'chapter1.pdf', 1048576)
  const proving = attachment('a-A', 'chapter1.pdf', 1048576, 'file_A', {
    courseId: 'course-A',
    organizationId: 'org-A',
    courseVectorStoreId: 'vs-A',
  })
  const verifyMembership = membershipStub([
    ['vs-A', 'file_A'],
    ['vs-A', 'file_dup'],
  ])
  const { deletable } = await classifyFiles([duplicate], [proving], {
    now: NOW,
    verifyMembership,
  })
  assert.deepEqual(deletable, [{ file: duplicate, attachment: proving }])
})

// --- the "kept copy itself is missing" case (FILE-8's bug, inside out) -------

test('when the tracked provider_file_id is NOT in the course’s store, no candidate is proved deletable and the attachment is reported for re-attach', async () => {
  const orphanCopy = openAiFile('file_orphan_dup', 'notes.pdf', 42)
  // provider_file_id (file_kept) was recorded at upload, before the attach
  // — and the attach for THIS id never actually landed, even though
  // earlier retries (file_orphan_dup among them) did attach successfully.
  const proving = attachment('a1', 'notes.pdf', 42, 'file_kept', {
    courseId: 'course-1',
    organizationId: 'org-1',
    courseVectorStoreId: 'vs-1',
  })
  const verifyMembership = membershipStub([['vs-1', 'file_orphan_dup']]) // file_kept is absent
  const { deletable, unresolved, needsReattach } = await classifyFiles(
    [orphanCopy],
    [proving],
    { now: NOW, verifyMembership }
  )
  assert.deepEqual(deletable, [])
  assert.deepEqual(unresolved, [orphanCopy])
  assert.deepEqual(needsReattach, [proving])
})

test('when the tracked provider_file_id IS in the course’s store, no re-attach is reported', async () => {
  const file = openAiFile('file_new', 'notes.pdf', 42)
  const proving = attachment('a1', 'notes.pdf', 42, 'file_kept', {
    courseVectorStoreId: 'vs-1',
  })
  const verifyMembership = membershipStub([
    ['vs-1', 'file_kept'],
    ['vs-1', 'file_new'],
  ])
  const { needsReattach } = await classifyFiles([file], [proving], {
    now: NOW,
    verifyMembership,
  })
  assert.deepEqual(needsReattach, [])
})

// --- listAllFiles — pagination ------------------------------------------------

test('listAllFiles follows every page of the DOCUMENTED /files response shape (no has_more/last_id field at all)', async () => {
  const calls = []
  const fetchFn = async (url) => {
    calls.push(url)
    if (!url.includes('after=')) {
      // The real, documented shape: {"object":"list","data":[...]} — no
      // has_more, no last_id. A page exactly `limit`-sized still means
      // "there may be more" purely by size.
      return jsonResponse({ data: [openAiFile('file_1', 'a.pdf', 1)] })
    }
    return jsonResponse({ data: [] })
  }
  const files = await listAllFiles({
    apiKey: 'k',
    baseUrl: 'https://api.example',
    fetchFn,
    limit: 1,
  })
  assert.deepEqual(
    files.map((f) => f.id),
    ['file_1']
  )
  assert.equal(calls.length, 2)
  assert.match(calls[1], /after=file_1/)
})

test('listAllFiles keeps paging across several full pages, not just the first', async () => {
  const pages = [
    [openAiFile('file_1', 'a.pdf', 1)],
    [openAiFile('file_2', 'b.pdf', 2)],
    [openAiFile('file_3', 'c.pdf', 3)], // a partial (smaller-than-limit) page ends it
  ]
  let call = 0
  const fetchFn = async () => {
    const page = pages[call]
    call += 1
    return jsonResponse({ data: page })
  }
  const files = await listAllFiles({
    apiKey: 'k',
    baseUrl: 'https://api.example',
    fetchFn,
    limit: 1,
  })
  assert.deepEqual(
    files.map((f) => f.id),
    ['file_1', 'file_2', 'file_3']
  )
})

test('listAllFiles stops rather than looping forever against a proxy that returns a full page but never advances the cursor', async () => {
  let calls = 0
  const fetchFn = async () => {
    calls += 1
    // Always a full, `limit`-sized page, always the same last id — no
    // cursor progress is possible, so this must not be allowed to loop.
    return jsonResponse({
      data: [openAiFile('file_static', 'a.pdf', 1)],
      has_more: true,
    })
  }
  const files = await listAllFiles({
    apiKey: 'k',
    baseUrl: 'https://api.example',
    fetchFn,
    limit: 1,
  })
  // The first request (cursor-less) has nothing to compare against, so it
  // genuinely cannot tell yet that the proxy is stuck — that only becomes
  // visible on the second request, once `after` has been set and the
  // response's own last id turns out to equal it. Two calls, one file: no
  // third call, and no duplicate of `file_static` pushed twice.
  assert.deepEqual(
    files.map((f) => f.id),
    ['file_static']
  )
  assert.equal(calls, 2)
})

// --- ordering, 404-as-success, partial failure ---------------------------

test('deleteFileEverywhere removes the vector-store entry before the file object', async () => {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push(`${init.method} ${url}`)
    return jsonResponse({})
  }
  const file = openAiFile('file_1', 'a.pdf', 1)
  const proving = attachment('a1', 'a.pdf', 1, 'file_kept', {
    courseVectorStoreId: 'vs_1',
  })
  const result = await deleteFileEverywhere(
    { file, attachment: proving },
    { apiKey: 'k', baseUrl: 'https://api.example', fetchFn }
  )
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [
    'DELETE https://api.example/vector_stores/vs_1/files/file_1',
    'DELETE https://api.example/files/file_1',
  ])
})

test('a 404 removing the vector-store entry is treated as success, and the file is still deleted', async () => {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push(`${init.method} ${url}`)
    if (url.includes('/vector_stores/')) return jsonResponse({}, 404)
    return jsonResponse({})
  }
  const file = openAiFile('file_1', 'a.pdf', 1)
  const proving = attachment('a1', 'a.pdf', 1, 'file_kept', {
    courseVectorStoreId: 'vs_1',
  })
  const result = await deleteFileEverywhere(
    { file, attachment: proving },
    { apiKey: 'k', baseUrl: 'https://api.example', fetchFn }
  )
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [
    'DELETE https://api.example/vector_stores/vs_1/files/file_1',
    'DELETE https://api.example/files/file_1',
  ])
})

test('a failure deleting the file object after the vector-store removal already succeeded says so in the error', async () => {
  const fetchFn = async (url) => {
    if (url.includes('/vector_stores/')) return jsonResponse({})
    return jsonResponse({ error: 'rate limited' }, 429)
  }
  const file = openAiFile('file_1', 'a.pdf', 1)
  const proving = attachment('a1', 'a.pdf', 1, 'file_kept', {
    courseVectorStoreId: 'vs_1',
  })
  const result = await deleteFileEverywhere(
    { file, attachment: proving },
    { apiKey: 'k', baseUrl: 'https://api.example', fetchFn }
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /vector-store removal above already succeeded/)
})

test("one file's failure does not prevent the others being processed, and the run reports it", async () => {
  const fileA = openAiFile('file_a', 'a.pdf', 1)
  const fileB = openAiFile('file_b', 'b.pdf', 2)
  const provingA = attachment('a-a', 'a.pdf', 1, 'kept_a', {
    courseVectorStoreId: 'vs_1',
  })
  const provingB = attachment('a-b', 'b.pdf', 2, 'kept_b', {
    courseVectorStoreId: 'vs_1',
  })
  const fetchFn = async (url, init) => {
    if (init.method === 'DELETE' && url.includes('file_a')) {
      return jsonResponse({ error: 'boom' }, 500)
    }
    return jsonResponse({})
  }
  const { succeeded, failed } = await pruneAll(
    [
      { file: fileA, attachment: provingA },
      { file: fileB, attachment: provingB },
    ],
    { apiKey: 'k', baseUrl: 'https://api.example', fetchFn }
  )
  assert.deepEqual(
    succeeded.map((entry) => entry.file.id),
    ['file_b']
  )
  assert.equal(failed.length, 1)
  assert.equal(failed[0].entry.file.id, 'file_a')
})

// --- verifyVectorStoreMembership ----------------------------------------------

test('verifyVectorStoreMembership is true on a 200', async () => {
  const fetchFn = async () => jsonResponse({ id: 'file_1' })
  const result = await verifyVectorStoreMembership('vs_1', 'file_1', {
    apiKey: 'k',
    baseUrl: 'https://api.example',
    fetchFn,
  })
  assert.equal(result, true)
})

test('verifyVectorStoreMembership is false on a clean 404', async () => {
  const fetchFn = async () => jsonResponse({}, 404)
  const result = await verifyVectorStoreMembership('vs_1', 'file_1', {
    apiKey: 'k',
    baseUrl: 'https://api.example',
    fetchFn,
  })
  assert.equal(result, false)
})

test('verifyVectorStoreMembership is null (unknown) on an unexpected status or a thrown error, never treated as a match', async () => {
  const fetchFn500 = async () => jsonResponse({}, 500)
  assert.equal(
    await verifyVectorStoreMembership('vs_1', 'file_1', {
      apiKey: 'k',
      baseUrl: 'https://api.example',
      fetchFn: fetchFn500,
    }),
    null
  )
  const fetchFnThrows = async () => {
    throw new Error('network down')
  }
  assert.equal(
    await verifyVectorStoreMembership('vs_1', 'file_1', {
      apiKey: 'k',
      baseUrl: 'https://api.example',
      fetchFn: fetchFnThrows,
    }),
    null
  )
})

// --- callOpenAi's timeout, exercised through deleteFileEverywhere ------------

test('a stalled request is aborted after its timeout rather than hanging the run', async () => {
  const fetchFn = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
      // Never resolves on its own — only the abort settles this promise.
    })
  const file = openAiFile('file_1', 'a.pdf', 1)
  const proving = attachment('a1', 'a.pdf', 1, 'file_kept', {
    courseVectorStoreId: 'vs_1',
  })
  const start = Date.now()
  const result = await deleteFileEverywhere(
    { file, attachment: proving },
    { apiKey: 'k', baseUrl: 'https://api.example', fetchFn, timeoutMs: 20 }
  )
  assert.equal(result.ok, false)
  // Bounded by the 20ms timeoutMs passed above, not DEFAULT_TIMEOUT_MS.
  assert.ok(Date.now() - start < DEFAULT_TIMEOUT_MS)
})

// --- dry run, end to end -------------------------------------------------------

test('dry run issues zero DELETE calls, even with a genuinely deletable file present', async () => {
  const file = openAiFile('file_new', 'syllabus.pdf', 1000)
  const proving = attachment('a1', 'syllabus.pdf', 1000, 'file_recorded', {
    courseVectorStoreId: 'vs_1',
  })
  let deleteCalls = 0
  const fetchFn = async (url, init) => {
    if (init?.method === 'DELETE') deleteCalls += 1
    return jsonResponse({})
  }
  const verifyMembership = membershipStub([
    ['vs_1', 'file_recorded'],
    ['vs_1', 'file_new'],
  ])
  const exitCode = await execute({
    apply: false,
    databasePath: 'tmp/does-not-matter.db',
    files: [file],
    attachments: [proving],
    vectorStoreCount: 1,
    options: { apiKey: 'k', baseUrl: 'https://api.example', fetchFn },
    verifyMembership,
    now: NOW,
  })
  assert.equal(exitCode, 0)
  assert.equal(deleteCalls, 0)
})

test('execute applies a deletable file and exits non-zero when one fails', async () => {
  const good = openAiFile('file_good', 'a.pdf', 1)
  const bad = openAiFile('file_bad', 'b.pdf', 2)
  const provingGood = attachment('a-good', 'a.pdf', 1, 'kept_good', {
    courseVectorStoreId: 'vs_1',
  })
  const provingBad = attachment('a-bad', 'b.pdf', 2, 'kept_bad', {
    courseVectorStoreId: 'vs_1',
  })
  const fetchFn = async (url, init) => {
    if (init.method === 'DELETE' && url.includes('file_bad')) {
      return jsonResponse({}, 500)
    }
    return jsonResponse({})
  }
  const verifyMembership = membershipStub([
    ['vs_1', 'kept_good'],
    ['vs_1', 'file_good'],
    ['vs_1', 'kept_bad'],
    ['vs_1', 'file_bad'],
  ])
  const exitCode = await execute({
    apply: true,
    databasePath: 'tmp/does-not-matter.db',
    files: [good, bad],
    attachments: [provingGood, provingBad],
    vectorStoreCount: 1,
    options: { apiKey: 'k', baseUrl: 'https://api.example', fetchFn },
    verifyMembership,
    now: NOW,
  })
  assert.equal(exitCode, 1)
})

// --- readTrackedState — the database half -------------------------------------

test('readTrackedState reads course_attachments joined with courses from a real tmp database, opened genuinely read-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bloombot-prune-test-'))
  const dbPath = join(dir, 'test.db')
  try {
    const setup = new BetterSqlite3(dbPath)
    setup.exec(`
      CREATE TABLE courses (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        vector_store_id TEXT
      );
      CREATE TABLE course_attachments (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        provider_file_id TEXT
      );
      INSERT INTO courses (id, organization_id, vector_store_id) VALUES
        ('course-1', 'org-1', 'vs_1'),
        ('course-2', 'org-1', 'vs_1'),
        ('course-3', 'org-2', NULL);
      INSERT INTO course_attachments
        (id, course_id, organization_id, filename, size_bytes, provider_file_id)
        VALUES ('att-1', 'course-1', 'org-1', 'syllabus.pdf', 1000, 'file_recorded');
    `)
    setup.close()

    // Deny writes at the filesystem level — the test this replaces opened
    // its own, separate connection and asserted THAT one refused writes,
    // which pins nothing about readTrackedState itself (flipping its
    // `readonly: true` to `false` left that old test green). chmod pins the
    // actual function: if readTrackedState ever opened for read-write, this
    // call would throw (EACCES/SQLITE_READONLY), not merely "could write".
    chmodSync(dbPath, 0o444)
    const mtimeBefore = statSync(dbPath).mtimeMs

    const { attachments, vectorStoreCount } = readTrackedState(dbPath)

    assert.deepEqual(attachments, [
      {
        id: 'att-1',
        filename: 'syllabus.pdf',
        sizeBytes: 1000,
        providerFileId: 'file_recorded',
        courseId: 'course-1',
        organizationId: 'org-1',
        courseVectorStoreId: 'vs_1',
      },
    ])
    assert.equal(vectorStoreCount, 1)

    // A read-only open leaves the file itself untouched — no `-wal` sidecar,
    // no change in mtime.
    assert.equal(existsSync(`${dbPath}-wal`), false)
    assert.equal(statSync(dbPath).mtimeMs, mtimeBefore)
  } finally {
    chmodSync(dbPath, 0o644)
    rmSync(dir, { recursive: true, force: true })
  }
})
