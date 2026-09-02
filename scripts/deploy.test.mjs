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
function writeDefaultStubs({
  failReload = null,
  failReloadAlways = null,
  failReloadOnRetry = null,
  stayOffline = null,
  failBuildWeb = false,
  failMigration = false,
  failNpmCi = false,
  failInstallDeps = false,
} = {}) {
  const reloadMarker = join(base, 'reload-failed-once')
  const buildMarker = join(base, 'build-failed-once')
  const npmCiMarker = join(base, 'npm-ci-failed-once')
  const installDepsMarker = join(base, 'install-deps-failed-once')
  const retryCountFile = join(base, 'reload-retry-count')
  // Cleared on every call — each test starts from "the one-time failure has
  // not happened yet", regardless of what an earlier test in this file left
  // behind.
  rmSync(reloadMarker, { force: true })
  rmSync(buildMarker, { force: true })
  rmSync(npmCiMarker, { force: true })
  rmSync(installDepsMarker, { force: true })
  rmSync(retryCountFile, { force: true })

  writeStub(
    'pm2',
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${PM2_UNREACHABLE:-}" = "1" ]; then
  echo "[fake pm2] daemon unreachable (test scenario)" >&2
  exit 1
fi
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
    if [ "$name" = "${failReloadAlways ?? ''}" ] && [ -n "${failReloadAlways ?? ''}" ]; then
      echo "[fake pm2] refusing to start $name (test scenario, always)" >&2
      exit 1
    fi
    if [ "$name" = "${failReloadOnRetry ?? ''}" ] && [ -n "${failReloadOnRetry ?? ''}" ]; then
      count=0
      [ -f "${retryCountFile}" ] && count="$(cat "${retryCountFile}")"
      count=$((count + 1))
      echo "$count" > "${retryCountFile}"
      if [ "$count" -gt 1 ]; then
        echo "[fake pm2] refusing to start $name (test scenario, on retry — succeeded call #1)" >&2
        exit 1
      fi
    fi
    status="online"
    if [ "$name" = "${stayOffline ?? ''}" ] && [ -n "${stayOffline ?? ''}" ]; then
      status="errored"
    fi
    "$REAL_NODE_PATH" -e '
      const fs = require("fs");
      const [file, name, status] = process.argv.slice(1);
      const apps = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!apps.find((a) => a.name === name)) apps.push({ name, pm2_env: { status, restart_time: 0 } });
      fs.writeFileSync(file, JSON.stringify(apps));
    ' "$STATE_FILE" "$name" "$status"
    ;;
  reload)
    name="$1"
    if [ "$name" = "${failReload ?? ''}" ] && [ -n "${failReload ?? ''}" ] && [ ! -f "${reloadMarker}" ]; then
      touch "${reloadMarker}"
      echo "[fake pm2] refusing to reload $name (test scenario, once)" >&2
      exit 1
    fi
    if [ "$name" = "${failReloadAlways ?? ''}" ] && [ -n "${failReloadAlways ?? ''}" ]; then
      echo "[fake pm2] refusing to reload $name (test scenario, always)" >&2
      exit 1
    fi
    if [ "$name" = "${failReloadOnRetry ?? ''}" ] && [ -n "${failReloadOnRetry ?? ''}" ]; then
      count=0
      [ -f "${retryCountFile}" ] && count="$(cat "${retryCountFile}")"
      count=$((count + 1))
      echo "$count" > "${retryCountFile}"
      if [ "$count" -gt 1 ]; then
        echo "[fake pm2] refusing to reload $name (test scenario, on retry — succeeded call #1)" >&2
        exit 1
      fi
    fi
    status="online"
    if [ "$name" = "${stayOffline ?? ''}" ] && [ -n "${stayOffline ?? ''}" ]; then
      status="errored"
    fi
    "$REAL_NODE_PATH" -e '
      const fs = require("fs");
      const [file, name, status] = process.argv.slice(1);
      const apps = JSON.parse(fs.readFileSync(file, "utf8"));
      const app = apps.find((a) => a.name === name);
      if (app) app.pm2_env.status = status;
      fs.writeFileSync(file, JSON.stringify(apps));
    ' "$STATE_FILE" "$name" "$status"
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
# Rework finding — deploy.sh's own script is piped over this whole
# process's stdin (\`bash -s -- <sha> < scripts/deploy.sh\`, the same way
# CI invokes it, and the same way runDeploy() below invokes it). The
# dependency check (\`"$PM2_INTERPRETER" - <<'PY' ... PY\`) redirects THIS
# stub's own stdin to the heredoc body specifically — draining it there is
# correct and matches what a real python3 does with it. But
# install_deps() also calls \`"$PM2_INTERPRETER" -m pip install ...\` with
# NO heredoc and no stdin redirection of its own, so that invocation
# inherits whatever is left of the *outer* piped-in deploy.sh script —
# unconsumed by bash's own parser yet, at that point. A stub that reads
# stdin unconditionally there eats the rest of the script bash still
# needs to read, and deploy.sh silently truncates and "succeeds" a few
# lines later — a real bug this harness had, found by a review that hit it
# directly. Only drain stdin when invoked as \`python3 -\` (the heredoc
# case); never for \`-m pip install\`, matching what a real python3 does
# for each.
if [ "$1" = "-" ]; then
  cat >/dev/null
  exit 0
fi
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
  if [ "${failInstallDeps ? 1 : 0}" = "1" ] && [ ! -f "${installDepsMarker}" ]; then
    touch "${installDepsMarker}"
    echo "[fake python3] simulated pip install failure (test scenario, once)" >&2
    exit 1
  fi
  exit 0
fi
exit 0
`
  )

  // Deterministic across a host that does or does not have a real pipenv on
  // PATH — always "no virtualenv here", the same outcome deploy.sh's own
  // \`PIPENV_VENV\` detection already falls back to gracefully, so
  // install_deps() always takes the \`python3 -m pip install\` path above,
  // not \`pipenv install\`.
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
if [ "$1" = "ci" ]; then
  if [ "${failNpmCi ? 1 : 0}" = "1" ] && [ ! -f "${npmCiMarker}" ]; then
    touch "${npmCiMarker}"
    echo "[fake npm] simulated npm ci failure (test scenario, once)" >&2
    exit 1
  fi
  exit 0
fi
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
  packages/db/dist/run-migrate.js)
    if [ "${failMigration ? 1 : 0}" = "1" ]; then
      echo "[fake node] simulated migration failure (test scenario)" >&2
      exit 1
    fi
    exit 0
    ;;
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
async function setUpRepo({
  changeNodeDeps = false,
  changePythonDeps = false,
} = {}) {
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
  // Only touched when a test needs DEPS_CHANGED/NODE_DEPS_CHANGED true —
  // deploy.sh diffs these exact files between PREV_SHA and TARGET_SHA to
  // decide whether to run install_deps/npm ci at all (§"Dependency installs
  // are slow..."), so a test exercising either has to actually change one.
  if (changeNodeDeps) {
    writeFileSync(join(workDir, 'package-lock.json'), '{"changed":true}\n')
  }
  if (changePythonDeps) {
    writeFileSync(join(workDir, 'Pipfile.lock'), 'x-changed\n')
  }
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

// Rework finding — a process that refuses to reload no matter what (not a
// transient, once-only hiccup) fails *both* the forward path's own initial
// `reload_everything` and its immediate retry inside that same branch, so
// this exercises the forward-path CRITICAL escalation specifically — the
// deploy never reaches the health check at all here, since `worker` never
// came up even once. See the "unhealthy-after-reload" test further below
// for the sibling case: everything reloads fine at first, a *different*
// process fails its health check, and only the rollback's own retry fails.
test("deploy.sh: a process that never reloads at all fails the forward path's own retry too, and escalates to CRITICAL", async () => {
  writeDefaultStubs({ failReloadAlways: 'worker' })
  const { target, checkoutDir } = await setUpRepo()
  const result = await runDeploy(checkoutDir, target)

  assert.notEqual(result.code, 0)
  const output = result.stdout + result.stderr
  assert.match(output, /failed to reload/)
  assert.match(output, /CRITICAL/)
  assert.match(output, /failed to reload onto it too/)
  // It must not claim the ordinary, successful rollback message when the
  // rollback itself never actually completed.
  assert.doesNotMatch(
    output,
    /rolled back to [0-9a-f]+; every process is running the previous commit$/m
  )
})

// Rework finding — `confirm_rolled_back_online` itself (the fix for
// "the final message used to print unconditionally") had no test at all.
// Here every `pm2 reload`/`pm2 start` call succeeds (exit 0) — the mcp
// process just never actually comes up, the same shape a crash-on-start
// takes in real pm2 (accepted, then immediately errored). The rollback's
// own reload "succeeds" from `reload_everything`'s point of view, so only
// `confirm_rolled_back_online`'s own explicit pm2-status check can catch it.
test('deploy.sh: confirm_rolled_back_online catches a rollback that pm2 accepted but did not actually bring up', async () => {
  writeDefaultStubs({ failReload: 'bot', stayOffline: 'mcp' })
  const { target, checkoutDir } = await setUpRepo()
  const result = await runDeploy(checkoutDir, target)

  assert.notEqual(result.code, 0)
  const output = result.stdout + result.stderr
  assert.match(output, /confirming the previous commit is actually online/)
  assert.match(output, /CRITICAL/)
  assert.match(output, /pm2 still reports these as not online/)
  assert.match(output, /mcp \(errored\)/)
})

// Rework finding — must-fix 4 asked specifically for "rollback-reload-also-
// fails" as its own scenario, distinct from the forward-path retry above:
// every process reloads *successfully* the first time (so the deploy
// reaches the health check at all), one of them (`mcp`) then fails its
// health check, and only *then*, during the rollback's own
// `reload_everything` retry, does a *different* process (`worker`) start
// refusing to reload — the pm2 command itself failing on retry, not merely
// `confirm_rolled_back_online` catching a status pm2 never actually fixed
// (that is the separate test above). This isolates the UNHEALTHY branch's
// own "if ! reload_everything" guard specifically.
test("deploy.sh: unhealthy-after-reload correctly detected, then the rollback's own reload failing on retry still escalates to CRITICAL", async () => {
  writeDefaultStubs({ stayOffline: 'mcp', failReloadOnRetry: 'worker' })
  const { target, checkoutDir } = await setUpRepo()
  const result = await runDeploy(checkoutDir, target)

  assert.notEqual(result.code, 0)
  const output = result.stdout + result.stderr
  // Reached the ordinary post-reload health check (not the forward-path
  // reload-failure branch) — mcp is what tripped it.
  assert.match(output, /unhealthy after the reload/)
  assert.match(output, /mcp/)
  // The rollback's own second reload attempt then failed for a different
  // process, and that has to escalate rather than claim success.
  assert.match(output, /CRITICAL/)
  assert.match(output, /failed to reload onto it/)
  assert.doesNotMatch(
    output,
    /rolled back to [0-9a-f]+; every process is running the previous commit$/m
  )
})

// Rework finding — the migration step's own guard (`if ! node …run-migrate…`)
// had no test proving it actually stops the deploy before anything is
// reloaded.
test('deploy.sh: a migration failure aborts before reloading anything, and restores the checkout', async () => {
  writeDefaultStubs({ failMigration: true })
  const { target, checkoutDir } = await setUpRepo()
  const result = await runDeploy(checkoutDir, target)

  assert.notEqual(result.code, 0)
  const output = result.stdout + result.stderr
  assert.match(output, /the database migration failed/)
  assert.doesNotMatch(output, /reloading every supervised process/)
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: checkoutDir })
  const prevSha = await run('git', ['rev-parse', `${target}~1`], {
    cwd: checkoutDir,
  })
  assert.equal(head.stdout.trim(), prevSha.stdout.trim())
})

// Rework finding — must-fix 2: `install_deps` and `npm ci` in the forward
// path ran as bare statements, unlike every other forward step. Reproduced
// with the real script: `npm ci` failing left the entire operator-visible
// output as npm's own error line, no `ERROR:`, no rollback, and `HEAD` left
// at TARGET — with `node_modules` already deleted by the real `npm ci`, on
// a droplet the next deploy would compute its own rollback target as this
// broken commit. This is the regression test for the fix; `npm ci` only
// runs at all when `package-lock.json` differs between commits, so this
// test has to actually change it (`setUpRepo({ changeNodeDeps: true })`).
test('deploy.sh: an npm ci failure aborts before reloading anything, and restores the checkout — not left on the broken commit', async () => {
  writeDefaultStubs({ failNpmCi: true })
  const { target, checkoutDir } = await setUpRepo({ changeNodeDeps: true })
  const result = await runDeploy(checkoutDir, target)

  assert.notEqual(result.code, 0)
  const output = result.stdout + result.stderr
  assert.match(output, /ERROR/)
  assert.match(output, /npm ci failed/)
  assert.doesNotMatch(output, /reloading every supervised process/)
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: checkoutDir })
  const prevSha = await run('git', ['rev-parse', `${target}~1`], {
    cwd: checkoutDir,
  })
  assert.equal(
    head.stdout.trim(),
    prevSha.stdout.trim(),
    'HEAD must be restored to the previous commit, not left on the broken target'
  )
})

// The Python-dependency mirror of the npm ci case above — `install_deps` in
// the forward path, gated on `Pipfile.lock`/`requirements.txt` actually
// changing (`setUpRepo({ changePythonDeps: true })`).
test('deploy.sh: a python dependency install failure aborts before reloading anything, and restores the checkout', async () => {
  writeDefaultStubs({ failInstallDeps: true })
  const { target, checkoutDir } = await setUpRepo({ changePythonDeps: true })
  const result = await runDeploy(checkoutDir, target)

  assert.notEqual(result.code, 0)
  const output = result.stdout + result.stderr
  assert.match(output, /ERROR/)
  assert.match(output, /python dependency install failed/)
  assert.doesNotMatch(output, /reloading every supervised process/)
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: checkoutDir })
  const prevSha = await run('git', ['rev-parse', `${target}~1`], {
    cwd: checkoutDir,
  })
  assert.equal(head.stdout.trim(), prevSha.stdout.trim())
})

// A deploy whose dependency files did not change at all must still exercise
// the harness's own stdin-safe python3 stub correctly (it always drains a
// heredoc, never a plain `-m pip install`) — mostly a sanity check that the
// happy path is not accidentally relying on install_deps() never running;
// see the two tests above for the case where it does.
test('deploy.sh: a python dependency install failure only aborts when the dependency files actually changed', async () => {
  writeDefaultStubs({ failInstallDeps: true })
  const { target, checkoutDir } = await setUpRepo({ changePythonDeps: false })
  const result = await runDeploy(checkoutDir, target)

  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.match(
    result.stdout,
    /python dependency files unchanged; skipping install/
  )
})

// Rework finding — pm2 itself can be the thing that is down, not merely one
// app inside it (a daemon that crashed, `~/.pm2` corrupted, wrong `PM2_HOME`
// after a botched restore). Every `pm2` call fails identically, including
// `pm2 jlist` — so every process reads as unknown/not-online, the deploy
// correctly treats that as universally unhealthy, and the rollback's own
// pm2 calls fail the exact same way, reaching the same CRITICAL escalation
// covered above through a different, realistic cause.
test('deploy.sh: pm2 itself being unreachable is treated as every process unhealthy, and escalates rather than hanging or crashing raw', async () => {
  writeDefaultStubs()
  const { target, checkoutDir } = await setUpRepo()
  const result = await runDeploy(checkoutDir, target, { PM2_UNREACHABLE: '1' })

  assert.notEqual(result.code, 0)
  const output = result.stdout + result.stderr
  assert.match(output, /daemon unreachable/)
  // Whichever message this settles on — the ordinary rollback-failed
  // CRITICAL path, or the reload-failure one — the process must not exit 0
  // and must not print the healthy "deployed ... online" message.
  assert.doesNotMatch(output, /deployed .* — every process is online/)
})
