/**
 * Tests for the SPEC/ROADMAP parsers behind the project board (BOARD-1,
 * BOARD-3). Run with `node --test scripts/board/` — no test framework needed.
 *
 * Two jobs: pin the parser's behavior, and guard the format contract on the
 * real docs/SPEC.md, so a heading typo that would silently orphan a board issue
 * fails CI instead of reaching the board.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { parseSpec, expandIds, buildEntries } from './derive.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const specText = readFileSync(join(root, 'docs', 'SPEC.md'), 'utf8')
const roadText = readFileSync(join(root, 'docs', 'ROADMAP.md'), 'utf8')

// ---------------------------------------------------------------- parseSpec

test('parseSpec reads id, title, section and family from a heading', () => {
  const items = parseSpec(
    ['### 4. Accounts', '', '#### AUTH-1 Sign in', '', 'Body prose.'].join('\n'),
  )
  assert.equal(items.length, 1)
  assert.deepEqual(
    { ...items[0] },
    {
      id: 'AUTH-1',
      title: 'Sign in',
      section: '§4 Accounts',
      family: 'AUTH',
      full: 'Body prose.',
    },
  )
})

test('parseSpec ends a body at the next heading', () => {
  const items = parseSpec(
    [
      '### 1. One',
      '#### A-1 First',
      'Body of first.',
      '#### A-2 Second',
      'Body of second.',
    ].join('\n'),
  )
  assert.deepEqual(
    items.map(i => i.full),
    ['Body of first.', 'Body of second.'],
  )
})

test('parseSpec omits `full` when the body adds nothing', () => {
  const items = parseSpec('### 1. One\n#### A-1 Title only\n')
  assert.equal(items[0].full, undefined)
})

test('parseSpec ignores prose that is not under a requirement heading', () => {
  assert.deepEqual(parseSpec('# Title\n\nIntro prose.\n\n### 1. Section\n'), [])
})

// ---------------------------------------------------------------- expandIds

test('expandIds expands ranges and slash-lists', () => {
  assert.deepEqual(expandIds('REF-1..3'), ['REF-1', 'REF-2', 'REF-3'])
  assert.deepEqual(expandIds('BOT-11/12'), ['BOT-11', 'BOT-12'])
})

test('expandIds ignores unrelated bare numbers', () => {
  assert.deepEqual(expandIds('AUTH-1 needs 100% coverage over 200 items'), [
    'AUTH-1',
  ])
})

// -------------------------------------------------- the real docs/SPEC.md

test('every SPEC requirement id is unique', () => {
  const ids = parseSpec(specText).map(i => i.id)
  const seen = new Set()
  const dupes = ids.filter(id => (seen.has(id) ? true : (seen.add(id), false)))
  assert.deepEqual(dupes, [], `duplicate requirement ids: ${dupes.join(', ')}`)
})

test('every SPEC requirement sits under a numbered section', () => {
  const orphans = parseSpec(specText).filter(i => !i.section)
  assert.deepEqual(
    orphans.map(i => i.id),
    [],
    'requirements above the first `### N.` section heading',
  )
})

test('every SPEC requirement has a title and a body', () => {
  const thin = parseSpec(specText).filter(i => !i.title || !i.full)
  assert.deepEqual(
    thin.map(i => i.id),
    [],
    'requirements with no title or no prose beneath the heading',
  )
})

test('every four-hash heading parses as a requirement', () => {
  // A heading the parser skips would silently vanish from the board.
  const headings = specText
    .split('\n')
    .filter(l => l.startsWith('#### '))
    .map(l => l.slice(5).trim())
  assert.equal(headings.length, parseSpec(specText).length)
})

test('the SPEC and ROADMAP derive a manifest with no entry needing review', () => {
  const { entries, stale } = buildEntries(specText, roadText, [])
  assert.ok(entries.length > 0)
  assert.deepEqual(stale, [])
  assert.deepEqual(
    entries.filter(e => e.review).map(e => e.id),
    [],
  )
  // Every entry must land on a phase the board has a milestone for.
  for (const e of entries) assert.ok(e.phase === 0 || e.phase === 1, e.id)
})

test('every ROADMAP-claimed id exists in the SPEC', () => {
  const specIds = new Set(parseSpec(specText).map(i => i.id))
  const claimed = roadText
    .split('\n')
    .filter(l => l.includes('**In scope:**'))
    .flatMap(expandIds)
  const missing = claimed.filter(id => !specIds.has(id))
  assert.deepEqual(missing, [], `claimed in ROADMAP but not in SPEC: ${missing}`)
})
