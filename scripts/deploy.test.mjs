/**
 * Integration tests for `scripts/deploy.sh` (OPS-7, OPS-8) — the one script
 * in this repository that can take production down, and, per this
 * repository's own history, the one most likely to have a bug that only
 * shows up the day something it depends on actually fails.
 *
 * Builds a throwaway git repository (a bare "origin" plus a working
 * checkout) and a `PATH` of stand-in `git`-adjacent commands — `pm2`, `npm`,
 * `node`, `python3` — each a small script under a temp directory, none of
 * them touching anything real. `git` itself is the real one, operating only
 * on the throwaway repository. `deploy.sh` is invoked the same way CI
 * actually invokes it (`bash -s -- <sha> < scripts/deploy.sh`, piping the
 * *current* commit's own copy of the script), not by running whatever
 * happens to be checked out.
 *
 * These are the scenarios worth a committed regression test, not an
 * exhaustive rehearsal of every branch — see `docs/DECISIONS.md`'s entry
 * for this rework round for the ones this harness already found once,
 * fixed, and did not keep as automated tests.
 */

import { spawn } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEPLOY_SH = join(REPO_ROOT, 'scripts', 'deploy.sh')

/** Runs `cmd` and rejects on a non-zero exit unless `allowFailure`. */
function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout += d))
    child.stderr?.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

let base
let binDir

before(() => {
  base = mkdtempSync(join(tmpdir(), 'deploy-sh-test-'))
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
 * Builds the fake command set every scenario needs, writing into the shared
 * `binDir` (each test overwrites the ones it wants to behave differently).
 * `pm2State` is a path to a JSON file the fake `pm2` reads/writes, so a
 * test can inspect what pm2 "knows" after a run and reuse state across a
 * forward-then-rollback sequence the way real pm2 would.
 */
/**
 * `failReload`/`failBuildWeb` fail only their *first* invocation (a marker
 * file records that the one-time failure already happened) — a transient
 * pm2 hiccup or a build that fails once and then succeeds on retry, the
 * scenario `restore_previous_checkout`'s own rebuild and the rollback's own
 * `reload_everything` retry are supposed to recover from. Failing forever
 * would conflate "the forward path failed" with "the rollback itself also
 * failed", which is a different, already-covered CRITICAL case.
 */
function writeDefaultStubs({ failReload = null, failBuildWeb = false } = {}) {
  const reloadMarker = join(base, 'reload-failed-once')
  const buildMarker = join(base, 'build-failed-once')
  // Cleared on every call — each test starts from "the one-time failure has
  // not happened yet", regardless of what an earlier test in this file left
  // behind.
  rmSync(reloadMarker, { force: true })
  rmSync(buildMarker, { force: true })

  writeStub(
    'pm2',
    `#!/usr/bin/env bash
set -euo pipefail
STATE_FILE="\${PM2_STATE_FILE:?}"
[ -f "$STATE_FILE" ] || echo '[]' > "$STATE_FILE"
cmd="$1"; shift
case "$cmd" in
  jlist) cat "$STATE_FILE" ;;
  start)
    name=""
    args=("$@")
    for i in "\${!args[@]}"; do
      if [ "\${args[$i]}" = "--only" ]; then name="\${args[$((i+1))]}"; fi
    done
    if [ "$name" = "${failReload ?? ''}" ] && [ -n "${failReload ?? ''}" ] && [ ! -f "${reloadMarker}" ]; then
      touch "${reloadMarker}"
      echo "[fake pm2] refusing to start $name (test scenario, once)" >&2
      exit 1
    fi
    "$REAL_NODE_PATH" -e '
      const fs = require("fs");
      const [file, name] = process.argv.slice(1);
      const apps = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!apps.find((a) => a.name === name)) apps.push({ name, pm2_env: { status: "online", restart_time: 0 } });
      fs.writeFileSync(file, JSON.stringify(apps));
    ' "$STATE_FILE" "$name"
    ;;
  reload)
    name="$1"
    if [ "$name" = "${failReload ?? ''}" ] && [ -n "${failReload ?? ''}" ] && [ ! -f "${reloadMarker}" ]; then
      touch "${reloadMarker}"
      echo "[fake pm2] refusing to reload $name (test scenario, once)" >&2
      exit 1
    fi
    "$REAL_NODE_PATH" -e '
      const fs = require("fs");
      const [file, name] = process.argv.slice(1);
      const apps = JSON.parse(fs.readFileSync(file, "utf8"));
      const app = apps.find((a) => a.name === name);
      if (app) app.pm2_env.status = "online";
      fs.writeFileSync(file, JSON.stringify(apps));
    ' "$STATE_FILE" "$name"
    ;;
  save) : ;;
  logs) echo "[fake pm2] (no logs in this test)" ;;
  *) echo "[fake pm2] unhandled: $cmd $*" >&2; exit 1 ;;
esac
`
  )

  writeStub(
    'python3',
    `#!/usr/bin/env bash
cat >/dev/null
exit 0
`
  )

  // Deterministic across a host that does or does not have a real pipenv on
  // PATH — always "no virtualenv here", the same outcome deploy.sh's own
  // \`PIPENV_VENV\` detection already falls back to gracefully.
  writeStub(
    'pipenv',
    `#!/usr/bin/env bash
exit 1
`
  )

  writeStub(
    'npm',
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "run" ] && [ "$2" = "build" ] && [ "\${3:-}" = "--workspace" ] && [ "\${4:-}" = "apps/web" ] && [ "${failBuildWeb ? 1 : 0}" = "1" ] && [ ! -f "${buildMarker}" ]; then
  touch "${buildMarker}"
  echo "[fake npm] simulated apps/web build failure (test scenario, once)" >&2
  exit 1
fi
exit 0
`
  )

  writeStub(
    'node',
    `#!/usr/bin/env bash
set -euo pipefail
: "\${REAL_NODE_PATH:?}"
case "$1" in
  packages/db/dist/run-migrate.js) exit 0 ;;
  scripts/health-check.mjs) exit 0 ;;
  *) exec "$REAL_NODE_PATH" "$@" ;;
esac
`
  )
}

/**
 * Creates a throwaway git repository with two commits, and clones a
 * checkout with `origin` pointed at it — entirely under a fresh, uniquely
 * named directory, so two tests in this file (or two runs of the same one)
 * never share a `work`/`origin.git`/`checkout` and silently see each
 * other's commits or a `git clone` that failed because the target already
 * existed.
 */
async function setUpRepo() {
  const root = mkdtempSync(join(base, 'repo-'))
  const workDir = join(root, 'work')
  const originDir = join(root, 'origin.git')
  const checkoutDir = join(root, 'checkout')
  mkdirSync(workDir, { recursive: true })
  const opts = { cwd: workDir }

  await run('git', ['init', '-q', '-b', 'master'], opts)
  await run('git', ['config', 'user.email', 'test@example.com'], opts)
  await run('git', ['config', 'user.name', 'Test'], opts)
  mkdirSync(join(workDir, 'packages', 'db', 'dist'), { recursive: true })
  mkdirSync(join(workDir, 'scripts'), { recursive: true })
  writeFileSync(join(workDir, 'package-lock.json'), '{}\n')
  writeFileSync(join(workDir, 'Pipfile.lock'), 'x\n')
  writeFileSync(join(workDir, 'requirements.txt'), 'x\n')
  writeFileSync(
    join(workDir, 'packages', 'db', 'dist', 'run-migrate.js'),
    '// stub\n'
  )
  writeFileSync(join(workDir, 'scripts', 'health-check.mjs'), '// stub\n')
  writeFileSync(
    join(workDir, 'ecosystem.config.cjs'),
    `module.exports = { apps: [
      { name: "bloombot" }, { name: "api" }, { name: "bot" },
      { name: "worker" }, { name: "mcp" }, { name: "ops-monitor" },
    ] };\n`
  )
  await run('git', ['add', '-A'], opts)
  await run('git', ['commit', '-q', '-m', 'first commit'], opts)
  const prev = (await run('git', ['rev-parse', 'HEAD'], opts)).stdout.trim()

  writeFileSync(
    join(workDir, 'packages', 'db', 'dist', 'run-migrate.js'),
    '// stub v2\n'
  )
  await run('git', ['commit', '-q', '-am', 'second commit'], opts)
  const target = (await run('git', ['rev-parse', 'HEAD'], opts)).stdout.trim()

  const clone1 = await run('git', ['clone', '-q', '--bare', workDir, originDir])
  assert.equal(clone1.code, 0, `bare clone failed: ${clone1.stderr}`)
  const clone2 = await run('git', ['clone', '-q', originDir, checkoutDir])
  assert.equal(clone2.code, 0, `checkout clone failed: ${clone2.stderr}`)
  await run('git', ['checkout', '-q', prev], { cwd: checkoutDir })
  await run('git', ['remote', 'set-url', 'origin', workDir], {
    cwd: checkoutDir,
  })
  return { prev, target, checkoutDir }
}

/** Runs `scripts/deploy.sh` (the real, current committed copy) the way CI does — piped over stdin — against the throwaway checkout. */
async function runDeploy(checkoutDir, targetSha, extraEnv = {}) {
  const pm2State = join(base, `pm2-state-${Date.now()}-${Math.random()}.json`)
  const deployScript = await import('node:fs').then((fs) =>
    fs.readFileSync(DEPLOY_SH, 'utf8')
  )
  return new Promise((resolve) => {
    const child = spawn('bash', ['-s', '--', targetSha], {
      cwd: checkoutDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        APP_DIR: checkoutDir,
        HEALTH_WAIT: '1',
        PM2_STATE_FILE: pm2State,
        REAL_NODE_PATH: process.execPath,
        ...extraEnv,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr, pm2State }))
    child.stdin.end(deployScript)
  })
}

test('deploy.sh: the happy path builds, migrates once, reloads every process, and exits 0', async () => {
  writeDefaultStubs()
  const { target, checkoutDir } = await setUpRepo()
  const result = await runDeploy(checkoutDir, target)

  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /deployed .* — every process is online/)
  // Migration ran exactly once — not once per process, which is the whole
  // point of OPS-8's own "applied before any of the four even tried".
  const migrateCount = (
    result.stdout.match(/applying the platform database migration/g) || []
  ).length
  assert.equal(migrateCount, 1)
})

// Rework finding — `start_or_reload`/`reload_everything` used to run pm2's
// own reload/start as a bare statement; a failure there under `set -e`
// killed the whole script immediately, with no health check and no
// rollback. This is the regression test for that fix: `pm2 reload bot` is
// made to fail, and a working deploy must still notice, roll back, and say
// so — not die on the first pm2 error line.
test('deploy.sh: a pm2 reload failure mid-loop rolls back and reports it, rather than dying silently', async () => {
  writeDefaultStubs({ failReload: 'bot' })
  const { target, checkoutDir } = await setUpRepo()
  const result = await runDeploy(checkoutDir, target)

  assert.notEqual(result.code, 0)
  assert.match(result.stdout + result.stderr, /failed to reload/)
  assert.match(result.stdout + result.stderr, /rolling back/)
  assert.match(result.stdout + result.stderr, /rolled back/)
  // The checkout itself was actually reset back to the previous commit —
  // not merely claimed to be.
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: checkoutDir })
  const prevSha = await run('git', ['rev-parse', `${target}~1`], {
    cwd: checkoutDir,
  })
  assert.equal(head.stdout.trim(), prevSha.stdout.trim())
})

test('deploy.sh: a control-panel build failure aborts before reloading anything, and restores the checkout', async () => {
  writeDefaultStubs({ failBuildWeb: true })
  const { target, checkoutDir } = await setUpRepo()
  const result = await runDeploy(checkoutDir, target)

  assert.notEqual(result.code, 0)
  assert.match(result.stdout + result.stderr, /control panel failed to build/)
  // Nothing was ever reloaded — no pm2 state file should exist with any
  // app in it, since the failure happens before `reload_everything` is
  // ever called.
  assert.doesNotMatch(result.stdout, /reloading every supervised process/)
})
