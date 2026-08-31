#!/usr/bin/env bash
#
# Bloombot deployment (OPS-7).
#
# This script runs ON the droplet. The CI workflow pipes it in over ssh so the
# script that executes is always the one from the commit being deployed:
#
#   ssh <user>@<host> 'bash -s -- <commit-sha>' < scripts/deploy.sh
#
# It updates the existing git checkout to an exact commit, installs dependencies
# only when they changed, reloads the pm2 process, and verifies the bot stayed
# up — rolling the checkout back and restarting the previous version if it did
# not.
#
# It never touches untracked files: `.env`, `data/*.db` and `logs/` are left
# exactly as they are, and `git clean` is deliberately never run. It also never
# runs migrate.py, which drops and recreates tables.
#
# Environment overrides (all optional):
#   APP_DIR          checkout to deploy       (default $HOME/discord-channel-manager)
#   PM2_APP          pm2 process name         (default bloombot)
#   PM2_INTERPRETER  python the bot runs under (default: the pipenv virtualenv's
#                    python if this checkout has one, else python3)
#   GIT_REMOTE       remote to fetch from     (default origin)
#   HEALTH_WAIT      seconds to watch the process after reload (default 15)

set -euo pipefail

TARGET_SHA="${1:-}"
APP_DIR="${APP_DIR:-$HOME/discord-channel-manager}"
PM2_APP="${PM2_APP:-bloombot}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
HEALTH_WAIT="${HEALTH_WAIT:-15}"

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

for cmd in git node pm2; do
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

# Reads one field of the pm2 app record out of `pm2 jlist`. Parsing is done with
# node, which pm2 already depends on. Exit 3 means pm2 does not know this app.
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
  ' "$PM2_APP" "$1"
}

pm2_knows_app() { pm2_field status >/dev/null 2>&1; }

# Restores the checkout (and, if they were reinstalled, the dependencies) to the
# commit that was deployed before this run.
restore_previous_checkout() {
  log "restoring checkout to ${PREV_SHA:0:8}"
  git reset --hard "$PREV_SHA"
  if [ "$DEPS_CHANGED" = true ]; then
    install_deps
  fi
}

start_or_reload() {
  if pm2_knows_app; then
    pm2 reload "$PM2_APP" --update-env
  else
    log "pm2 does not know $PM2_APP yet; starting from ecosystem.config.cjs"
    pm2 start ecosystem.config.cjs
  fi
  pm2 save
}

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------

log "deploying ${PREV_SHA:0:8} -> ${TARGET_SHA:0:8} in $APP_DIR"
git reset --hard "$TARGET_SHA"

if [ "$DEPS_CHANGED" = true ]; then
  log "dependency files changed"
  install_deps
else
  log "dependency files unchanged; skipping install"
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

log "reloading pm2 app $PM2_APP"
start_or_reload

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------
#
# A bot that crashes on start does not disappear — pm2 restarts it in a loop. So
# health is "still online, and pm2 has not had to restart it again since the
# reload", which is what a climbing restart_time means.

restarts_before="$(pm2_field restart_time || true)"
log "watching $PM2_APP for ${HEALTH_WAIT}s (restarts so far: ${restarts_before:-unknown})"
sleep "$HEALTH_WAIT"
status_after="$(pm2_field status || true)"
restarts_after="$(pm2_field restart_time || true)"

if [ "$status_after" != "online" ] || [ "$restarts_after" != "$restarts_before" ]; then
  {
    echo "ERROR: $PM2_APP is unhealthy after the reload"
    echo "  status:   ${status_after:-unknown}"
    echo "  restarts: ${restarts_before:-unknown} -> ${restarts_after:-unknown}"
    echo "Last log lines:"
  } >&2
  pm2 logs "$PM2_APP" --lines 50 --nostream >&2 || true

  restore_previous_checkout
  start_or_reload
  fail "rolled back to ${PREV_SHA:0:8}; the bot is running the previous commit"
fi

log "deployed ${TARGET_SHA:0:8} — $PM2_APP is online"
