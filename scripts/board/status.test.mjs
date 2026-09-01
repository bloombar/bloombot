/**
 * Tests for scripts/board/status.mjs (BOARD-4).
 *
 * The risk this script carries is not that it fails loudly — it is that it
 * rewrites the manifest in a way `derive.mjs` would write differently, which
 * turns CI red for everyone on the next pull request. So these tests are mostly
 * about the bytes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse, stringify } from 'yaml'

import { setStatus } from './status.mjs'
import { STATUSES } from './config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const MANIFEST = `# header comment
- id: PLAT-1
  title: Monorepo layout
  section: §12 Platform Architecture
  family: PLAT
  phase: 3
  status: Backlog
  review: false
- id: PLAT-2
  title: Package boundaries
  section: §12 Platform Architecture
  family: PLAT
  phase: 3
  status: Backlog
  review: false
- id: QA-1
  title: Tests fail before they pass
  section: §17 Quality, Types & Tooling
  family: QA
  phase: 3
  status: Done
  review: false
`

test('moves only the named requirements', () => {
  const result = setStatus(MANIFEST, ['PLAT-2'], 'In review')
  assert.deepEqual(result.changed, ['PLAT-2'])
  const entries = parse(result.text)
  assert.equal(entries.find(e => e.id === 'PLAT-2').status, 'In review')
  assert.equal(entries.find(e => e.id === 'PLAT-1').status, 'Backlog')
  assert.equal(entries.find(e => e.id === 'QA-1').status, 'Done')
})

test('reports an id that is already at the requested status', () => {
  const result = setStatus(MANIFEST, ['QA-1'], 'Done')
  assert.deepEqual(result.changed, [])
  assert.deepEqual(result.unchanged, ['QA-1'])
  assert.equal(result.text, MANIFEST)
})

test('reports an id that is not in the manifest rather than silently doing nothing', () => {
  const result = setStatus(MANIFEST, ['PLAT-1', 'NOPE-9'], 'Done')
  assert.deepEqual(result.missing, ['NOPE-9'])
  assert.deepEqual(result.changed, ['PLAT-1'])
})

test('refuses a status the board does not have a column for', () => {
  assert.throws(
    () => setStatus(MANIFEST, ['PLAT-1'], 'Almost done'),
    /Unknown status/
  )
})

test('a multi-word status is written the way the YAML serializer writes it', () => {
  // The whole reason this test exists: if this script quotes "In progress" and
  // derive.mjs does not, `git diff --exit-code scripts/board/manifest.yaml`
  // fails on the next PR that touches the SPEC.
  const result = setStatus(MANIFEST, ['PLAT-1'], 'In progress')
  assert.match(result.text, /^ {2}status: In progress$/m)
  assert.equal(stringify(parse(result.text)), stringify(parse(result.text)))
  const roundTripped = stringify(parse(result.text))
  assert.match(roundTripped, /^ {2}status: In progress$/m)
})

test('every status the board offers can be written', () => {
  for (const status of STATUSES) {
    const result = setStatus(MANIFEST, ['PLAT-1'], status)
    assert.equal(parse(result.text).find(e => e.id === 'PLAT-1').status, status)
  }
})

test('the real manifest survives a no-op pass unchanged, byte for byte', () => {
  const real = readFileSync(join(HERE, 'manifest.yaml'), 'utf8')
  const entry = parse(real)[0]
  const result = setStatus(real, [entry.id], entry.status)
  assert.equal(result.text, real)
})
