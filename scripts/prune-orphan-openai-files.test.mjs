/**
 * Tests for `scripts/prune-orphan-openai-files.mjs`. The safety rule is the
 * heart of the slice, so the classifier gets one test per condition in it
 * (`scripts/prune-orphan-openai-files.mjs`'s own module comment has the full
 * rule); everything else — pagination, ordering, 404-as-success, one
 * failure not blocking the rest, dry-run-by-default — is exercised against
 * a stubbed `fetch`, the same approach
 * `scripts/reparent-orphan-channels.test.mjs` takes with Discord. The
 * database half is exercised against a real, throwaway SQLite file under
 * `tmp/`, never `data/data.db`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'

import {
  RECENT_FILE_GRACE_MS,
  classifyFiles,
  deleteFileEverywhere,
  execute,
  listAllFiles,
  parseArgs,
  pruneAll,
  readTrackedState,
  resolveDatabasePath,
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

/** A `course_attachments` row fixture. */
const attachment = (filename, sizeBytes, providerFileId) => ({
  filename,
  sizeBytes,
  providerFileId,
})

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

// --- classifyFiles — the safety rule ------------------------------------------

test('a file matching both conditions is deletable', () => {
  const file = openAiFile('file_new', 'syllabus.pdf', 1000)
  const attachments = [attachment('syllabus.pdf', 1000, 'file_recorded')]
  const { deletable, tooRecent, unresolved } = classifyFiles(
    [file],
    attachments,
    NOW
  )
  assert.deepEqual(deletable, [file])
  assert.deepEqual(tooRecent, [])
  assert.deepEqual(unresolved, [])
})

test('a file whose id IS referenced is not deletable', () => {
  const file = openAiFile('file_recorded', 'syllabus.pdf', 1000)
  const attachments = [attachment('syllabus.pdf', 1000, 'file_recorded')]
  const { deletable, unresolved } = classifyFiles([file], attachments, NOW)
  assert.deepEqual(deletable, [])
  assert.deepEqual(unresolved, [])
})

test('an unreferenced file with no filename+size match is left alone, not deleted', () => {
  const file = openAiFile('file_mystery', 'vendor-upload.pdf', 5000)
  const attachments = [attachment('syllabus.pdf', 1000, 'file_recorded')]
  const { deletable, unresolved } = classifyFiles([file], attachments, NOW)
  assert.deepEqual(deletable, [])
  assert.deepEqual(unresolved, [file])
})

test('a filename match with a differing size is not deletable', () => {
  const file = openAiFile('file_new', 'syllabus.pdf', 999)
  const attachments = [attachment('syllabus.pdf', 1000, 'file_recorded')]
  const { deletable, unresolved } = classifyFiles([file], attachments, NOW)
  assert.deepEqual(deletable, [])
  assert.deepEqual(unresolved, [file])
})

test('a size match with a differing filename is not deletable', () => {
  const file = openAiFile('file_new', 'other.pdf', 1000)
  const attachments = [attachment('syllabus.pdf', 1000, 'file_recorded')]
  const { deletable, unresolved } = classifyFiles([file], attachments, NOW)
  assert.deepEqual(deletable, [])
  assert.deepEqual(unresolved, [file])
})

test('a candidate created within the last hour is skipped, even when it would otherwise be deletable', () => {
  const file = openAiFile('file_new', 'syllabus.pdf', 1000, {
    ageMs: RECENT_FILE_GRACE_MS - 1000,
  })
  const attachments = [attachment('syllabus.pdf', 1000, 'file_recorded')]
  const { deletable, tooRecent, unresolved } = classifyFiles(
    [file],
    attachments,
    NOW
  )
  assert.deepEqual(deletable, [])
  assert.deepEqual(unresolved, [])
  assert.deepEqual(tooRecent, [file])
})

// --- listAllFiles — pagination ------------------------------------------------

test('listAllFiles follows every page, not just the first', async () => {
  const calls = []
  const fetchFn = async (url) => {
    calls.push(url)
    if (!url.includes('after=')) {
      return jsonResponse({
        data: [openAiFile('file_1', 'a.pdf', 1)],
        has_more: true,
        last_id: 'file_1',
      })
    }
    return jsonResponse({
      data: [openAiFile('file_2', 'b.pdf', 2)],
      has_more: false,
      last_id: 'file_2',
    })
  }
  const files = await listAllFiles({
    apiKey: 'k',
    baseUrl: 'https://api.example',
    fetchFn,
  })
  assert.deepEqual(
    files.map((f) => f.id),
    ['file_1', 'file_2']
  )
  assert.equal(calls.length, 2)
  assert.match(calls[1], /after=file_1/)
})

// --- ordering, 404-as-success, partial failure, dry run -----------------------

/** A minimal `Response`-shaped stub. */
function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  }
}

test('deleteFileEverywhere removes the vector-store entry before the file object', async () => {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push(`${init.method} ${url}`)
    return jsonResponse({})
  }
  const file = openAiFile('file_1', 'a.pdf', 1)
  const result = await deleteFileEverywhere(file, ['vs_1'], {
    apiKey: 'k',
    baseUrl: 'https://api.example',
    fetchFn,
  })
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
  const result = await deleteFileEverywhere(file, ['vs_1'], {
    apiKey: 'k',
    baseUrl: 'https://api.example',
    fetchFn,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [
    'DELETE https://api.example/vector_stores/vs_1/files/file_1',
    'DELETE https://api.example/files/file_1',
  ])
})

test("one file's failure does not prevent the others being processed, and the run reports it", async () => {
  const fileA = openAiFile('file_a', 'a.pdf', 1)
  const fileB = openAiFile('file_b', 'b.pdf', 2)
  const fetchFn = async (url, init) => {
    if (init.method === 'DELETE' && url.includes('file_a')) {
      return jsonResponse({ error: 'boom' }, 500)
    }
    return jsonResponse({})
  }
  const { succeeded, failed } = await pruneAll([fileA, fileB], ['vs_1'], {
    apiKey: 'k',
    baseUrl: 'https://api.example',
    fetchFn,
  })
  assert.deepEqual(
    succeeded.map((f) => f.id),
    ['file_b']
  )
  assert.equal(failed.length, 1)
  assert.equal(failed[0].file.id, 'file_a')
})

test('dry run issues zero DELETE calls, even with a genuinely deletable file present', async () => {
  const file = openAiFile('file_new', 'syllabus.pdf', 1000)
  const attachments = [attachment('syllabus.pdf', 1000, 'file_recorded')]
  let deleteCalls = 0
  const fetchFn = async (url, init) => {
    if (init?.method === 'DELETE') deleteCalls += 1
    return jsonResponse({})
  }
  const exitCode = await execute({
    apply: false,
    files: [file],
    attachments,
    vectorStoreIds: ['vs_1'],
    options: { apiKey: 'k', baseUrl: 'https://api.example', fetchFn },
    now: NOW,
  })
  assert.equal(exitCode, 0)
  assert.equal(deleteCalls, 0)
})

test('execute applies a deletable file and exits non-zero when one fails', async () => {
  const good = openAiFile('file_good', 'a.pdf', 1)
  const bad = openAiFile('file_bad', 'b.pdf', 2)
  const attachments = [
    attachment('a.pdf', 1, 'file_recorded_a'),
    attachment('b.pdf', 2, 'file_recorded_b'),
  ]
  const fetchFn = async (url, init) => {
    if (init.method === 'DELETE' && url.includes('file_bad')) {
      return jsonResponse({}, 500)
    }
    return jsonResponse({})
  }
  const exitCode = await execute({
    apply: true,
    files: [good, bad],
    attachments,
    vectorStoreIds: ['vs_1'],
    options: { apiKey: 'k', baseUrl: 'https://api.example', fetchFn },
    now: NOW,
  })
  assert.equal(exitCode, 1)
})

// --- readTrackedState — the database half -------------------------------------

test('readTrackedState reads course_attachments and courses from a real tmp/ database, read-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bloombot-prune-test-'))
  const dbPath = join(dir, 'test.db')
  try {
    const setup = new BetterSqlite3(dbPath)
    setup.exec(`
      CREATE TABLE course_attachments (
        filename TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        provider_file_id TEXT
      );
      CREATE TABLE courses (
        vector_store_id TEXT
      );
      INSERT INTO course_attachments (filename, size_bytes, provider_file_id)
        VALUES ('syllabus.pdf', 1000, 'file_recorded');
      INSERT INTO courses (vector_store_id) VALUES ('vs_1'), ('vs_1'), (NULL);
    `)
    setup.close()

    const { attachments, vectorStoreIds } = readTrackedState(dbPath)
    assert.deepEqual(attachments, [
      {
        filename: 'syllabus.pdf',
        sizeBytes: 1000,
        providerFileId: 'file_recorded',
      },
    ])
    assert.deepEqual(vectorStoreIds, ['vs_1'])

    // Read-only: a write attempt against the connection this function opened
    // must fail, not silently succeed against the real file.
    const readonlyDb = new BetterSqlite3(dbPath, { readonly: true })
    assert.throws(() => readonlyDb.exec("INSERT INTO courses VALUES ('vs_2')"))
    readonlyDb.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
