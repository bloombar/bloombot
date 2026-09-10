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
#   APP_DIR             checkout to deploy    (default $HOME/discord-channel-manager)
#   PM2_APP             pm2 process name for the Python bot (default bloombot).
#                        Set it EMPTY (PM2_APP=) on a droplet that has finished
#                        the cutover: the Python bot, its dependency install
#                        and its interpreter check are then all skipped.
#   PM2_INTERPRETER     python the bot runs under (default: the pipenv
#                        virtualenv's python if this checkout has one, else
#                        python3)
#   GIT_REMOTE          remote to fetch from  (default origin)
#   HEALTH_WAIT         seconds to watch a process after reload (default 15)
#   BUILD_HEAP_MB       V8 old-space ceiling for the two builds, in MB
#                        (default: 1536 on a host with under 2 GB of RAM,
#                        else V8's own)
#   MIGRATE_PM2_NAMES   OPS-16 — off by default (empty/unset). Any non-empty
#                        value turns this run into the OPS-15 pm2 rename
#                        migration itself: the old-name guard below does not
#                        abort, and once the build has succeeded — never
#                        before — this deploy deletes the five old bare-named
#                        pm2 processes and lets the ordinary reload start
#                        their `bloombot-` prefixed replacements. A migration
#                        is ONE-WAY: renamed pm2 processes are not part of
#                        what a rollback undoes (see `restore_previous_checkout`'s
#                        own scope, and `reload_everything`'s comment below).
#                        Set this for exactly one deploy — the one that
#                        migrates an unmigrated droplet — never as a standing
#                        default; see `scripts/migrate-pm2-names.sh`'s own
#                        header for the hazard a rename carries.

set -euo pipefail

TARGET_SHA="${1:-}"
APP_DIR="${APP_DIR:-$HOME/discord-channel-manager}"
# The legacy Python bot's own pm2 process. Set `PM2_APP=` (empty) on a
# droplet that has finished the cutover and no longer runs it: an empty value
# means "there is no Python bot here", and `reload_everything` skips it
# entirely. Without that escape hatch a cut-over droplet is worse off than a
# missing process would suggest — pm2 still remembers a *stopped* `bloombot`
# from before the cutover, so `pm2 reload` would start the retired bot again
# on every deploy, putting a second answering process back on the same
# database that docs/CUTOVER.md just moved off it.
PM2_APP="${PM2_APP-bloombot}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
HEALTH_WAIT="${HEALTH_WAIT:-15}"
# OPS-16 — empty/unset means "off"; see this file's own header for what a
# non-empty value does.
MIGRATE_PM2_NAMES="${MIGRATE_PM2_NAMES:-}"
# Heap ceiling for the two builds below, in MB. V8 sizes its old-space from
# total system memory, and on a 1 GB droplet it settles around 480 MB — far
# under what `tsc --build` needs across this workspace, so the build dies with
# "Ineffective mark-compacts near heap limit" and the deploy rolls back. Swap
# does not help: the cap is V8's own, not the kernel's. Default to 1536 MB on
# a box with less than 2 GB of RAM, and leave V8's own default alone on a
# larger one, where it is already generous. Override with BUILD_HEAP_MB.
if [ -z "${BUILD_HEAP_MB:-}" ] && [ -r /proc/meminfo ]; then
  total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  if [ -n "$total_kb" ] && [ "$total_kb" -lt 2097152 ]; then
    BUILD_HEAP_MB=1536
  fi
fi

# OPS-8 — the four PLAT-4 processes plus OPS-12's own monitor, in the exact
# names `ecosystem.config.cjs` gives them. Reloaded and health-checked
# individually so a bad build of one does not bounce the other three
# (`ecosystem.config.cjs`'s own module comment). OPS-15 — `bloombot-`
# prefixed, matching that file's own rename; a droplet still on the old,
# bare names needs `scripts/migrate-pm2-names.sh` run once first (see the
# half-migrated guard below).
NODE_APPS=(bloombot-api bloombot-bot bloombot-worker bloombot-mcp bloombot-ops-monitor)
# The subset of NODE_APPS with a real `/health` endpoint `scripts/health-check.mjs`
# can poll — `ops-monitor` is the watcher, not something watched the same way
# (its own module comment: it has no HTTP surface of its own).
HEALTH_CHECKED_APPS=(bloombot-api bloombot-bot bloombot-worker bloombot-mcp)
# Every process this deploy supervises, in reload order: the legacy Python bot
# first when this droplet still has one, then OPS-8's Node processes. Derived
# once here so the reload loop, the restart-count snapshot, the health check
# and the rollback's own confirmation all agree on the list — an empty PM2_APP
# must drop out of all four, and a `for name in "$PM2_APP" ...` in any one of
# them would instead iterate an empty string and report `""` as unhealthy.
SUPERVISED_APPS=()
if [ -n "$PM2_APP" ]; then
  SUPERVISED_APPS+=("$PM2_APP")
fi
SUPERVISED_APPS+=("${NODE_APPS[@]}")

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
# might not have credentials configured yet. Returns non-zero (never exits
# directly) if pm2 itself reports failure, so a caller decides what "this
# one app failed to (re)start" means at that point in the script.
#
# Rehearsal finding — this used to run `pm2 reload`/`pm2 start` as a bare
# statement, so a failure there killed the whole script immediately under
# `set -e`: no health check, no rollback, nothing beyond whatever pm2 itself
# printed to stderr. Reproduced by making one `pm2 reload` fail mid-loop —
# the result was some processes already reloaded onto the new commit and
# others not, `pm2 save` never reached, and the operator-visible output was
# one pm2 error line with no indication anything needed to be rolled back.
# Runs `npm run build` under BUILD_HEAP_MB's own heap ceiling when one
# applies, so both build call sites (the forward path and the rollback path)
# get it without either having to remember. Any arguments are passed straight
# through, which is what the control-panel build's `--workspace apps/web`
# needs. NODE_OPTIONS is set only for this call rather than exported once at
# the top of the script: it must not reach the long-lived pm2 processes
# started further down, which have no need of a raised ceiling and every
# reason not to inherit a build-time flag.
npm_build() {
  if [ -n "${BUILD_HEAP_MB:-}" ]; then
    NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=$BUILD_HEAP_MB" npm run build "$@"
  else
    npm run build "$@"
  fi
}

start_or_reload() {
  local name="$1"
  if pm2_knows_app "$name"; then
    if ! pm2 reload "$name" --update-env; then
      echo "ERROR: pm2 reload $name failed" >&2
      return 1
    fi
  else
    log "pm2 does not know $name yet; starting it from ecosystem.config.cjs"
    if ! pm2 start ecosystem.config.cjs --only "$name"; then
      echo "ERROR: pm2 start $name failed" >&2
      return 1
    fi
  fi
}

# Reloads every supervised process — the Python bot plus OPS-8's Node
# processes — trying each one even if an earlier one failed, so a caller
# sees every failure at once rather than stopping at the first (the same
# "collect every unhealthy name" shape `check_pm2_health`'s own callers
# already use below). Returns non-zero, never exits directly, if any
# failed — both call sites (the forward path and the rollback path)
# decide separately what a reload failure means at that point. `pm2 save`
# only runs once every reload succeeded; saving a process list mid-failure
# would persist pm2's own memory of a half-reloaded deploy across a
# restart.
reload_everything() {
  local failed=()
  # OPS-16 — when this deploy is migrating pm2's names (MIGRATE_PM2_NAMES),
  # the old bare-named processes are deleted here, first, immediately before
  # the reload loop below — never earlier, since the build above this call
  # is what proves the new names are safe to start at all. `start_or_reload`
  # then sees "pm2 does not know bloombot-api yet" for each one and starts
  # it fresh from ecosystem.config.cjs, rather than reloading a lingering
  # bare-named process that is about to be replaced. `delete_old_pm2_names`
  # (sourced from scripts/migrate-pm2-names.sh above) is idempotent — once
  # the old names are gone, including on the rollback path's own retry of
  # this same function below, it finds nothing to do. A delete failure is
  # treated exactly like a reload failure: collected into `failed` and
  # reported the same way, never exiting this function directly, so the
  # caller's own rollback-and-report path handles both identically. This is
  # also the one-way half of the migration: a rollback further down resets
  # the *checkout*, not pm2's process names — once deleted here, the old
  # names do not come back even if this deploy is later rolled back.
  if [ -n "$MIGRATE_PM2_NAMES" ] && ! delete_old_pm2_names; then
    failed+=("pm2 rename migration (deleting the old bare names)")
  fi
  # SUPERVISED_APPS already omits the Python bot on a cut-over droplet — see
  # its own comment at the top of this script.
  for name in "${SUPERVISED_APPS[@]}"; do
    start_or_reload "$name" || failed+=("$name")
  done
  if [ ${#failed[@]} -gt 0 ]; then
    echo "ERROR: failed to reload: ${failed[*]}" >&2
    return 1
  fi
  # Deliberately not `if ! reload_everything; then ...` material: every
  # process above reloaded fine, so a `pm2 save` failure (a full disk
  # writing `~/.pm2/dump.pm2`, say) is not a reload failure and must not
  # be treated as one — cheap-fix finding: this used to be the bare, last
  # statement in this function, so its own exit status silently became
  # `reload_everything`'s own return value, and a caller reading a `pm2
  # save` failure as "processes failed to reload" would roll back a
  # completely healthy deploy and then fail the rollback too, for a reason
  # that had nothing to do with either. `pm2 save` failing only means the
  # process list will not survive a reboot (`pm2 resurrect`) until it
  # succeeds — worth a loud warning, not a rollback.
  pm2 save || echo "WARNING: pm2 save failed — the process list will not survive a reboot until this succeeds" >&2
}

# Restores the checkout (and, if they were reinstalled, the dependencies and
# the TypeScript build) to the commit that was deployed before this run.
# Does not attempt to undo a database migration — see this file's own header
# comment for why. It also does not, and cannot, undo an OPS-16 pm2 rename:
# a migration is one-way. If `MIGRATE_PM2_NAMES` deleted the old bare-named
# pm2 processes before this rollback ran, this function rolls the *checkout*
# back to the previous commit, and `reload_everything` below then reloads
# the *new*, bloombot-prefixed names onto it — they exist by then, so
# `start_or_reload` reloads rather than starts them. The process names stay
# renamed even though the code just rolled back; `MIGRATE_PM2_NAMES` migrates
# names, a rollback rolls back code, and the two are independent.
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
  if ! npm_build; then
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
  if ! npm_build --workspace apps/web; then
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

# Confirms every process actually came back up after a rollback's own
# `reload_everything` call, before this script tells an operator the
# rollback succeeded.
#
# Cheap-fix finding — the message at the bottom of this script used to say
# "rolled back ...; every process is running the previous commit"
# unconditionally, the moment `reload_everything` returned, with no check
# at all — not even the `check_pm2_health` this file already has twenty
# lines up. If the previous commit is itself broken (a bad dependency still
# installed, an environment problem introduced before this deploy), the
# operator is told the rollback worked while the stack crash-loops.
#
# A short, fixed wait (capped at 10s, not the full $HEALTH_WAIT) is enough
# to catch a process that fails immediately; this is a final "did the
# rollback itself work" check, not a second full health pass on a version
# this script has typically already run once before.
confirm_rolled_back_online() {
  local wait_s=$HEALTH_WAIT
  [ "$wait_s" -gt 10 ] && wait_s=10
  log "confirming the previous commit is actually online (${wait_s}s)"
  sleep "$wait_s"
  local still_broken=()
  local name status
  for name in "${SUPERVISED_APPS[@]}"; do
    status="$(pm2_field "$name" status || true)"
    [ "$status" = "online" ] || still_broken+=("$name (${status:-unknown})")
  done
  if [ ${#still_broken[@]} -gt 0 ]; then
    fail "CRITICAL: rolled the checkout back to ${PREV_SHA:0:8} and reloaded
every process, but pm2 still reports these as not online: ${still_broken[*]}.
The rollback did not actually restore a working previous commit — this
needs a human to look, not a re-run of this script."
  fi
}

# OPS-15 — the pm2-name rename's own hazard: a droplet where the migration
# in `scripts/migrate-pm2-names.sh` has not been run yet still has every
# process under its old, bare name, and `start_or_reload` cannot tell that
# apart from "pm2 has never heard of this app" — it would start the new,
# `bloombot-` prefixed name fresh, alongside the old one still running.
# Two `bloombot-worker`-and-`worker` both claiming jobs breaks PLAT-4's
# single-instance guarantee structurally, not just untidily, and the two
# new processes cannot even bind their health ports (the old ones still
# hold them), so they crash-loop, the health check below fails, and the
# rollback lands on a half-renamed droplet instead of a clean one.
#
# Checked once, before anything else in this deploy touches pm2, against
# every *old* name this rename actually retired — deliberately hand-listed
# here rather than derived from `NODE_APPS`, so a future rename of this
# list does not silently widen what this guard refuses to tolerate.
# `bloombot` (the legacy Python bot) is excluded on purpose: it was never
# renamed, so it can never collide with itself.
OLD_BARE_NAMES=(api bot worker mcp ops-monitor)

# Aborts the deploy if pm2 knows ANY of the old bare names — not only when
# both the old and the new name are present. Rework finding: the original
# version of this guard only fired on that both-present shape, which is
# exactly what an *unmigrated* droplet never has (it knows only the old
# names, never the new ones) — the one case this guard exists to catch. An
# unmigrated droplet passed the old check silently, and `start_or_reload`
# went on to start all five new processes beside the five still-running
# old ones: two workers claiming jobs, two Discord gateways, and the new
# processes crash-looping because the old ones already hold their health
# ports. After a correct migration none of the old names exist any more,
# so this is silent from then on; before one, every deploy refuses.
#
# OPS-16 — the caller below skips this guard entirely when MIGRATE_PM2_NAMES
# is set: migrating is the whole point of that run, so refusing here would
# deadlock it against the exact thing it exists to fix (this file's own
# header, and `scripts/migrate-pm2-names.sh`'s own, describe the deadlock).
check_pm2_names_migrated() {
  local still_old=()
  local old
  for old in "${OLD_BARE_NAMES[@]}"; do
    if pm2_knows_app "$old"; then
      still_old+=("$old")
    fi
  done
  if [ ${#still_old[@]} -gt 0 ]; then
    fail "pm2 still knows these pre-OPS-15 names: ${still_old[*]}.
This droplet has not run the OPS-15 pm2 rename migration — run
scripts/migrate-pm2-names.sh once, by hand, before deploying again. Refusing
to reload rather than risk starting a second, bloombot-prefixed process
beside each one still running under its old name — see that script's own
header for what it does and the order it must run in."
  fi
}

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------

if [ -n "$MIGRATE_PM2_NAMES" ]; then
  log "MIGRATE_PM2_NAMES is set — a pre-OPS-15 name here migrates instead of aborting this deploy"
else
  log "checking for a half-migrated pm2 rename"
  check_pm2_names_migrated
fi

log "deploying ${PREV_SHA:0:8} -> ${TARGET_SHA:0:8} in $APP_DIR"
git reset --hard "$TARGET_SHA"

# OPS-16 — sourced from the checkout just updated to $TARGET_SHA (not from
# deploy.sh's own location, since this whole script is piped in over stdin
# and has no fixed path of its own) so `delete_old_pm2_names` always matches
# the OLD_NAMES/NEW_NAMES the commit actually being deployed defines. Only
# needed — and only sourced — when this run is a migration; an ordinary
# deploy never touches this file. `main` itself is never invoked here — see
# `scripts/migrate-pm2-names.sh`'s own `BASH_SOURCE` guard — so this only
# defines `delete_old_pm2_names` and its own small dependencies
# (`assert_ecosystem_has_new_names`, `OLD_NAMES`, `NEW_NAMES`); its `log`,
# `fail`, `pm2_field` and `pm2_knows_app` are identical, harmless
# redefinitions of this file's own.
if [ -n "$MIGRATE_PM2_NAMES" ]; then
  # shellcheck source=scripts/migrate-pm2-names.sh
  source scripts/migrate-pm2-names.sh
fi

if [ -z "$PM2_APP" ]; then
  # No Python bot on this droplet (see PM2_APP's own comment): installing its
  # dependencies and probing its interpreter would both fail the deploy over a
  # process that is deliberately not here any more.
  log "PM2_APP is empty; skipping the Python bot's dependencies and interpreter check"
elif [ "$DEPS_CHANGED" = true ]; then
  log "python dependency files changed"
  if ! install_deps; then
    restore_previous_checkout
    fail "python dependency install failed at ${TARGET_SHA:0:8}. Nothing was
restarted and the checkout was put back."
  fi
else
  log "python dependency files unchanged; skipping install"
fi

# Check the interpreter pm2 will use can import the bot's dependencies BEFORE
# restarting anything. If the environment probe above installed into a different
# environment than pm2 runs, this catches it while the old process is still
# happily serving.
if [ -n "$PM2_APP" ]; then
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
fi

if [ "$NODE_DEPS_CHANGED" = true ]; then
  log "node dependency files changed"
  if ! npm ci; then
    restore_previous_checkout
    fail "npm ci failed at ${TARGET_SHA:0:8}. Nothing was restarted and the
checkout was put back."
  fi
else
  log "node dependency files unchanged; skipping npm ci"
fi

# tsc --build is incremental (packages/*/tsconfig.json's own `composite`
# setting), so this is cheap even when nothing changed — unlike the
# dependency installs above, it is never gated on a diff.
log "building the TypeScript workspace"
if ! npm_build; then
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
if ! npm_build --workspace apps/web; then
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
if ! reload_everything; then
  echo "ERROR: one or more processes failed to reload — rolling back" >&2
  restore_previous_checkout
  if ! reload_everything; then
    fail "CRITICAL: rolled the checkout back to ${PREV_SHA:0:8} but one or
more processes failed to reload onto it too. Some processes may now be
stopped, or still running the broken commit's own dist/ — check \`pm2
status\` and each process's own log by hand; do not assume the previous
commit is actually running anywhere until you have looked."
  fi
  confirm_rolled_back_online
  fail "rolled back to ${PREV_SHA:0:8} after a reload failure; every process
that could be confirmed online is running the previous commit"
fi

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

# One shared wait for every process, the same `sleep` this script has always
# given the Python bot — restarting five processes at once and then checking
# each is faster than watching each in turn, and pm2's own restart_time is
# per-app regardless of when the others were reloaded.
declare -A restarts_before
for name in "${SUPERVISED_APPS[@]}"; do
  restarts_before["$name"]="$(pm2_field "$name" restart_time || true)"
done

log "watching every process for ${HEALTH_WAIT}s"
sleep "$HEALTH_WAIT"

UNHEALTHY=()
for name in "${SUPERVISED_APPS[@]}"; do
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
  if ! reload_everything; then
    fail "CRITICAL: rolled the checkout back to ${PREV_SHA:0:8} but one or
more processes failed to reload onto it. Check \`pm2 status\` and each
process's own log by hand; do not assume the previous commit is actually
running anywhere until you have looked."
  fi
  confirm_rolled_back_online
  fail "rolled back to ${PREV_SHA:0:8}; every process is running the previous commit"
fi

log "deployed ${TARGET_SHA:0:8} — every process is online"
