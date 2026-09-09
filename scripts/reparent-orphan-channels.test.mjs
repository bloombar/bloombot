/**
 * Tests for `scripts/reparent-orphan-channels.mjs`. The decisions worth
 * pinning are all pure — which channels move, which are left alone, and
 * whether a plan would overfill a category — so nothing here touches the
 * network; the script's own `main()` is the thin part deliberately left out,
 * the same split `scripts/check-discord-oauth.test.mjs` uses.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CATEGORY_CHANNEL_LIMIT,
  parseArgs,
  planChannel,
  planGuild,
  projectedCategorySizes,
  resolveRules,
} from './reparent-orphan-channels.mjs'

const VIEW = '1024' // VIEW_CHANNEL

/** A channel fixture: orphaned and visible to `roleId` unless told otherwise. */
const channel = (name, { id = name, parent = null, overwrites = [] } = {}) => ({
  id,
  name,
  type: 0,
  parent_id: parent,
  permission_overwrites: overwrites,
})

const roleAllow = (id, allow = VIEW) => ({ id, type: 0, allow, deny: '0' })

// --- parseArgs -------------------------------------------------------------

test('parseArgs collects repeated rules and excludes, defaulting to a dry run', () => {
  const parsed = parseArgs([
    '--rule',
    'admins-se-f26=Software Engineering - STUDENTS 01',
    '--rule',
    'admins-ad-f26=Agile Dev - STUDENTS 01',
    '--exclude',
    'temp',
  ])
  assert.equal(parsed.apply, false)
  assert.deepEqual(parsed.exclude, ['temp'])
  assert.deepEqual(parsed.rules, [
    { role: 'admins-se-f26', category: 'Software Engineering - STUDENTS 01' },
    { role: 'admins-ad-f26', category: 'Agile Dev - STUDENTS 01' },
  ])
})

test('parseArgs splits a rule on its first = so a category name may contain one', () => {
  const { rules } = parseArgs(['--rule', 'role=a=b'])
  assert.deepEqual(rules, [{ role: 'role', category: 'a=b' }])
})

test('parseArgs rejects a rule with no =', () => {
  assert.throws(
    () => parseArgs(['--rule', 'nope']),
    /needs <roleName>=<categoryName>/
  )
})

// --- resolveRules ----------------------------------------------------------

test('resolveRules reports a rule whose role or category the guild lacks, without dropping the ones that resolve', () => {
  const { targets, report } = resolveRules(
    [
      { role: 'present', category: 'Cat' },
      { role: 'absent', category: 'Cat' },
      { role: 'present', category: 'No Such Category' },
    ],
    [{ id: 'r1', name: 'present' }],
    [{ id: 'c1', name: 'Cat', type: 4 }]
  )
  assert.deepEqual(
    report.map((r) => r.status),
    ['ok', 'role missing', 'category missing']
  )
  assert.deepEqual([...targets.keys()], ['r1'])
  assert.equal(targets.get('r1').categoryId, 'c1')
})

// --- planChannel -----------------------------------------------------------

const targets = new Map([['r1', { categoryId: 'c1', categoryName: 'Cat' }]])

test('planChannel moves an orphan whose matching role is allowed VIEW_CHANNEL', () => {
  const plan = planChannel(
    channel('a', { overwrites: [roleAllow('r1')] }),
    targets
  )
  assert.equal(plan.categoryId, 'c1')
})

test('planChannel leaves a channel that already has a parent alone', () => {
  const inCategory = channel('a', {
    parent: 'other',
    overwrites: [roleAllow('r1')],
  })
  assert.equal(planChannel(inCategory, targets), null)
})

test('planChannel leaves a category itself alone', () => {
  assert.equal(planChannel({ ...channel('Cat'), type: 4 }, targets), null)
})

test('planChannel skips an orphan matching no configured role', () => {
  assert.equal(
    planChannel(channel('a', { overwrites: [roleAllow('other')] }), targets),
    null
  )
})

test('planChannel ignores a matching role whose overwrite does not allow VIEW_CHANNEL', () => {
  // The role is named on the channel, but only to allow SEND_MESSAGES (2048)
  // — being mentioned in an overwrite is not the same as being granted sight
  // of the channel, and treating it as such would misfile channels.
  const sendOnly = channel('a', { overwrites: [roleAllow('r1', '2048')] })
  assert.equal(planChannel(sendOnly, targets), null)
})

test('planChannel ignores a member overwrite that happens to share a role id', () => {
  const memberOverwrite = channel('a', {
    overwrites: [{ id: 'r1', type: 1, allow: VIEW, deny: '0' }],
  })
  assert.equal(planChannel(memberOverwrite, targets), null)
})

test('planChannel skips an excluded channel name even when it matches a rule', () => {
  const temp = channel('temp', { overwrites: [roleAllow('r1')] })
  assert.equal(planChannel(temp, targets, ['temp']), null)
})

// --- planGuild -------------------------------------------------------------

test('planGuild separates the movable orphans from the ones left alone, and never counts a categorised channel as either', () => {
  const channels = [
    { id: 'c1', name: 'Cat', type: 4, parent_id: null },
    channel('moves', { overwrites: [roleAllow('r1')] }),
    channel('unmatched', { overwrites: [roleAllow('other')] }),
    channel('already-filed', { parent: 'c1', overwrites: [roleAllow('r1')] }),
  ]
  const { moves, skipped } = planGuild(channels, targets)
  assert.deepEqual(
    moves.map((m) => m.channel.name),
    ['moves']
  )
  assert.deepEqual(
    skipped.map((c) => c.name),
    ['unmatched']
  )
})

// --- projectedCategorySizes ------------------------------------------------

test('projectedCategorySizes counts what a category already holds plus what the plan would add', () => {
  const channels = [
    { id: 'c1', name: 'Cat', type: 4, parent_id: null },
    channel('existing', { parent: 'c1' }),
    channel('orphan', { overwrites: [roleAllow('r1')] }),
  ]
  const { moves } = planGuild(channels, targets)
  assert.equal(projectedCategorySizes(channels, moves).get('c1'), 2)
})

test("projectedCategorySizes exposes a plan that would breach Discord's per-category limit", () => {
  const channels = [{ id: 'c1', name: 'Cat', type: 4, parent_id: null }]
  for (let i = 0; i < CATEGORY_CHANNEL_LIMIT; i += 1) {
    channels.push(channel(`filled-${i}`, { id: `f${i}`, parent: 'c1' }))
  }
  channels.push(
    channel('one-too-many', { id: 'extra', overwrites: [roleAllow('r1')] })
  )
  const { moves } = planGuild(channels, targets)
  assert.equal(
    projectedCategorySizes(channels, moves).get('c1'),
    CATEGORY_CHANNEL_LIMIT + 1
  )
})
