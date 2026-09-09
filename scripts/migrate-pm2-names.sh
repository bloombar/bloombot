#!/usr/bin/env bash
#
# One-time pm2 rename migration (OPS-15).
#
# `ecosystem.config.cjs` renamed this platform's five Node/script processes
# from bare names — api, bot, worker, mcp, ops-monitor — to `bloombot-`
# prefixed ones, so `pm2 list` on the shared droplet this runs on says which
# processes belong to this platform, rather than a name (`worker`, `api`)
# an unrelated project on the same box could plausibly claim too.
#
# A rename alone is not safe to deploy: `scripts/deploy.sh`'s own
# `start_or_reload` reloads a name pm2 already knows, and otherwise starts a
# *new* process from `ecosystem.config.cjs` — so the first ordinary deploy
# after the rename would start five new processes under the `bloombot-`
# names and leave the five old ones still running: two `worker` processes
# both claiming jobs (breaking PLAT-4's own single-instance guarantee), two
# `bot` processes holding two Discord gateway connections, and the new
# processes crash-looping because the old ones already hold their health
# ports — which fails `scripts/deploy.sh`'s own health check and rolls the
# deploy back into a half-renamed state.
#
# This script is the deliberate migration instead: it deletes each old name
# pm2 still knows, starts each new name that is missing, then `pm2 save`s
# once — but only after everything above it succeeded. It never touches a
# name that is not on its own explicit list (an unrelated `scabbot` or
# `wikistreets` process on the same shared droplet is untouchable), and it
# is not run automatically by CI or by `scripts/deploy.sh` itself — deleting
# a pm2 process on a shared droplet is an operator's decision, not one a
# deploy script gets to make unattended. `scripts/deploy.sh`'s own
# half-migrated guard only ever refuses to proceed when it finds both an old
# and a new name registered; it never deletes anything itself and instead
# names this script in its failure message.
#
# Run this once, by hand, on a droplet that still has the old bare names —
# BEFORE the first deploy of the commit that renamed them:
#
#   cd <the checkout, the same directory scripts/deploy.sh's own APP_DIR is>
#   scripts/migrate-pm2-names.sh          # prints the plan, asks to confirm
#   scripts/migrate-pm2-names.sh --yes    # skips the confirmation prompt
#
# Idempotent: run it again on an already-migrated droplet (no old names left,
# every new name already present) and it reports "nothing to do" and exits 0
# without touching pm2 at all.

set -euo pipefail

log() { printf '==> %s\n' "$*"; }
fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# The exact old names this migration acts on, hand-listed rather than
# discovered from pm2's own process list — so an unrelated process on the
# same shared droplet, whatever it happens to be called, is never a
# candidate for deletion no matter what pm2 reports. The legacy Python
# bot's own `bloombot` entry has no pair here: it was never renamed
# (`ecosystem.config.cjs`'s own module comment says why), so it cannot
# collide with itself.
OLD_NAMES=(api bot worker mcp ops-monitor)

for cmd in pm2 node; do
  command -v "$cmd" >/dev/null 2>&1 || fail "required command not on PATH: $cmd"
done

[ -f ecosystem.config.cjs ] ||
  fail "ecosystem.config.cjs not found in $(pwd) — run this from the checkout's own root (the same directory scripts/deploy.sh's own APP_DIR is)"

YES=false
for arg in "$@"; do
  case "$arg" in
    --yes) YES=true ;;
    *) fail "unrecognized argument: $arg (only --yes is accepted)" ;;
  esac
done

# Reads one field of a named pm2 app record out of `pm2 jlist` — the same
# approach `scripts/deploy.sh`'s own `pm2_field` uses, duplicated rather
# than shared so this script has no dependency on deploy.sh at all and can
# be copied to, or run from, a droplet on its own.
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

# What this run would actually do — computed before anything is printed or
# touched, so the plan below and the actions further down never disagree.
PRESENT_OLD=()
MISSING_NEW=()
for old in "${OLD_NAMES[@]}"; do
  if pm2_knows_app "$old"; then
    PRESENT_OLD+=("$old")
  fi
  new="bloombot-$old"
  if ! pm2_knows_app "$new"; then
    MISSING_NEW+=("$new")
  fi
done

if [ ${#PRESENT_OLD[@]} -eq 0 ] && [ ${#MISSING_NEW[@]} -eq 0 ]; then
  log "nothing to do — pm2 already knows only the bloombot- prefixed names"
  exit 0
fi

log "this migration will:"
[ ${#PRESENT_OLD[@]} -gt 0 ] && log "  delete: ${PRESENT_OLD[*]}"
[ ${#MISSING_NEW[@]} -gt 0 ] && log "  start (from ecosystem.config.cjs): ${MISSING_NEW[*]}"
log "  then, if every step above succeeds: pm2 save"

if [ "$YES" != true ]; then
  read -r -p "Proceed? Type 'yes' to continue: " REPLY
  [ "$REPLY" = "yes" ] || fail "not confirmed — nothing was changed"
fi

# Collect every failure rather than stopping at the first — the same
# discipline `scripts/deploy.sh`'s own `reload_everything` uses — so one run
# tells an operator everything that needs a second look, not just whichever
# step happened to fail first.
FAILED=()
for old in "${PRESENT_OLD[@]}"; do
  log "pm2 delete $old"
  if ! pm2 delete "$old"; then
    echo "ERROR: pm2 delete $old failed" >&2
    FAILED+=("delete $old")
  fi
done

for new in "${MISSING_NEW[@]}"; do
  log "pm2 start ecosystem.config.cjs --only $new"
  if ! pm2 start ecosystem.config.cjs --only "$new"; then
    echo "ERROR: pm2 start $new failed" >&2
    FAILED+=("start $new")
  fi
done

if [ ${#FAILED[@]} -gt 0 ]; then
  fail "one or more steps failed: ${FAILED[*]}. Not running pm2 save — the
process list pm2 already has is left as-is until this is fixed. Check
\`pm2 status\` by hand; this script is safe to re-run, since it only acts on
whichever old names it still finds and whichever new names are still
missing."
fi

log "pm2 save"
pm2 save

log "migration complete"
