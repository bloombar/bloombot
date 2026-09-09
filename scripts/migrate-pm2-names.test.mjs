/**
 * Tests for `scripts/migrate-pm2-names.sh` (OPS-15) — the one-time migration
 * a droplet still running the pre-rename, bare pm2 names needs before the
 * first deploy of the commit that renames them.
 *
 * A stand-in `pm2` on `PATH`, in the same shape `scripts/deploy.test.mjs`
 * already uses for `scripts/deploy.sh`: it keeps its own state in a JSON
 * file this suite can read back afterwards, so a test can assert exactly
 * which names were deleted/started rather than trusting the script's own
 * stdout claims.
 */

import { spawn } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const MIGRATE_SH = join(REPO_ROOT, 'scripts', 'migrate-pm2-names.sh')

let base
let binDir

before(() => {
  base = mkdtempSync(join(tmpdir(), 'migrate-pm2-names-test-'))
  binDir = join(base, 'bin')
  mkdirSync(binDir, { recursive: true })
})

after(() => {
  if (base) rmSync(base, { recursive: true, force: true })
})

/** Writes an executable stub at `binDir/<name>`. */
function writeStub(name, script) {
  const path = join(binDir, name)
  writeFileSync(path, script, 'utf8')
  chmodSync(path, 0o755)
}

/**
 * A fake `pm2` that keeps its process list in a JSON file at `pm2State`, the
 * same shape `deploy.test.mjs`'s own fake `pm2` uses: `jlist` reads it,
 * `delete`/`start` mutate it. `save` records that it was ever called, so a
 * test can assert it did — or did not — run.
 */
function writePm2Stub(pm2State, saveMarker) {
  writeStub(
    'pm2',
    `#!/usr/bin/env bash
set -euo pipefail
STATE_FILE="${pm2State}"
[ -f "$STATE_FILE" ] || echo '[]' > "$STATE_FILE"
cmd="$1"; shift
case "$cmd" in
  jlist) cat "$STATE_FILE" ;;
  delete)
    name="$1"
    "$REAL_NODE_PATH" -e '
      const fs = require("fs");
      const [file, name] = process.argv.slice(1);
      const apps = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify(apps.filter((a) => a.name !== name)));
    ' "$STATE_FILE" "$name"
    ;;
  start)
    name=""
    args=("$@")
    for i in "\${!args[@]}"; do
      if [ "\${args[$i]}" = "--only" ]; then name="\${args[$((i+1))]}"; fi
    done
    "$REAL_NODE_PATH" -e '
      const fs = require("fs");
      const [file, name] = process.argv.slice(1);
      const apps = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!apps.find((a) => a.name === name)) apps.push({ name, pm2_env: { status: "online" } });
      fs.writeFileSync(file, JSON.stringify(apps));
    ' "$STATE_FILE" "$name"
    ;;
  save) touch "${saveMarker}" ;;
  *) echo "[fake pm2] unhandled: $cmd $*" >&2; exit 1 ;;
esac
`
  )
}

/**
 * Seeds a throwaway checkout directory with an `ecosystem.config.cjs` and
 * returns its path. Named the renamed, `bloombot-` prefixed apps by
 * default — the ordinary case this script runs against is a checkout
 * already updated to the commit that renamed them; `setUpPreRenameCheckout`
 * below is the one exception.
 */
function setUpCheckout() {
  const dir = mkdtempSync(join(base, 'checkout-'))
  writeFileSync(
    join(dir, 'ecosystem.config.cjs'),
    `module.exports = { apps: [
      { name: "bloombot-api" }, { name: "bloombot-bot" },
      { name: "bloombot-worker" }, { name: "bloombot-mcp" },
      { name: "bloombot-ops-monitor" },
    ] };\n`
  )
  return dir
}

/**
 * Seeds a throwaway checkout still on the commit BEFORE the OPS-15 rename —
 * `ecosystem.config.cjs` names only the old, bare processes, the exact
 * shape that must refuse rather than delete anything (must-fix 1).
 */
function setUpPreRenameCheckout() {
  const dir = mkdtempSync(join(base, 'checkout-pre-rename-'))
  writeFileSync(
    join(dir, 'ecosystem.config.cjs'),
    `module.exports = { apps: [
      { name: "api" }, { name: "bot" },
      { name: "worker" }, { name: "mcp" }, { name: "ops-monitor" },
    ] };\n`
  )
  return dir
}

/** Seeds the fake pm2's own state file with a given list of `{ name }` apps. */
function seedPm2State(pm2State, names) {
  writeFileSync(
    pm2State,
    JSON.stringify(
      names.map((name) => ({ name, pm2_env: { status: 'online' } }))
    )
  )
}

/** Runs `scripts/migrate-pm2-names.sh` against a throwaway checkout. */
function runMigrate(
  checkoutDir,
  pm2State,
  { args = ['--yes'], stdin = '' } = {}
) {
  return new Promise((resolve) => {
    const child = spawn('bash', [MIGRATE_SH, ...args], {
      cwd: checkoutDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        REAL_NODE_PATH: process.execPath,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(stdin)
  })
}

test('migrate-pm2-names.sh: deletes exactly the old names it knows and starts exactly the missing new ones, leaving an unrelated process untouched', async () => {
  const checkoutDir = setUpCheckout()
  const pm2State = join(base, `pm2-state-${Date.now()}-${Math.random()}.json`)
  const saveMarker = join(base, `save-${Date.now()}-${Math.random()}.marker`)
  rmSync(saveMarker, { force: true })
  writePm2Stub(pm2State, saveMarker)
  // Every old bare name is running, plus an unrelated process on the same
  // shared droplet that must never be a candidate for anything this script
  // does.
  seedPm2State(pm2State, [
    'api',
    'bot',
    'worker',
    'mcp',
    'ops-monitor',
    'scabbot',
  ])

  const result = await runMigrate(checkoutDir, pm2State)

  assert.equal(result.code, 0, result.stdout + result.stderr)
  const apps = JSON.parse(readFileSync(pm2State, 'utf8'))
  const names = apps.map((a) => a.name).sort()
  assert.deepEqual(
    names,
    [
      'bloombot-api',
      'bloombot-bot',
      'bloombot-mcp',
      'bloombot-ops-monitor',
      'bloombot-worker',
      'scabbot',
    ].sort()
  )
  // pm2 save only runs once everything above it succeeded.
  assert.doesNotThrow(() => readFileSync(saveMarker))
})

test('migrate-pm2-names.sh: an unrelated process pm2 knows is never touched, even when nothing this script owns needs migrating', async () => {
  const checkoutDir = setUpCheckout()
  const pm2State = join(base, `pm2-state-${Date.now()}-${Math.random()}.json`)
  const saveMarker = join(base, `save-${Date.now()}-${Math.random()}.marker`)
  writePm2Stub(pm2State, saveMarker)
  seedPm2State(pm2State, [
    'bloombot-api',
    'bloombot-bot',
    'bloombot-worker',
    'bloombot-mcp',
    'bloombot-ops-monitor',
    'wikistreets',
  ])

  const result = await runMigrate(checkoutDir, pm2State)

  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /nothing to do/)
  const apps = JSON.parse(readFileSync(pm2State, 'utf8'))
  assert.deepEqual(
    apps.map((a) => a.name).sort(),
    [
      'bloombot-api',
      'bloombot-bot',
      'bloombot-mcp',
      'bloombot-ops-monitor',
      'bloombot-worker',
      'wikistreets',
    ].sort()
  )
})

test('migrate-pm2-names.sh: is idempotent — a second run on an already-migrated droplet reports nothing to do and exits 0', async () => {
  const checkoutDir = setUpCheckout()
  const pm2State = join(base, `pm2-state-${Date.now()}-${Math.random()}.json`)
  const saveMarker = join(base, `save-${Date.now()}-${Math.random()}.marker`)
  writePm2Stub(pm2State, saveMarker)
  seedPm2State(pm2State, ['api', 'bot', 'worker', 'mcp', 'ops-monitor'])

  const first = await runMigrate(checkoutDir, pm2State)
  assert.equal(first.code, 0, first.stdout + first.stderr)
  rmSync(saveMarker, { force: true }) // only the first run's own save should count

  const second = await runMigrate(checkoutDir, pm2State)
  assert.equal(second.code, 0, second.stdout + second.stderr)
  assert.match(second.stdout, /nothing to do/)
  // The second run never touched pm2 at all — no new save call.
  assert.throws(() => readFileSync(saveMarker))
})

test('migrate-pm2-names.sh: does nothing without confirmation, and does not call pm2 save', async () => {
  const checkoutDir = setUpCheckout()
  const pm2State = join(base, `pm2-state-${Date.now()}-${Math.random()}.json`)
  const saveMarker = join(base, `save-${Date.now()}-${Math.random()}.marker`)
  writePm2Stub(pm2State, saveMarker)
  seedPm2State(pm2State, ['api', 'bot', 'worker', 'mcp', 'ops-monitor'])

  // No --yes flag, and stdin answers anything but "yes".
  const result = await runMigrate(checkoutDir, pm2State, {
    args: [],
    stdin: 'no\n',
  })

  assert.notEqual(result.code, 0)
  assert.match(result.stdout + result.stderr, /not confirmed/)
  const apps = JSON.parse(readFileSync(pm2State, 'utf8'))
  assert.deepEqual(
    apps.map((a) => a.name).sort(),
    ['api', 'bot', 'mcp', 'ops-monitor', 'worker'].sort()
  )
  assert.throws(() => readFileSync(saveMarker))
})

test("migrate-pm2-names.sh: 'yes' typed at the confirmation prompt proceeds", async () => {
  const checkoutDir = setUpCheckout()
  const pm2State = join(base, `pm2-state-${Date.now()}-${Math.random()}.json`)
  const saveMarker = join(base, `save-${Date.now()}-${Math.random()}.marker`)
  writePm2Stub(pm2State, saveMarker)
  seedPm2State(pm2State, ['api', 'bot', 'worker', 'mcp', 'ops-monitor'])

  const result = await runMigrate(checkoutDir, pm2State, {
    args: [],
    stdin: 'yes\n',
  })

  assert.equal(result.code, 0, result.stdout + result.stderr)
  const apps = JSON.parse(readFileSync(pm2State, 'utf8'))
  assert.deepEqual(
    apps.map((a) => a.name).sort(),
    [
      'bloombot-api',
      'bloombot-bot',
      'bloombot-mcp',
      'bloombot-ops-monitor',
      'bloombot-worker',
    ].sort()
  )
})

test('migrate-pm2-names.sh: does not save if a delete fails partway through', async () => {
  const checkoutDir = setUpCheckout()
  const pm2State = join(base, `pm2-state-${Date.now()}-${Math.random()}.json`)
  const saveMarker = join(base, `save-${Date.now()}-${Math.random()}.marker`)
  seedPm2State(pm2State, ['api', 'bot', 'worker', 'mcp', 'ops-monitor'])
  writeStub(
    'pm2',
    `#!/usr/bin/env bash
set -euo pipefail
STATE_FILE="${pm2State}"
cmd="$1"; shift
case "$cmd" in
  jlist) cat "$STATE_FILE" ;;
  delete)
    name="$1"
    if [ "$name" = "bot" ]; then
      echo "[fake pm2] refusing to delete bot (test scenario)" >&2
      exit 1
    fi
    "$REAL_NODE_PATH" -e '
      const fs = require("fs");
      const [file, name] = process.argv.slice(1);
      const apps = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify(apps.filter((a) => a.name !== name)));
    ' "$STATE_FILE" "$name"
    ;;
  start)
    name=""
    args=("$@")
    for i in "\${!args[@]}"; do
      if [ "\${args[$i]}" = "--only" ]; then name="\${args[$((i+1))]}"; fi
    done
    "$REAL_NODE_PATH" -e '
      const fs = require("fs");
      const [file, name] = process.argv.slice(1);
      const apps = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!apps.find((a) => a.name === name)) apps.push({ name, pm2_env: { status: "online" } });
      fs.writeFileSync(file, JSON.stringify(apps));
    ' "$STATE_FILE" "$name"
    ;;
  save) touch "${saveMarker}" ;;
  *) echo "[fake pm2] unhandled: $cmd $*" >&2; exit 1 ;;
esac
`
  )

  const result = await runMigrate(checkoutDir, pm2State)

  assert.notEqual(result.code, 0)
  assert.match(result.stdout + result.stderr, /delete bot/)
  assert.throws(() => readFileSync(saveMarker))
})

// Rework finding (must-fix 1) — the first version of this script only
// checked that `ecosystem.config.cjs` existed, not what it actually named.
// Run against a checkout still on the commit BEFORE the OPS-15 rename (the
// documented order is checkout-then-migrate, but nothing enforced it), the
// delete half would succeed and every `pm2 start ecosystem.config.cjs
// --only bloombot-api` (etc.) would match no app in that file — exiting 0
// having started nothing, leaving the droplet with the whole platform down
// and no old processes left to fall back to. This is the regression test:
// the script must refuse before deleting anything when the checkout it is
// run from does not yet name the new processes.
test('migrate-pm2-names.sh: refuses, and deletes nothing, when the checkout is still on the pre-rename commit', async () => {
  const checkoutDir = setUpPreRenameCheckout()
  const pm2State = join(base, `pm2-state-${Date.now()}-${Math.random()}.json`)
  const saveMarker = join(base, `save-${Date.now()}-${Math.random()}.marker`)
  writePm2Stub(pm2State, saveMarker)
  seedPm2State(pm2State, ['api', 'bot', 'worker', 'mcp', 'ops-monitor'])

  const result = await runMigrate(checkoutDir, pm2State)

  assert.notEqual(result.code, 0)
  const output = result.stdout + result.stderr
  assert.match(output, /does not name/)
  assert.match(output, /bloombot-api/)
  assert.match(output, /before the OPS-15 pm2 rename/)
  // Nothing was deleted — every old name pm2 knew about is still there.
  const apps = JSON.parse(readFileSync(pm2State, 'utf8'))
  assert.deepEqual(
    apps.map((a) => a.name).sort(),
    ['api', 'bot', 'mcp', 'ops-monitor', 'worker'].sort()
  )
  assert.throws(() => readFileSync(saveMarker))
})
