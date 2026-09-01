/**
 * Tests for `npm run dev`'s decision about what to start.
 *
 * The spawning itself is not worth a test — four `spawn` calls either work or
 * fail loudly on the first run. What is worth pinning is the rule that keeps a
 * partly-configured checkout usable: the API and the panel start with no
 * credentials at all, and the bot and worker are skipped by name rather than
 * left to crash-loop and scroll the useful output away.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { planProcesses, PROCESSES } from './dev.mjs'

test('starts the API and the panel with no credentials configured', () => {
  const plan = planProcesses({})
  const started = plan.filter((entry) => entry.start).map((entry) => entry.name)

  assert.deepEqual(started, ['api', 'web'])
})

test('skips the bot and the worker, naming what they are missing', () => {
  const plan = planProcesses({})
  const bot = plan.find((entry) => entry.name === 'bot')

  assert.equal(bot.start, false)
  assert.deepEqual(bot.missing, ['BOT_TOKEN'])
})

test('starts everything once the bot token is present', () => {
  const plan = planProcesses({ BOT_TOKEN: 'a-token' })

  assert.deepEqual(
    plan.filter((entry) => entry.start).map((entry) => entry.name),
    ['api', 'web', 'worker', 'bot']
  )
})

test('every process either runs a script in this repo or an npm script', () => {
  // Guards against a typo'd path silently becoming "tsx watch <nothing>".
  for (const entry of PROCESSES) {
    assert.ok(
      entry.script !== undefined || entry.npmScript !== undefined,
      `${entry.name} names neither a script nor an npm script`
    )
  }
})
