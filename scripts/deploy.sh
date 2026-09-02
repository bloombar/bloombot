#!/usr/bin/env bash
#
# Bloombot deployment (OPS-7, OPS-8).
#
# This script runs ON the droplet. The CI workflow pipes it in over ssh so the
# script that executes is always the one from the commit being deployed:
#
#   ssh <user>@<host> 'bash -s -- <commit-sha>' < scripts/deploy.sh
#
# It updates the existing git checkout to an exact commit, installs
# dependencies only when they changed, builds the TypeScript workspace,
# applies the platform's database migration exactly once (OPS-8: before any
# process that would otherwise race to apply it starts), then reloads every
# supervised process — the legacy Python bot plus the four Node processes
# `ecosystem.config.cjs` names (API, bot, worker, MCP server) and OPS-12's
# alerting monitor — verifying each one stayed up and rolling every one of
# them back to the previous commit if any did not.
#
# It never touches untracked files: `.env`, `data/*.db` and `logs/` are left
# exactly as they are, and `git clean` is deliberately never run. It also
# never runs migrate.py, which drops and recreates tables — that guard
# predates this script and still applies to the Python side only; the
# TypeScript migration below (`packages/db`'s own `runMigrations`) is
# additive, per-file and idempotent (`packages/db/src/migrate.ts`'s own
# module comment), the same reason it is safe to apply on every deploy that
# has a new one rather than gated like a dependency install.
#
# Rollback covers the git checkout, both dependency trees, the TypeScript
# build and every pm2 process — but not a migration that fails partway
# through: `runMigrations` applies whatever it reaches before the failure and
# there is no automatic way to undo that (the same limit `npm run db:migrate`
# already has run by hand). See docs/CUTOVER.md's own "rollback does not
# un-migrate" note for what an operator does about that case.
#
# Environment overrides (all optional):
#   APP_DIR          checkout to deploy       (default $HOME/discord-channel-manager)
#   PM2_APP           pm2 process name for the Python bot (default bloombot)
#   PM2_INTERPRETER  python the bot runs under (default: the pipenv virtualenv's
#                    python if this checkout has one, else python3)
#   GIT_REMOTE       remote to fetch from     (default origin)
#   HEALTH_WAIT      seconds to watch a process after reload (default 15)

set -euo pipefail

TARGET_SHA="${1:-}"
APP_DIR="${APP_DIR:-$HOME/discord-channel-manager}"
PM2_APP="${PM2_APP:-bloombot}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
HEALTH_WAIT="${HEALTH_WAIT:-15}"

# OPS-8 — the four PLAT-4 processes plus OPS-12's own monitor, in the exact
# names `ecosystem.config.cjs` gives them. Reloaded and health-checked
# individually so a bad build of one does not bounce the other three
# (`ecosystem.config.cjs`'s own module comment).
NODE_APPS=(api bot worker mcp ops-monitor)
# The subset of NODE_APPS with a real `/health` endpoint `scripts/health-check.mjs`
# can poll — `ops-monitor` is the watcher, not something watched the same way
# (its own module comment: it has no HTTP surface of its own).
HEALTH_CHECKED_APPS=(api bot worker mcp)

log() { printf '==> %s\n' "$*"; }
fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

[ -n "$TARGET_SHA" ] || fail "usage: deploy.sh <commit-sha>"

cd "$APP_DIR" 2>/dev/null || fail "app directory not found: $APP_DIR"
git rev-parse --git-dir >/dev/null 2>&1 || fail "not a git checkout: $APP_DIR"

for cmd in git node npm pm2; do
  command -v "$cmd" >/dev/null 2>&1 || fail "required command not on PATH: $cmd"
done

# Which python does the bot actually run under? The project is pipenv-managed,
# so on a host where `pipenv --venv` resolves for this checkout, that
# virtualenv's python is what ends up executing the bot — the system python3
# generally cannot even import discord.py. Detect it rather than assume; the
# banner pipenv prints goes to stderr, so stdout is just the path.
PIPENV_VENV=""
if command -v pipenv >/dev/null 2>&1; then
  PIPENV_VENV="$(pipenv --venv 2>/dev/null || true)"
  [ -x "${PIPENV_VENV}/bin/python" ] || PIPENV_VENV=""
fi
if [ -z "${PM2_INTERPRETER:-}" ]; then
  if [ -n "$PIPENV_VENV" ]; then
    PM2_INTERPRETER="$PIPENV_VENV/bin/python"
  else
    PM2_INTERPRETER="python3"
  fi
fi

# Refuse to deploy over hand edits. Someone editing bot_config.yml (or any other
# tracked file) directly on the server is a real situation, and silently
# resetting it away would lose their work with no trace.
if ! git diff --quiet || ! git diff --cached --quiet; then
  {
    echo "ERROR: the checkout at $APP_DIR has local modifications to tracked files."
    echo "Deploying would discard them. Commit them, or revert them, then re-run."
    echo
    git status --porcelain
    echo
    git --no-pager diff --stat HEAD
  } >&2
  exit 1
fi

PREV_SHA="$(git rev-parse HEAD)"

log "fetching $GIT_REMOTE"
git fetch --prune "$GIT_REMOTE"
git cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null ||
  fail "commit $TARGET_SHA does not exist after fetching $GIT_REMOTE"

# Dependency installs are slow and can disturb a working environment, so run one
# only when the pinned dependency files actually differ between the two commits.
DEPS_CHANGED=false
if ! git diff --quiet "$PREV_SHA" "$TARGET_SHA" -- Pipfile.lock requirements.txt; then
  DEPS_CHANGED=true
fi
NODE_DEPS_CHANGED=false
if ! git diff --quiet "$PREV_SHA" "$TARGET_SHA" -- package-lock.json; then
  NODE_DEPS_CHANGED=true
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Installs dependencies into whichever environment this host actually uses —
# the pipenv virtualenv detected above, or plain pip when there is none.
install_deps() {
  if [ -n "$PIPENV_VENV" ]; then
    log "installing dependencies with pipenv ($PIPENV_VENV)"
    pipenv install --deploy
  else
    log "no pipenv virtualenv here; installing with $PM2_INTERPRETER -m pip"
    "$PM2_INTERPRETER" -m pip install --requirement requirements.txt
  fi
}

# Reads one field of a named pm2 app record out of `pm2 jlist`. Parsing is
# done with node, which pm2 already depends on. Exit 3 means pm2 does not
# know this app.
pm2_field() {
  pm2 jlist | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      const [name, field] = process.argv.slice(1);
      let apps = [];
      try {
        apps = JSON.parse(raw.trim() || "[]");
      } catch {
        process.exit(2);
      }
      const app = apps.find((a) => a && a.name === name);
      if (!app) process.exit(3);
      const env = app.pm2_env || {};
      process.stdout.write(String(env[field] ?? ""));
    });
  ' "$1" "$2"
}

pm2_knows_app() { pm2_field "$1" status >/dev/null 2>&1; }

# Reloads a named app if pm2 already knows it, or starts just that one app
# from ecosystem.config.cjs — `--only` so bootstrapping the first app on a
# fresh droplet never starts every app in the file at once, some of which
# might not have credentials configured yet.
start_or_reload() {
  local name="$1"
  if pm2_knows_app "$name"; then
    pm2 reload "$name" --update-env
  else
    log "pm2 does not know $name yet; starting it from ecosystem.config.cjs"
    pm2 start ecosystem.config.cjs --only "$name"
  fi
}

# Reloads every supervised process — the Python bot plus OPS-8's Node
# processes — and saves the pm2 process list once, after all of them. Used
# both for the real deploy and for rolling every one of them back to the
# previous commit.
reload_everything() {
  start_or_reload "$PM2_APP"
  for name in "${NODE_APPS[@]}"; do
    start_or_reload "$name"
  done
  pm2 save
}

# Restores the checkout (and, if they were reinstalled, the dependencies and
# the TypeScript build) to the commit that was deployed before this run.
# Does not attempt to undo a database migration — see this file's own header
# comment for why.
#
# Rehearsal finding (OPS-10) — every step here used to run as a plain
# statement, so a failure partway through this function (the rebuild in
# particular: `dist/` for the previous commit no longer exists once the
# failed deploy's own `npm run build` overwrote it, so *this* build is not
# optional the way the very first one further down is) hit `set -e` and
# killed the whole script with no message beyond whatever the failing
# command itself printed — indistinguishable, from the log alone, from an
# ordinary deploy failure that never touched a running process. It is not
# ordinary: if any process was already reloaded onto the broken commit
# before this function ran, it is still running that broken code, `dist/`
# has nothing to serve the previous version from, and there is no
# `restore_previous_checkout` for `restore_previous_checkout` itself. Each
# step below is checked explicitly and fails loudly, distinctly, if the
# rollback itself cannot complete — see docs/CUTOVER.md's own "if the
# rollback itself fails" for what an operator does next.
restore_previous_checkout() {
  log "restoring checkout to ${PREV_SHA:0:8}"
  if ! git reset --hard "$PREV_SHA"; then
    fail "CRITICAL: could not reset the checkout at $APP_DIR back to
${PREV_SHA:0:8}. The working tree may be left partway through a reset — do
not re-run this script against it; inspect $APP_DIR by hand first."
  fi
  if [ "$DEPS_CHANGED" = true ] && ! install_deps; then
    fail "CRITICAL: reset the checkout back to ${PREV_SHA:0:8} but could not
reinstall its python dependencies. No process was reloaded by this failure —
the bot already running is untouched — but a later deploy attempt will start
from a checkout whose dependencies do not match its own commit. Fix the
python environment before retrying."
  fi
  if [ "$NODE_DEPS_CHANGED" = true ]; then
    log "reinstalling node dependencies for the previous commit"
    if ! npm ci; then
      fail "CRITICAL: reset the checkout back to ${PREV_SHA:0:8} but could not
reinstall its node dependencies. See the python case above for what this
does and does not mean for whatever is currently running."
    fi
  fi
  log "rebuilding the TypeScript workspace for the previous commit"
  if ! npm run build; then
    fail "CRITICAL: reset the checkout back to ${PREV_SHA:0:8} but the
TypeScript workspace failed to rebuild at that commit. If any Node process
had already been reloaded onto the broken deploy before this rollback ran,
it is still running that broken code right now — dist/ has not been
restored to a working build, so reloading it again would not help. Fix the
build at ${PREV_SHA:0:8} by hand (\`npm run build\` from $APP_DIR), confirm
it succeeds standalone, then reload the affected processes yourself
(\`pm2 reload <name> --update-env\`) — do not re-run this script until the
build works on its own."
  fi
  # PLAT-4's fourth process is a static build, not a pm2 app — nginx serves
  # `apps/web/dist` directly, so restoring the *previous* commit's panel is
  # this rebuild, not a reload. The root `npm run build` above does not
  # produce it (`package.json`'s own `pree2e` script needs this exact,
  # separate call for the same reason); skipping it here would leave nginx
  # serving whichever panel the *failed* deploy last built, silently
  # mismatched against whatever API/bot/worker/mcp were just rolled back to.
  log "rebuilding the control panel for the previous commit"
  if ! npm run build --workspace apps/web; then
    fail "CRITICAL: reset the checkout and the Node workspace back to
${PREV_SHA:0:8} but the control panel itself failed to rebuild. nginx is
still serving whichever build the failed deploy last produced — mismatched
against the API this rollback just restored. Fix the panel's build at
${PREV_SHA:0:8} by hand (\`npm run build --workspace apps/web\`) before
anyone relies on the panel again; the four Node processes above are already
correctly rolled back regardless."
  fi
}

# The pm2-level half of a health check, shared by the Python bot and every
# Node process below: a process that crashes on start does not disappear —
# pm2 restarts it in a loop — so "healthy" is "still online, and pm2 has not
# had to restart it again since the reload", which is what a climbing
# restart_time means. Prints its own diagnostics and returns non-zero rather
# than failing the whole script, so a caller can collect every unhealthy
# app's name before deciding whether to roll back.
check_pm2_health() {
  local name="$1" restarts_before="$2"
  local status_after restarts_after
  status_after="$(pm2_field "$name" status || true)"
  restarts_after="$(pm2_field "$name" restart_time || true)"
  if [ "$status_after" != "online" ] || [ "$restarts_after" != "$restarts_before" ]; then
    {
      echo "ERROR: $name is unhealthy after the reload"
      echo "  status:   ${status_after:-unknown}"
      echo "  restarts: ${restarts_before:-unknown} -> ${restarts_after:-unknown}"
      echo "Last log lines:"
    } >&2
    pm2 logs "$name" --lines 50 --nostream >&2 || true
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------

log "deploying ${PREV_SHA:0:8} -> ${TARGET_SHA:0:8} in $APP_DIR"
git reset --hard "$TARGET_SHA"

if [ "$DEPS_CHANGED" = true ]; then
  log "python dependency files changed"
  install_deps
else
  log "python dependency files unchanged; skipping install"
fi

# Check the interpreter pm2 will use can import the bot's dependencies BEFORE
# restarting anything. If the environment probe above installed into a different
# environment than pm2 runs, this catches it while the old process is still
# happily serving.
log "checking the bot's python ($PM2_INTERPRETER) can import its dependencies"
if ! "$PM2_INTERPRETER" - <<'PY'; then
import importlib.util
import sys

required = ("discord", "openai", "yaml", "peewee", "dotenv")
missing = [m for m in required if importlib.util.find_spec(m) is None]
if missing:
    sys.stderr.write("cannot import: %s\n" % ", ".join(missing))
    sys.exit(1)
PY
  restore_previous_checkout
  fail "$PM2_INTERPRETER cannot import the bot's dependencies, so the new code
would crash on start. Nothing was restarted and the checkout was put back.
Install the dependencies into that environment, or set PM2_INTERPRETER to the
python the bot actually runs under."
fi

if [ "$NODE_DEPS_CHANGED" = true ]; then
  log "node dependency files changed"
  npm ci
else
  log "node dependency files unchanged; skipping npm ci"
fi

# tsc --build is incremental (packages/*/tsconfig.json's own `composite`
# setting), so this is cheap even when nothing changed — unlike the
# dependency installs above, it is never gated on a diff.
log "building the TypeScript workspace"
if ! npm run build; then
  restore_previous_checkout
  fail "the TypeScript workspace failed to build at ${TARGET_SHA:0:8}. Nothing
was restarted and the checkout was put back."
fi

# PLAT-4's fourth process is a static build, not one of the pm2 apps below —
# nginx serves `apps/web/dist` directly (docs/DEPLOY_DROPLET.md's own §5).
# The root build above does not produce it — `package.json`'s own `pree2e`
# script needs this exact, separate call for the same reason — so a deploy
# that skipped this would leave nginx serving a stale panel indefinitely
# while every pm2 app happily reloaded onto the new commit.
log "building the control panel"
if ! npm run build --workspace apps/web; then
  restore_previous_checkout
  fail "the control panel failed to build at ${TARGET_SHA:0:8}. Nothing was
restarted and the checkout was put back."
fi

# OPS-8 — applied exactly once, here, before any of the four Node processes
# below starts — never left for whichever one of them wins the race, which
# is what every one of their own `main()` calling `runMigrations` at startup
# would otherwise be. `--i-know`: this is the live database and applying its
# migration is exactly what a deploy is for (`packages/db/src/run-migrate.ts`'s
# own guard exists for an *accidental* invocation, not this one).
log "applying the platform database migration"
if ! node packages/db/dist/run-migrate.js --i-know; then
  restore_previous_checkout
  fail "the database migration failed at ${TARGET_SHA:0:8}. Nothing was
restarted and the checkout was put back — but see this file's own header
comment: a migration that fails partway through is not itself rolled back.
Check the database before retrying."
fi

log "reloading every supervised process"
reload_everything

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

# One shared wait for every process, the same `sleep` this script has always
# given the Python bot — restarting five processes at once and then checking
# each is faster than watching each in turn, and pm2's own restart_time is
# per-app regardless of when the others were reloaded.
restarts_before_bot="$(pm2_field "$PM2_APP" restart_time || true)"
declare -A restarts_before
for name in "${NODE_APPS[@]}"; do
  restarts_before["$name"]="$(pm2_field "$name" restart_time || true)"
done

log "watching every process for ${HEALTH_WAIT}s"
sleep "$HEALTH_WAIT"

UNHEALTHY=()
check_pm2_health "$PM2_APP" "$restarts_before_bot" || UNHEALTHY+=("$PM2_APP")
for name in "${NODE_APPS[@]}"; do
  check_pm2_health "$name" "${restarts_before[$name]}" || UNHEALTHY+=("$name")
done

# The pm2-level check above only proves a process is still running — OPS-8's
# own text is "running supervised", not merely "up" (COST-5's own
# running-vs-working distinction). `scripts/health-check.mjs` polls the real
# `/health` endpoint of each process that has one; a process that is online
# by pm2's own account but whose database is unreachable, or whose gateway
# has dropped, fails this even though `check_pm2_health` above saw nothing
# wrong.
if [ ${#HEALTH_CHECKED_APPS[@]} -gt 0 ]; then
  log "checking ${HEALTH_CHECKED_APPS[*]}'s own /health endpoints"
  # `scripts/health-check.mjs`'s own stdout already names which of these
  # failed and how (`describeResult`'s own "responded 503"/"unreachable
  # (...)" per app) — printed to this log directly rather than re-parsed
  # here, so `UNHEALTHY` gets one summary entry rather than four that would
  # otherwise wrongly claim every one of them failed when only one did.
  if ! node scripts/health-check.mjs; then
    UNHEALTHY+=("one or more of ${HEALTH_CHECKED_APPS[*]} (health endpoint — see above)")
  fi
fi

if [ ${#UNHEALTHY[@]} -gt 0 ]; then
  echo "ERROR: unhealthy after the reload: ${UNHEALTHY[*]}" >&2
  restore_previous_checkout
  reload_everything
  fail "rolled back to ${PREV_SHA:0:8}; every process is running the previous commit"
fi

log "deployed ${TARGET_SHA:0:8} — every process is online"
