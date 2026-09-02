/**
 * Tests for the `.env` loader `scripts/health-check.mjs` and
 * `scripts/ops-monitor.mjs` both now call — the fix for a rework-round
 * finding: neither script loaded `.env` at all, so `OPS_ALERT_WEBHOOK_URL`
 * and any `*_PORT` override never reached the running process even though
 * both were documented as belonging in `.env`.
 *
 * The fixtures deliberately do not use the name `.env` — a hook in this
 * repository blocks writes to `.env*`, because a real one holds live
 * credentials, and a test that had to be exempted from that guard would be
 * a test worth distrusting. `packages/config/tests/dotenv.test.ts` (this
 * package's own TypeScript counterpart) takes the same precaution for the
 * same reason.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadDotEnvOnce } from './load-dotenv.mjs'

const envFile = (contents) => {
  const dir = mkdtempSync(join(tmpdir(), 'load-dotenv-test-'))
  const path = join(dir, 'environment-fixture')
  writeFileSync(path, contents, 'utf8')
  return { dir, path }
}

test('loads a variable from the file into process.env', () => {
  const { dir, path } = envFile('LOAD_DOTENV_TEST_A=from-file\n')
  delete process.env.LOAD_DOTENV_TEST_A
  try {
    const loaded = loadDotEnvOnce(path)
    assert.equal(loaded, true)
    assert.equal(process.env.LOAD_DOTENV_TEST_A, 'from-file')
  } finally {
    delete process.env.LOAD_DOTENV_TEST_A
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a variable already set in process.env wins over the file', () => {
  const { dir, path } = envFile('LOAD_DOTENV_TEST_B=from-file\n')
  process.env.LOAD_DOTENV_TEST_B = 'already-set'
  try {
    loadDotEnvOnce(path)
    assert.equal(process.env.LOAD_DOTENV_TEST_B, 'already-set')
  } finally {
    delete process.env.LOAD_DOTENV_TEST_B
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing file is not an error, and returns false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'load-dotenv-test-'))
  const path = join(dir, 'does-not-exist')
  try {
    assert.equal(loadDotEnvOnce(path), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
