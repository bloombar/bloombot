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
  readFileSync,
  readdirSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
// OPS-19 — `backup_database` now reaches SQLite's own online backup through
// this driver instead of the `sqlite3` CLI (see this file's own module
// comment further down, and D-104). Used here to seed a genuine SQLite
// database for the tests to back up — a plain text stand-in would no
// longer exercise the code under test at all, since `better-sqlite3`
// refuses to open one — and to read a produced backup back out to prove it
// is a real, restorable copy rather than merely a file that exists.
import Database from 'better-sqlite3'

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
  // OPS-16 — a pm2 name this fake refuses to `delete`, once, the same
  // one-time shape `failReload` already uses above: a transient failure
  // partway through the migration's own delete loop, not a permanently
  // broken pm2.
  failDeleteOnce = null,
  // The permanent sibling — `failReloadAlways`'s own shape — for the
  // scenario where the delete never recovers, not even on the rollback
  // path's own retry: the one that proves a stranded old name never gets a
  // duplicate started beside it, in either attempt.
  failDeleteAlways = null,
} = {}) {
  const reloadMarker = join(base, 'reload-failed-once')
  const buildMarker = join(base, 'build-failed-once')
  const npmCiMarker = join(base, 'npm-ci-failed-once')
  const installDepsMarker = join(base, 'install-deps-failed-once')
  const retryCountFile = join(base, 'reload-retry-count')
  const deleteMarker = join(base, 'delete-failed-once')
  // Cleared on every call — each test starts from "the one-time failure has
  // not happened yet", regardless of what an earlier test in this file left
  // behind.
  rmSync(reloadMarker, { force: true })
  rmSync(buildMarker, { force: true })
  rmSync(npmCiMarker, { force: true })
  rmSync(installDepsMarker, { force: true })
  rmSync(retryCountFile, { force: true })
  rmSync(deleteMarker, { force: true })

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
      // OPS-16 — a real pm2 start records the cwd it was invoked from as
      // this app own pm_cwd; deploy.sh always runs from APP_DIR (it cds
      // there before anything else), so a freshly started app here gets
      // the same cwd this stub itself is running under.
      if (!apps.find((a) => a.name === name)) apps.push({ name, pm2_env: { status, restart_time: 0, pm_cwd: process.cwd() } });
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
  delete)
    name="$1"
    if [ "$name" = "${failDeleteOnce ?? ''}" ] && [ -n "${failDeleteOnce ?? ''}" ] && [ ! -f "${deleteMarker}" ]; then
      touch "${deleteMarker}"
      echo "[fake pm2] refusing to delete $name (test scenario, once)" >&2
      exit 1
    fi
    if [ "$name" = "${failDeleteAlways ?? ''}" ] && [ -n "${failDeleteAlways ?? ''}" ]; then
      echo "[fake pm2] refusing to delete $name (test scenario, always)" >&2
      exit 1
    fi
    "$REAL_NODE_PATH" -e '
      const fs = require("fs");
      const [file, name] = process.argv.slice(1);
      const apps = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify(apps.filter((a) => a.name !== name)));
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
# Records the NODE_OPTIONS each build actually ran under, so a test can assert
# the heap ceiling reached the build rather than only that the script chose one.
if [ "$1" = "run" ] && [ "$2" = "build" ] && [ -n "\${NPM_BUILD_ENV_LOG:-}" ]; then
  printf '%s\\n' "\${NODE_OPTIONS:-<unset>}" >> "$NPM_BUILD_ENV_LOG"
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
  // OPS-16 — the shape every MIGRATE_PM2_NAMES-under-rollback test actually
  // needs: the FIRST commit (PREV_SHA, what a rollback restores) is
  // pre-OPS-15 — bare names only — and the SECOND (TARGET_SHA) is the
  // rename itself. Without this, `checkoutDir`'s own PREV_SHA already has
  // the bloombot- names, which is a state a real migrating deploy can never
  // be run from (`check_pm2_names_migrated` refuses every deploy before
  // this one while pm2 still knows a bare name) — the exact gap the
  // reviewer found made both bugs in this rework invisible to this suite.
  preRenameFirstCommit = false,
  // OPS-19 — `backup_database` resolves `better-sqlite3` from `$APP_DIR`
  // (`checkoutDir` here), the same way a real deploy relies on `npm ci`
  // having populated `node_modules` there first (this file's own header on
  // why that ordering holds). This throwaway checkout has no `node_modules`
  // of its own — `npm ci` is stubbed out in these tests — so a symlink to
  // this repository's real one stands in for it, matching what a droplet
  // actually has by the time `backup_database` runs. Set false only for the
  // one test that needs `better-sqlite3` genuinely unresolvable.
  linkNodeModules = true,
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
  // OPS-16 — deploy.sh `source`s this file under MIGRATE_PM2_NAMES, from the
  // checkout it is deploying (not from wherever deploy.sh itself lives), so
  // the throwaway repo needs its own real copy — the repository's actual,
  // current one, not a stub, since `delete_old_pm2_names` is exactly the
  // logic under test here.
  writeFileSync(
    join(workDir, 'scripts', 'migrate-pm2-names.sh'),
    readFileSync(join(REPO_ROOT, 'scripts', 'migrate-pm2-names.sh'))
  )
  const newNamesEcosystem = `module.exports = { apps: [
      { name: "bloombot" }, { name: "bloombot-api" }, { name: "bloombot-bot" },
      { name: "bloombot-worker" }, { name: "bloombot-mcp" }, { name: "bloombot-ops-monitor" },
    ] };\n`
  const oldNamesEcosystem = `module.exports = { apps: [
      { name: "bloombot" }, { name: "api" }, { name: "bot" },
      { name: "worker" }, { name: "mcp" }, { name: "ops-monitor" },
    ] };\n`
  writeFileSync(
    join(workDir, 'ecosystem.config.cjs'),
    preRenameFirstCommit ? oldNamesEcosystem : newNamesEcosystem
  )
  await run('git', ['add', '-A'], opts)
  await run('git', ['commit', '-q', '-m', 'first commit'], opts)
  const prev = (await run('git', ['rev-parse', 'HEAD'], opts)).stdout.trim()

  writeFileSync(
    join(workDir, 'packages', 'db', 'dist', 'run-migrate.js'),
    '// stub v2\n'
  )
  if (preRenameFirstCommit) {
    writeFileSync(join(workDir, 'ecosystem.config.cjs'), newNamesEcosystem)
  }
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
  if (linkNodeModules) {
    symlinkSync(
      join(REPO_ROOT, 'node_modules'),
      join(checkoutDir, 'node_modules')
    )
  }
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

// OPS-15 — the hazard the pm2 rename itself carries: a droplet where
// `scripts/migrate-pm2-names.sh` was never run still has every process
// under its old, bare name, and `start_or_reload` cannot tell that apart
// from "pm2 has never heard of this app" — it would start a second,
// `bloombot-`-prefixed process alongside the one still running under the
// old name. This pins the guard that catches that state explicitly, before
// `reload_everything` (or anything else) ever runs, rather than trusting a
// deploy to notice via a crash-looping health check afterwards.
//
// Rework finding — the first version of this guard only aborted when pm2
// knew BOTH an old name and its new counterpart. A droplet that has never
// been migrated at all knows only the old names, so that version passed
// silently through the exact case it existed to catch, and CD would have
// started all five new processes beside the five still-running old ones
// unattended on the very next merge to master. This is the regression test
// for a wholly-unmigrated droplet — no `bloombot-` name present at all —
// which the both-present rule let straight through.
test('deploy.sh: aborts before reloading anything when pm2 knows an old bare name at all — even a wholly-unmigrated droplet with no new names yet', async () => {
  writeDefaultStubs()
  const { target, checkoutDir } = await setUpRepo()
  const pm2State = join(
    base,
    `pm2-state-unmigrated-${Date.now()}-${Math.random()}.json`
  )
  // Seeded directly, bypassing `runDeploy`'s own default state file — pm2
  // knows every old, bare name and none of the new `bloombot-` ones at
  // all: a droplet that has never run the migration, not a half-migrated
  // one.
  writeFileSync(
    pm2State,
    JSON.stringify(
      ['api', 'bot', 'worker', 'mcp', 'ops-monitor'].map((name) => ({
        name,
        pm2_env: { status: 'online', restart_time: 0 },
      }))
    )
  )
  const result = await runDeploy(checkoutDir, target, {
    PM2_STATE_FILE: pm2State,
  })

  assert.notEqual(result.code, 0)
  const output = result.stdout + result.stderr
  assert.match(output, /pm2 still knows these pre-OPS-15 names/)
  assert.match(output, /api/)
  assert.match(output, /worker/)
  assert.match(output, /migrate-pm2-names\.sh/)
  // Nothing was reloaded, and no build or migration step ran either — the
  // guard is checked before anything else in the script touches the
  // checkout.
  assert.doesNotMatch(output, /reloading every supervised process/)
  assert.doesNotMatch(output, /applying the platform database migration/)
})

// The sibling case: pm2 knows both an old name and its new counterpart —
// still refused, on the same "any old name present" rule, not merely the
// narrower both-present shape the original guard checked for.
test('deploy.sh: aborts before reloading anything when pm2 knows both an old and a new name, naming the migration script', async () => {
  writeDefaultStubs()
  const { target, checkoutDir } = await setUpRepo()
  const pm2State = join(
    base,
    `pm2-state-half-migrated-${Date.now()}-${Math.random()}.json`
  )
  writeFileSync(
    pm2State,
    JSON.stringify([
      { name: 'worker', pm2_env: { status: 'online', restart_time: 0 } },
      {
        name: 'bloombot-worker',
        pm2_env: { status: 'online', restart_time: 0 },
      },
    ])
  )
  const result = await runDeploy(checkoutDir, target, {
    PM2_STATE_FILE: pm2State,
  })

  assert.notEqual(result.code, 0)
  const output = result.stdout + result.stderr
  assert.match(output, /pm2 still knows these pre-OPS-15 names/)
  assert.match(output, /worker/)
  assert.match(output, /migrate-pm2-names\.sh/)
  assert.doesNotMatch(output, /reloading every supervised process/)
  assert.doesNotMatch(output, /applying the platform database migration/)
})

// Rework finding — `start_or_reload`/`reload_everything` used to run pm2's
// own reload/start as a bare statement; a failure there under `set -e`
// killed the whole script immediately, with no health check and no
// rollback. This is the regression test for that fix: `pm2 reload bot` is
// made to fail, and a working deploy must still notice, roll back, and say
// so — not die on the first pm2 error line.
test('deploy.sh: a pm2 reload failure mid-loop rolls back and reports it, rather than dying silently', async () => {
  writeDefaultStubs({ failReload: 'bloombot-bot' })
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
  writeDefaultStubs({ failReloadAlways: 'bloombot-worker' })
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
  writeDefaultStubs({ failReload: 'bloombot-bot', stayOffline: 'bloombot-mcp' })
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
  writeDefaultStubs({
    stayOffline: 'bloombot-mcp',
    failReloadOnRetry: 'bloombot-worker',
  })
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

// OPS-19 — a genuine SQLite database, not a plain-text stand-in: WAL mode
// (matching `packages/db/src/client.ts`'s own pragmas — the concurrent-
// writer hazard `backup_database` exists to be safe against) plus one row
// whose value the tests below can look for in a produced backup, which is
// the assertion OPS-18 itself lacked (its own fake `sqlite3 .backup` stub
// just `cp`'d a text file, so nothing ever proved the backup was a
// *database*, only that it was *a file*).
function createSeedDatabase(dbPath, { seedValue = 'seed-row' } = {}) {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(
    'create table seed_rows (id integer primary key, value text not null)'
  )
  db.prepare('insert into seed_rows (value) values (?)').run(seedValue)
  db.close()
}

/** Reads the seeded row back out of a database file (the source, or a
 * produced backup) — opening it at all, read-only, is itself part of the
 * assertion: a corrupt or truncated file fails here before the row check
 * even runs. */
function readSeedValue(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  const row = db.prepare('select value from seed_rows limit 1').get()
  db.close()
  return row?.value
}

/** Seeds a `.env` and a genuine database file in `checkoutDir`, the shape a
 * droplet that has already deployed once actually has — both are
 * untracked, so writing them directly here (rather than through
 * `setUpRepo`'s own git history) matches how a deploy actually finds them. */
function seedDatabase(
  checkoutDir,
  { relativePath = './data/data.db', seedValue = 'seed-row' } = {}
) {
  writeFileSync(join(checkoutDir, '.env'), `DATABASE_PATH=${relativePath}\n`)
  const dbPath = join(checkoutDir, relativePath)
  mkdirSync(join(checkoutDir, 'data'), { recursive: true })
  createSeedDatabase(dbPath, { seedValue })
  return dbPath
}

// OPS-18 — the whole point of the slice: a backup is taken, and it happens
// strictly before the migration, not merely somewhere in the same run. This
// checks the actual order the two log lines appear in stdout, not just that
// both eventually appear.
//
// Rework finding — this used to match `'backing up'`, which is the
// *caller's own* log line, emitted immediately before `backup_database` is
// even entered — true on every path, including a no-op mutation of the
// function's own body, so it caught nothing `backup_database` itself did.
// `'backup complete:'` is only ever printed after `Database#backup()` has
// actually succeeded (OPS-19), so it pins the real work rather than the
// announcement of it.
test('deploy.sh: OPS-18 — backs up the database before migrating it, and the deploy still succeeds', async () => {
  writeDefaultStubs()
  const { target, checkoutDir } = await setUpRepo()
  seedDatabase(checkoutDir, { seedValue: 'happy-path-row' })
  const result = await runDeploy(checkoutDir, target)

  assert.equal(result.code, 0, result.stdout + result.stderr)
  const backupAt = result.stdout.indexOf('backup complete:')
  const migrateAt = result.stdout.indexOf(
    'applying the platform database migration'
  )
  assert.ok(backupAt !== -1, 'no "backup complete:" log line found')
  assert.ok(migrateAt !== -1, 'no migration log line found')
  assert.ok(
    backupAt < migrateAt,
    `backup must be logged before the migration (backup at ${backupAt}, migration at ${migrateAt})`
  )

  // OPS-19 — the backup is a genuine, restorable copy, not merely a file
  // that exists: open it for real and read the row `seedDatabase` put in
  // the source, the assertion OPS-18 itself lacked (its own fake
  // `sqlite3 .backup` stub just `cp`'d a text file, so nothing there ever
  // proved the backup was a *database*).
  const backupDir = join(checkoutDir, 'data', 'backups')
  const backups = readdirSync(backupDir).filter((f) => f.startsWith('backup_'))
  assert.equal(backups.length, 1, `expected exactly one backup: ${backups}`)
  assert.equal(
    readSeedValue(join(backupDir, backups[0])),
    'happy-path-row',
    'the backup must be a genuine, restorable copy of the database'
  )
})

// The failure-ordering half of the same requirement: a backup that cannot be
// taken must abort before the migration runs, and before anything is
// reloaded — not merely fail the deploy eventually.
//
// OPS-19 — `Database#backup()` returns a Promise, and the one outcome that
// must never happen is an unawaited rejection reporting success. This forces
// a genuine rejection out of the real driver (making the backup directory
// unwritable, so SQLite itself cannot open the destination file) rather than
// stubbing a CLI, so it also proves the rejection is actually awaited and
// turned into a non-zero exit — a fire-and-forget `backup()` call would let
// this deploy report success regardless.
test('deploy.sh: OPS-19 — a rejected backup() promise aborts before the migration and before any reload', async () => {
  writeDefaultStubs()
  const { target, checkoutDir } = await setUpRepo()
  seedDatabase(checkoutDir)
  const backupDir = join(checkoutDir, 'data', 'backups')
  mkdirSync(backupDir, { recursive: true })
  // Read-and-execute only: SQLite can still stat the directory (so
  // `mkdir -p`/`git check-ignore` above it succeed) but cannot create the
  // new backup file inside it, which is exactly what makes `.backup()`
  // reject rather than merely fail to be attempted at all.
  chmodSync(backupDir, 0o555)
  try {
    const result = await runDeploy(checkoutDir, target)

    assert.notEqual(result.code, 0)
    const output = result.stdout + result.stderr
    assert.match(output, /pre-migration database backup failed/)
    assert.doesNotMatch(output, /applying the platform database migration/)
    assert.doesNotMatch(output, /reloading every supervised process/)
    const head = await run('git', ['rev-parse', 'HEAD'], { cwd: checkoutDir })
    const prevSha = await run('git', ['rev-parse', `${target}~1`], {
      cwd: checkoutDir,
    })
    assert.equal(
      head.stdout.trim(),
      prevSha.stdout.trim(),
      'the checkout must be restored to the previous commit'
    )
  } finally {
    // `after()`'s own `rmSync` on the whole base directory needs to be able
    // to remove this directory's entry from its (writable) parent, which it
    // can regardless — but restoring the permission here keeps this test's
    // own intent from leaking into cleanup at all.
    chmodSync(backupDir, 0o755)
  }
})

test('deploy.sh: OPS-18 — a first-ever deploy with no database yet skips the backup and still deploys', async () => {
  writeDefaultStubs()
  const { target, checkoutDir } = await setUpRepo()
  const result = await runDeploy(checkoutDir, target)

  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /skipping the pre-migration backup/)
})

// Rework finding — `resolve_database_path` used to parse `.env` with a
// hand-rolled `KEY=VALUE` bash `read` loop, which disagrees with
// `process.loadEnvFile` (what `packages/config/src/dotenv.ts`'s own
// `loadDotEnv` actually calls) on every shape below. A quoted value in
// particular — the form a great many hand-written `.env` files use —
// resolved to the literal string `"./data/other.db"`, including the
// quote characters, which then failed the "does this file exist" check
// and read as a first-ever deploy with nothing to back up: the backup was
// silently skipped and the live database was migrated anyway. Each case
// here seeds the database at a NON-default path (`./data/other.db`) named
// only through the `.env` shape under test, so a parser that resolves the
// wrong path also fails to find the file at all — the same failure mode
// the real bug had.
for (const [name, envLine] of [
  ['a quoted value', 'DATABASE_PATH="./data/other.db"\n'],
  ['an export-prefixed value', 'export DATABASE_PATH=./data/other.db\n'],
  ['a value with trailing whitespace', 'DATABASE_PATH=./data/other.db   \n'],
  ['a CRLF line ending', 'DATABASE_PATH=./data/other.db\r\n'],
  ['a final line with no trailing newline', 'DATABASE_PATH=./data/other.db'],
]) {
  test(`deploy.sh: OPS-18 — resolves DATABASE_PATH from .env with ${name}`, async () => {
    writeDefaultStubs()
    const { target, checkoutDir } = await setUpRepo()
    writeFileSync(join(checkoutDir, '.env'), envLine)
    mkdirSync(join(checkoutDir, 'data'), { recursive: true })
    const dbPath = join(checkoutDir, 'data', 'other.db')
    createSeedDatabase(dbPath, { seedValue: 'env-shape-row' })

    const result = await runDeploy(checkoutDir, target)

    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.doesNotMatch(
      result.stdout,
      /skipping the pre-migration backup/,
      'a configured database must not read as "nothing to back up yet"'
    )
    const backupDir = join(checkoutDir, 'data', 'backups')
    const backups = readdirSync(backupDir).filter((f) =>
      f.startsWith('backup_')
    )
    assert.equal(backups.length, 1, `expected exactly one backup: ${backups}`)
    assert.equal(
      readSeedValue(join(backupDir, backups[0])),
      'env-shape-row',
      'the backup must be a copy of the DATABASE_PATH-configured file, not the default'
    )
  })
}

// The second half of the fix: a configured DATABASE_PATH that does not
// resolve to an existing file is a misconfiguration, not a fresh droplet —
// it must abort the deploy (and never reach the migration), not be read as
// "nothing to back up yet".
test('deploy.sh: OPS-18 — a configured DATABASE_PATH that does not exist aborts, rather than skipping as a first deploy', async () => {
  writeDefaultStubs()
  const { target, checkoutDir } = await setUpRepo()
  writeFileSync(
    join(checkoutDir, '.env'),
    'DATABASE_PATH=./data/does-not-exist.db\n'
  )

  const result = await runDeploy(checkoutDir, target)

  assert.notEqual(result.code, 0)
  const output = result.stdout + result.stderr
  assert.match(output, /DATABASE_PATH is configured/)
  assert.doesNotMatch(output, /skipping the pre-migration backup/)
  assert.doesNotMatch(output, /applying the platform database migration/)
})

// OPS-19 — the sibling of OPS-18's own "sqlite3 absent on PATH" case: the
// CLI is gone from this script entirely now, so the equivalent hazard is
// `better-sqlite3` not being resolvable from `$APP_DIR` (a checkout whose
// `npm ci` never actually installed it, or ran somewhere else). Must fail
// loudly and never fall back to a plain `cp` — the same discipline the
// removed check had.
test('deploy.sh: OPS-19 — better-sqlite3 unresolvable from $APP_DIR fails loudly rather than falling back to a plain copy', async () => {
  writeDefaultStubs()
  const { target, checkoutDir } = await setUpRepo({ linkNodeModules: false })
  seedDatabase(checkoutDir)
  const result = await runDeploy(checkoutDir, target)

  assert.notEqual(result.code, 0)
  const output = result.stdout + result.stderr
  assert.match(output, /better-sqlite3 could not be resolved/)
  assert.doesNotMatch(output, /applying the platform database migration/)
})

test('deploy.sh: OPS-18 — retention prunes old backups to the last 5, keeping the newest', async () => {
  writeDefaultStubs()
  const { target, checkoutDir } = await setUpRepo()
  seedDatabase(checkoutDir)
  const backupDir = join(checkoutDir, 'data', 'backups')
  mkdirSync(backupDir, { recursive: true })
  // Seven pre-existing backups, deliberately out of chronological order in
  // creation time — the timestamp in each name is what retention must sort
  // by, not filesystem mtime.
  for (let i = 0; i < 7; i++) {
    const stamp = `2020010${i}T000000Z`
    writeFileSync(join(backupDir, `backup_${stamp}_aaaaaaaa.db`), 'old\n')
  }
  const result = await runDeploy(checkoutDir, target)

  assert.equal(result.code, 0, result.stdout + result.stderr)
  const remaining = readdirSync(backupDir).filter((f) =>
    f.startsWith('backup_')
  )
  // The 7 pre-existing ones plus this run's own new one = 8; retention keeps
  // 5, so 3 of the oldest pre-existing ones must be gone and the newest 2
  // pre-existing ones plus the new one must remain.
  assert.equal(remaining.length, 5, `expected 5 backups, found: ${remaining}`)
  assert.ok(
    !remaining.includes('backup_20200100T000000Z_aaaaaaaa.db'),
    'the oldest backup should have been pruned'
  )
  assert.ok(
    remaining.includes('backup_20200106T000000Z_aaaaaaaa.db'),
    'the newest pre-existing backup should have survived'
  )
})

// A cheap, standalone check that guards the worst outcome directly: the
// backup directory this script writes into must be covered by .gitignore,
// so a `git add -A` on a droplet checkout (or anywhere else) cannot commit
// a backup of the student database to a public repository.
test(".gitignore covers scripts/deploy.sh's own backup directory (data/backups/)", () => {
  const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8')
  assert.match(gitignore, /^data\/backups\/$/m)
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

// A cut-over droplet (docs/CUTOVER.md) no longer runs the legacy Python bot,
// but pm2 still remembers it — stopped — from before the cutover. The old
// unconditional `start_or_reload "$PM2_APP"` therefore did not quietly no-op
// there: it *restarted the retired bot* on every deploy, putting a second
// answering process back onto the database the cutover had just moved off.
// `PM2_APP=` is the escape hatch, and this pins that it reaches every place
// the Python side is touched, not only the reload loop.
test('deploy.sh: an empty PM2_APP skips the legacy Python bot entirely rather than resurrecting it', async () => {
  writeDefaultStubs()
  const { target, checkoutDir } = await setUpRepo({ changePythonDeps: true })
  const result = await runDeploy(checkoutDir, target, { PM2_APP: '' })

  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /deployed .* — every process is online/)
  assert.match(result.stdout, /PM2_APP is empty/)

  // The strong assertion: pm2 was never asked to start or reload the bot, so
  // it never entered pm2's own process list. Checking the state the stub
  // actually keeps, rather than trusting a log line.
  const apps = JSON.parse(readFileSync(result.pm2State, 'utf8'))
  const names = apps.map((app) => app.name)
  assert.ok(
    !names.includes('bloombot'),
    `the retired Python bot was started anyway: ${names.join(', ')}`
  )
  // The four Node processes and the monitor still deployed normally.
  for (const expected of [
    'bloombot-api',
    'bloombot-bot',
    'bloombot-worker',
    'bloombot-mcp',
    'bloombot-ops-monitor',
  ]) {
    assert.ok(names.includes(expected), `${expected} was not started`)
  }
  // Python dependency files changed in this repo, and the install must still
  // have been skipped — the bot they belong to is not here to need them.
  assert.doesNotMatch(result.stdout, /python dependency files changed/)
})

// V8 sizes its old-space from total system memory, so on the 1 GB droplet
// this platform actually deploys to, `tsc --build` across this workspace dies
// with "Ineffective mark-compacts near heap limit" and takes the whole deploy
// down with it. Swap does not help — the ceiling is V8's own. This pins that
// the ceiling reaches BOTH builds (the workspace and the control panel),
// since a flag on only one of them still fails the deploy.
test('deploy.sh: BUILD_HEAP_MB raises the V8 heap ceiling for every build', async () => {
  writeDefaultStubs()
  const { target, checkoutDir } = await setUpRepo()
  const envLog = join(base, `build-env-${Date.now()}.log`)
  const result = await runDeploy(checkoutDir, target, {
    BUILD_HEAP_MB: '1536',
    NPM_BUILD_ENV_LOG: envLog,
  })

  assert.equal(result.code, 0, result.stdout + result.stderr)
  const lines = readFileSync(envLog, 'utf8').trim().split('\n')
  assert.equal(
    lines.length,
    2,
    `expected two builds, saw: ${lines.join(' | ')}`
  )
  for (const line of lines) {
    assert.match(line, /--max-old-space-size=1536/)
  }
})

// The flag must not leak past the builds into the long-lived pm2 processes:
// with no ceiling configured, the builds run under V8's own default, which is
// correct on a host with memory to spare.
test('deploy.sh: no BUILD_HEAP_MB means the builds run under V8 own default', async () => {
  writeDefaultStubs()
  const { target, checkoutDir } = await setUpRepo()
  const envLog = join(base, `build-env-none-${Date.now()}.log`)
  const result = await runDeploy(checkoutDir, target, {
    BUILD_HEAP_MB: '',
    NPM_BUILD_ENV_LOG: envLog,
  })

  assert.equal(result.code, 0, result.stdout + result.stderr)
  for (const line of readFileSync(envLog, 'utf8').trim().split('\n')) {
    assert.doesNotMatch(line, /--max-old-space-size/)
  }
})

// OPS-16 — MIGRATE_PM2_NAMES turns this script into the OPS-15 migration
// itself, so an unattended deploy can run it instead of an operator running
// scripts/migrate-pm2-names.sh by hand. Seeds pm2 with every pre-rename bare
// name (plus an unrelated `scabbot`) and confirms the migration deletes
// exactly the five old ones, starts the five new ones, saves, and the
// deploy still reports success.
test('deploy.sh: MIGRATE_PM2_NAMES set on an unmigrated droplet deletes the old names, starts the new ones, saves, and succeeds', async () => {
  writeDefaultStubs()
  const { target, checkoutDir } = await setUpRepo()
  const pm2State = join(
    base,
    `pm2-state-migrate-${Date.now()}-${Math.random()}.json`
  )
  writeFileSync(
    pm2State,
    JSON.stringify(
      ['api', 'bot', 'worker', 'mcp', 'ops-monitor', 'scabbot'].map((name) => ({
        name,
        // OPS-16 — `pm_cwd` matching this checkout is what makes each old
        // bare name this deploy's own, not an unrelated project's; without
        // it, `delete_old_pm2_names`'s own ownership check would leave
        // every one of them alone. `scabbot`'s own `pm_cwd` does not matter
        // here — it is never in `OLD_NAMES` to begin with.
        pm2_env: { status: 'online', restart_time: 0, pm_cwd: checkoutDir },
      }))
    )
  )
  const result = await runDeploy(checkoutDir, target, {
    PM2_STATE_FILE: pm2State,
    MIGRATE_PM2_NAMES: '1',
  })

  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /deployed .* — every process is online/)
  const names = JSON.parse(readFileSync(pm2State, 'utf8'))
    .map((a) => a.name)
    .sort()
  assert.deepEqual(
    names,
    [
      'bloombot',
      'bloombot-api',
      'bloombot-bot',
      'bloombot-mcp',
      'bloombot-ops-monitor',
      'bloombot-worker',
      'scabbot',
    ].sort()
  )
})

// The ordering guarantee this whole slice exists for: the old names must
// not be deleted until the deploy is certain it can start the new ones. A
// build failure happens well before the reload step (and so before
// `delete_old_pm2_names` is ever called), so the old-named processes must
// still be exactly as they were — nothing deleted, nothing started.
test('deploy.sh: MIGRATE_PM2_NAMES set — a build failure deletes nothing and leaves the old names alone', async () => {
  writeDefaultStubs({ failBuildWeb: true })
  const { target, checkoutDir } = await setUpRepo()
  const pm2State = join(
    base,
    `pm2-state-migrate-buildfail-${Date.now()}-${Math.random()}.json`
  )
  const seeded = ['api', 'bot', 'worker', 'mcp', 'ops-monitor', 'scabbot']
  writeFileSync(
    pm2State,
    JSON.stringify(
      seeded.map((name) => ({
        name,
        pm2_env: { status: 'online', restart_time: 0 },
      }))
    )
  )
  const result = await runDeploy(checkoutDir, target, {
    PM2_STATE_FILE: pm2State,
    MIGRATE_PM2_NAMES: '1',
  })

  assert.notEqual(result.code, 0)
  assert.match(result.stdout + result.stderr, /control panel failed to build/)
  // Nothing was ever reloaded — the reload step, and therefore the delete
  // step that lives inside it, never ran.
  assert.doesNotMatch(result.stdout, /reloading every supervised process/)
  const names = JSON.parse(readFileSync(pm2State, 'utf8'))
    .map((a) => a.name)
    .sort()
  assert.deepEqual(
    names,
    seeded.sort(),
    'the old-named processes must be untouched after a build failure'
  )
})

test('deploy.sh: MIGRATE_PM2_NAMES set — the old-name guard does not abort, unlike the flag being off', async () => {
  writeDefaultStubs()
  const { target, checkoutDir } = await setUpRepo()
  const pm2State = join(
    base,
    `pm2-state-migrate-noabort-${Date.now()}-${Math.random()}.json`
  )
  writeFileSync(
    pm2State,
    JSON.stringify(
      ['api', 'bot', 'worker', 'mcp', 'ops-monitor'].map((name) => ({
        name,
        pm2_env: { status: 'online', restart_time: 0, pm_cwd: checkoutDir },
      }))
    )
  )
  const result = await runDeploy(checkoutDir, target, {
    PM2_STATE_FILE: pm2State,
    MIGRATE_PM2_NAMES: '1',
  })

  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /pm2 still knows these pre-OPS-15 names/
  )
})

// A partway delete failure — one of the five old names refuses to delete —
// must escalate exactly like a reload failure, not report success or fail
// silently. This one is transient (`failDeleteOnce`): the forward path's
// own `reload_everything` fails and rolls back, and the rollback's own
// retry of `delete_old_pm2_names` succeeds the second time (the delete
// really does go through then) — the same recoverable shape
// `failReload`/`failReloadOnRetry` already model for an ordinary reload.
test('deploy.sh: MIGRATE_PM2_NAMES set — a transient delete failure rolls back, and the rollback retry finishes the delete', async () => {
  writeDefaultStubs({ failDeleteOnce: 'bot' })
  const { target, checkoutDir } = await setUpRepo()
  const pm2State = join(
    base,
    `pm2-state-migrate-deletefail-${Date.now()}-${Math.random()}.json`
  )
  writeFileSync(
    pm2State,
    JSON.stringify(
      ['api', 'bot', 'worker', 'mcp', 'ops-monitor'].map((name) => ({
        name,
        pm2_env: { status: 'online', restart_time: 0, pm_cwd: checkoutDir },
      }))
    )
  )
  const result = await runDeploy(checkoutDir, target, {
    PM2_STATE_FILE: pm2State,
    MIGRATE_PM2_NAMES: '1',
  })

  const output = result.stdout + result.stderr
  assert.match(output, /pm2 delete bot failed/)
  assert.match(output, /failed to reload/)
  assert.doesNotMatch(output, /deployed .* — every process is online/)
})

// The permanent sibling — the delete never recovers, not even on the
// rollback path's own retry. This is the one that pins the actual bug: a
// partway delete failure used to fall through into the ordinary reload
// loop regardless of whether the delete itself succeeded, starting
// `bloombot-bot` fresh beside the `bot` that refused to delete — two
// Discord gateways, or with `worker` in its place, two processes claiming
// jobs (PLAT-4's own single-instance guarantee). With the fix, neither the
// forward attempt nor the rollback's own retry ever reaches the reload
// loop while `bot` is still stuck, so no `bloombot-*` name is ever started.
test('deploy.sh: MIGRATE_PM2_NAMES set — a delete that never recovers starts no duplicate process, in either attempt', async () => {
  writeDefaultStubs({ failDeleteAlways: 'bot' })
  const { target, checkoutDir } = await setUpRepo()
  const pm2State = join(
    base,
    `pm2-state-migrate-deletefail-always-${Date.now()}-${Math.random()}.json`
  )
  writeFileSync(
    pm2State,
    JSON.stringify(
      ['api', 'bot', 'worker', 'mcp', 'ops-monitor'].map((name) => ({
        name,
        pm2_env: { status: 'online', restart_time: 0, pm_cwd: checkoutDir },
      }))
    )
  )
  const result = await runDeploy(checkoutDir, target, {
    PM2_STATE_FILE: pm2State,
    MIGRATE_PM2_NAMES: '1',
  })

  assert.notEqual(result.code, 0)
  const output = result.stdout + result.stderr
  assert.match(output, /pm2 delete bot failed/)
  assert.match(output, /failed to reload/)
  assert.match(output, /CRITICAL/)
  assert.doesNotMatch(output, /deployed .* — every process is online/)
  const names = JSON.parse(readFileSync(pm2State, 'utf8')).map((a) => a.name)
  assert.ok(names.includes('bot'), 'the old bot must still be present')
  assert.ok(
    !names.includes('bloombot-bot'),
    `a duplicate bloombot-bot was started beside the stranded old one: ${names.join(', ')}`
  )
  assert.ok(
    !names.some((n) => n.startsWith('bloombot-')),
    `no new-named process should have started at all: ${names.join(', ')}`
  )
})

// A droplet that has already run the migration (only the new names present)
// is a no-op for the migration itself — MIGRATE_PM2_NAMES set on it must
// still deploy normally, not fail or double-start anything.
test('deploy.sh: MIGRATE_PM2_NAMES set on an already-migrated droplet is a no-op that still deploys normally', async () => {
  writeDefaultStubs()
  const { target, checkoutDir } = await setUpRepo()
  const pm2State = join(
    base,
    `pm2-state-migrate-noop-${Date.now()}-${Math.random()}.json`
  )
  writeFileSync(
    pm2State,
    JSON.stringify(
      [
        'bloombot-api',
        'bloombot-bot',
        'bloombot-worker',
        'bloombot-mcp',
        'bloombot-ops-monitor',
      ].map((name) => ({
        name,
        pm2_env: { status: 'online', restart_time: 0 },
      }))
    )
  )
  const result = await runDeploy(checkoutDir, target, {
    PM2_STATE_FILE: pm2State,
    MIGRATE_PM2_NAMES: '1',
  })

  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /deployed .* — every process is online/)
  // No old name was ever a candidate for deletion — nothing to delete, only
  // ordinary reloads.
  const names = JSON.parse(readFileSync(pm2State, 'utf8'))
    .map((a) => a.name)
    .sort()
  assert.deepEqual(
    names,
    [
      'bloombot',
      'bloombot-api',
      'bloombot-bot',
      'bloombot-mcp',
      'bloombot-ops-monitor',
      'bloombot-worker',
    ].sort()
  )
})

// The bug this pins: `PREV_SHA` on a droplet that has never been migrated is
// necessarily pre-OPS-15 (the guard has refused every deploy since), so a
// rollback resets the checkout to a commit whose own `ecosystem.config.cjs`
// has no `bloombot-` names at all. `delete_old_pm2_names`'s own
// `assert_ecosystem_has_new_names` used to run unconditionally, so the
// rollback's own retry of `reload_everything` hit that assert and `exit 1`ed
// the whole script before reloading a single process — no CRITICAL message,
// no `confirm_rolled_back_online`, nothing but the migration script's own,
// flatly false "Nothing was deleted." `setUpRepo({ preRenameFirstCommit:
// true })` is what makes this reachable at all: without it, PREV_SHA already
// has the new names and this path can never be observed.
test("deploy.sh: MIGRATE_PM2_NAMES set — a post-reload health-check failure on an unmigrated PREV_SHA rolls back correctly, not via the migration script's own exit", async () => {
  writeDefaultStubs({ stayOffline: 'bloombot-mcp' })
  const { target, checkoutDir } = await setUpRepo({
    preRenameFirstCommit: true,
  })
  const pm2State = join(
    base,
    `pm2-state-migrate-rollback-${Date.now()}-${Math.random()}.json`
  )
  writeFileSync(
    pm2State,
    JSON.stringify(
      ['api', 'bot', 'worker', 'mcp', 'ops-monitor'].map((name) => ({
        name,
        pm2_env: { status: 'online', restart_time: 0, pm_cwd: checkoutDir },
      }))
    )
  )
  const result = await runDeploy(checkoutDir, target, {
    PM2_STATE_FILE: pm2State,
    MIGRATE_PM2_NAMES: '1',
  })

  assert.notEqual(result.code, 0)
  const output = result.stdout + result.stderr
  assert.doesNotMatch(output, /Nothing was deleted/)
  assert.match(output, /unhealthy after the reload/)
  assert.match(output, /confirming the previous commit is actually online/)
  assert.match(output, /CRITICAL/)
  assert.match(output, /pm2 still reports these as not online/)
  assert.match(output, /mcp/)
})

// OPS-16 must-fix 4 — the unattended path has no human left to check
// `pm2 describe <name>` before confirming, so `delete_old_pm2_names` checks
// pm2's own `pm_cwd` itself: only a name whose `pm_cwd` is this checkout's
// own directory is this deploy's own process. `worker`, seeded with a
// different `pm_cwd`, must be left alone — not deleted, not reported as a
// failure of this deploy — while every other old name (whose `pm_cwd`
// matches) is migrated normally.
test('deploy.sh: MIGRATE_PM2_NAMES set — an old name whose pm_cwd does not match this checkout is left alone, not deleted', async () => {
  writeDefaultStubs()
  const { target, checkoutDir } = await setUpRepo()
  const pm2State = join(
    base,
    `pm2-state-migrate-wrongcwd-${Date.now()}-${Math.random()}.json`
  )
  const seeds = [
    { name: 'api', cwd: checkoutDir },
    { name: 'bot', cwd: checkoutDir },
    { name: 'worker', cwd: '/opt/some-other-project' },
    { name: 'mcp', cwd: checkoutDir },
    { name: 'ops-monitor', cwd: checkoutDir },
  ]
  writeFileSync(
    pm2State,
    JSON.stringify(
      seeds.map(({ name, cwd }) => ({
        name,
        pm2_env: { status: 'online', restart_time: 0, pm_cwd: cwd },
      }))
    )
  )
  const result = await runDeploy(checkoutDir, target, {
    PM2_STATE_FILE: pm2State,
    MIGRATE_PM2_NAMES: '1',
  })

  assert.equal(result.code, 0, result.stdout + result.stderr)
  const output = result.stdout + result.stderr
  assert.match(output, /pm_cwd/)
  assert.match(output, /worker/)
  const names = JSON.parse(readFileSync(pm2State, 'utf8')).map((a) => a.name)
  // The mismatched-cwd `worker` survives, untouched.
  assert.ok(
    names.includes('worker'),
    `worker with a mismatched pm_cwd must not be deleted: ${names.join(', ')}`
  )
  // Every other old name — matching this checkout's own pm_cwd — was
  // migrated normally.
  for (const old of ['api', 'bot', 'mcp', 'ops-monitor']) {
    assert.ok(!names.includes(old), `${old} should have been deleted`)
  }
  for (const migrated of [
    'bloombot-api',
    'bloombot-bot',
    'bloombot-mcp',
    'bloombot-ops-monitor',
  ]) {
    assert.ok(names.includes(migrated), `${migrated} should have started`)
  }
})
