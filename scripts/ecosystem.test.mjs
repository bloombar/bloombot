/**
 * Tests for `ecosystem.config.cjs` (OPS-8): the pm2 process list `scripts/deploy.sh`
 * reloads by name.
 *
 * Not a test of pm2 itself — nothing here starts a process — but the shape a
 * bad edit to that file breaks silently: a typo'd script path, an app
 * missing from the list `scripts/deploy.sh` expects to find, or a stray
 * `instances`/`exec_mode` that would cluster a process PLAT-4 says must stay
 * single-instance.
 */

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const ecosystem = require(
  resolve(import.meta.dirname, '..', 'ecosystem.config.cjs')
)

// OPS-8's own process list: the legacy Python bot plus the four PLAT-4
// processes plus OPS-12's monitor — the exact set `scripts/deploy.sh`
// reloads by name.
const EXPECTED_NAMES = [
  'bloombot',
  'api',
  'bot',
  'worker',
  'mcp',
  'ops-monitor',
]

test('names every process OPS-8/OPS-12 requires, and nothing else', () => {
  assert.deepEqual(
    ecosystem.apps.map((app) => app.name),
    EXPECTED_NAMES
  )
})

test('every Node process runs its own built entry point', () => {
  const nodeApps = ecosystem.apps.filter((app) => app.name !== 'bloombot')
  for (const app of nodeApps) {
    assert.ok(
      app.script.endsWith('.js') || app.script.endsWith('.mjs'),
      `${app.name}'s script (${app.script}) is not a built JS entry point`
    )
  }
})

test("the four PLAT-4 processes each run their own dist/index.js, not each other's", () => {
  for (const name of ['api', 'bot', 'worker', 'mcp']) {
    const app = ecosystem.apps.find((a) => a.name === name)
    assert.equal(app.script, `apps/${name}/dist/index.js`)
  }
})

test('nothing sets cwd — every relative path in .env must resolve against $APP_DIR, not an app subdirectory', () => {
  for (const app of ecosystem.apps) {
    assert.equal(
      app.cwd,
      undefined,
      `${app.name} sets its own cwd, which would break DATABASE_PATH/LOGS_DIR's own relative resolution`
    )
  }
})

test('nothing is clustered — PLAT-4 requires every process single-instance', () => {
  for (const app of ecosystem.apps) {
    assert.equal(app.instances, undefined, `${app.name} sets instances`)
    assert.equal(app.exec_mode, undefined, `${app.name} sets exec_mode`)
  }
})

test('no app carries a secret in its own env block — every process loads .env itself (CFG-5)', () => {
  for (const app of ecosystem.apps) {
    const env = app.env ?? {}
    const CREDENTIAL_NAME = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/
    const leaked = Object.keys(env).filter((key) => CREDENTIAL_NAME.test(key))
    assert.deepEqual(
      leaked,
      [],
      `${app.name}'s ecosystem env carries: ${leaked.join(', ')}`
    )
  }
})

test('every app writes its own, distinctly named log files', () => {
  const outFiles = ecosystem.apps.map((app) => app.out_file)
  const errorFiles = ecosystem.apps.map((app) => app.error_file)
  assert.equal(
    new Set(outFiles).size,
    outFiles.length,
    'two apps share an out_file'
  )
  assert.equal(
    new Set(errorFiles).size,
    errorFiles.length,
    'two apps share an error_file'
  )
})
