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
# deploy back into a half-renamed state. `scripts/deploy.sh`'s own guard
# (`check_pm2_names_migrated`) refuses to reload at all while pm2 still
# knows ANY of the old names, rather than let that happen — it never
# deletes anything itself, and names this script in its failure message.
#
# This script is the deliberate migration instead: it deletes each old name
# pm2 still knows, starts each new name that is missing, then `pm2 save`s
# once — but only after everything above it succeeded. It never touches a
# name that is not on its own explicit list (an unrelated `scabbot` or
# `wikistreets` process on the same shared droplet is untouchable), and it
# is not run automatically by CI or by `scripts/deploy.sh` itself — deleting
# a pm2 process on a shared droplet is an operator's decision, not one a
# deploy script gets to make unattended.
#
# THE ORDER THIS MUST RUN IN MATTERS. The "start" half below runs
# `pm2 start ecosystem.config.cjs --only <new-name>`, which only works if
# the checkout's *own* `ecosystem.config.cjs` — right here, in the current
# working directory — already defines that name. If this is run while the
# checkout is still on the commit *before* the rename, the old processes
# get deleted, every `--only <new-name>` matches nothing in the file pm2 is
# told to read, pm2 exits 0 anyway having started nothing, and the droplet
# ends up with the whole platform down and no old processes left to fall
# back to. This script refuses to delete anything until it has confirmed the
# checkout it is run from actually names every new process (see
# `assert_ecosystem_has_new_names` below) — but the order below is still
# the one to follow, not something this refusal is a substitute for:
#
#   1. Update the droplet's checkout to the commit that renamed the
#      processes (whatever the next `scripts/deploy.sh` run, or a manual
#      update to that same commit, would put there) — BEFORE running this.
#   2. Run this script, once, by hand:
#        cd <the checkout, the same directory scripts/deploy.sh's own APP_DIR is>
#        scripts/migrate-pm2-names.sh          # prints the plan, asks to confirm
#        scripts/migrate-pm2-names.sh --yes    # skips the confirmation prompt
#   3. Only then let (or trigger) the next ordinary deploy.
#
# Idempotent: run it again on an already-migrated droplet (no old names left,
# every new name already present) and it reports "nothing to do" and exits 0
# without touching pm2 at all.
#
# OPS-16 — this file is also `source`d by `scripts/deploy.sh` itself, under
# `MIGRATE_PM2_NAMES`, so a deploy can run the same migration unattended
# instead of an operator running this script by hand. Everything below
# `main()`'s own definition only runs when this file is executed directly
# (the `[[ "${BASH_SOURCE[0]}" == "${0}" ]]` guard at the bottom) — sourced
# into deploy.sh, only the function and array definitions take effect, so
# deploy.sh's own arguments are never mistaken for this script's `--yes`.
# `delete_old_pm2_names` is the one function deploy.sh actually calls: the
# single place either script deletes an old bare name, so the exact-string
# matching against `OLD_NAMES` can never drift between them.

set -euo pipefail

log() { printf '==> %s\n' "$*"; }
fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# The exact old/new name pairs this migration acts on, hand-listed rather
# than discovered from pm2's own process list — so an unrelated process on
# the same shared droplet, whatever it happens to be called, is never a
# candidate for deletion no matter what pm2 reports. The legacy Python
# bot's own `bloombot` entry has no pair here: it was never renamed
# (`ecosystem.config.cjs`'s own module comment says why), so it cannot
# collide with itself.
OLD_NAMES=(api bot worker mcp ops-monitor)
NEW_NAMES=(bloombot-api bloombot-bot bloombot-worker bloombot-mcp bloombot-ops-monitor)

for cmd in pm2 node; do
  command -v "$cmd" >/dev/null 2>&1 || fail "required command not on PATH: $cmd"
done

[ -f ecosystem.config.cjs ] ||
  fail "ecosystem.config.cjs not found in $(pwd) — run this from the checkout's own root (the same directory scripts/deploy.sh's own APP_DIR is)"

# Rework finding — the first version of this script had no precondition on
# `ecosystem.config.cjs`'s own contents at all, only that the file existed.
# Run against a checkout still on the pre-rename commit (the documented,
# and only sane, order is checkout-then-migrate, but nothing enforced it),
# the delete half below would succeed, and every `pm2 start
# ecosystem.config.cjs --only bloombot-api` (etc.) would match no app in
# that file, exit 0 having started nothing, and leave the droplet with the
# whole platform down and no old processes left to recover to. Checked
# before anything is deleted, against the *current* `ecosystem.config.cjs`
# in this directory, using node (already required above) to read it the
# same way pm2 itself would.
assert_ecosystem_has_new_names() {
  local missing=()
  local new
  for new in "${NEW_NAMES[@]}"; do
    if ! node -e '
      const apps = (require(process.argv[1]).apps || []);
      process.exit(apps.some((a) => a && a.name === process.argv[2]) ? 0 : 1);
    ' "$(pwd)/ecosystem.config.cjs" "$new"; then
      missing+=("$new")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    fail "ecosystem.config.cjs in $(pwd) does not name: ${missing[*]}.
This checkout is still on the commit before the OPS-15 pm2 rename. Update
the checkout to the renamed commit FIRST, THEN run this migration — never
the other way around. Nothing was deleted."
  fi
}

# Reads one field of a named pm2 app record out of `pm2 jlist` — the same
# approach `scripts/deploy.sh`'s own `pm2_field` uses, duplicated rather
# than shared so this script has no dependency on deploy.sh at all and can
# be copied to, or run from, a droplet on its own. (`deploy.sh` sourcing this
# file redefines its own, identical copies — harmless, since both do exactly
# the same thing.)
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

# OPS-16 — the delete half of this migration, factored out so
# `scripts/deploy.sh` can call it directly under `MIGRATE_PM2_NAMES` rather
# than reimplementing the same exact-string match against `OLD_NAMES`. This
# is the ONLY place either script deletes a pm2 process by one of the old
# bare names. Deliberately does not touch the "start the missing new names"
# half below: deploy.sh's own `start_or_reload` already starts a name pm2
# does not know, so deploy.sh only ever needs this half — the delete has to
# happen before its own reload loop, not the start.
#
# Safe to call with no old names present (the ordinary case once a droplet
# is migrated, including every call after the first in a single run): it
# recomputes which old names pm2 currently knows every time, so it is a
# no-op rather than an error. Returns non-zero, never exits directly, if any
# individual delete failed — both callers (this file's own `main`, and
# `scripts/deploy.sh`'s `reload_everything`) decide separately what that
# means at that point, the same "report, don't exit-from-inside" shape
# `scripts/deploy.sh`'s own `start_or_reload` already uses.
delete_old_pm2_names() {
  assert_ecosystem_has_new_names
  local present_old=()
  local old
  for old in "${OLD_NAMES[@]}"; do
    if pm2_knows_app "$old"; then
      present_old+=("$old")
    fi
  done
  if [ ${#present_old[@]} -eq 0 ]; then
    return 0
  fi
  local failed=()
  # `"${ARR[@]}"` on an EMPTY array under `set -u` is an unbound-variable
  # error on bash 3.2 (macOS's own `/bin/bash`, still bash 3.2 by license —
  # reproduced running this script locally on it); the droplet's own bash 5
  # has long since fixed this, but the `${ARR[@]+"${ARR[@]}"}` form below
  # costs nothing and keeps a local, macOS-run rehearsal of this script from
  # failing for a reason that has nothing to do with what it is testing.
  for old in ${present_old[@]+"${present_old[@]}"}; do
    log "pm2 delete $old"
    if ! pm2 delete "$old"; then
      echo "ERROR: pm2 delete $old failed" >&2
      failed+=("delete $old")
    fi
  done
  if [ ${#failed[@]} -gt 0 ]; then
    echo "ERROR: one or more pm2 deletes failed: ${failed[*]}" >&2
    return 1
  fi
  return 0
}

# Everything below is this script's own, hand-run behaviour — the plan
# printout, the confirmation prompt, and starting whichever new names are
# still missing. Wrapped in `main` (rather than left at top level, as before
# this file became sourceable) so `scripts/deploy.sh` can `source` this file
# for `delete_old_pm2_names`/`assert_ecosystem_has_new_names` alone without
# also running this script's own argument parsing against deploy.sh's own
# arguments — see the `BASH_SOURCE` guard at the bottom of this file.
main() {
  local YES=false
  local arg
  for arg in "$@"; do
    case "$arg" in
      --yes) YES=true ;;
      *) fail "unrecognized argument: $arg (only --yes is accepted)" ;;
    esac
  done

  assert_ecosystem_has_new_names

  # What this run would actually do — computed before anything is printed or
  # touched, so the plan below and the actions further down never disagree.
  local old new
  local PRESENT_OLD=()
  local MISSING_NEW=()
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
    return 0
  fi

  log "this migration will:"
  if [ ${#PRESENT_OLD[@]} -gt 0 ]; then
    log "  delete: ${PRESENT_OLD[*]}"
    log "  (these are generic names an unrelated project on this shared droplet"
    log "   could plausibly own too — check \`pm2 describe <name>\` for anything"
    log "   you did not expect before confirming)"
  fi
  [ ${#MISSING_NEW[@]} -gt 0 ] && log "  start (from ecosystem.config.cjs): ${MISSING_NEW[*]}"
  log "  then, if every step above succeeds: pm2 save"

  if [ "$YES" != true ]; then
    read -r -p "Proceed? Type 'yes' to continue: " REPLY
    [ "$REPLY" = "yes" ] || fail "not confirmed — nothing was changed"
  fi

  # Collect every failure rather than stopping at the first — the same
  # discipline `scripts/deploy.sh`'s own `reload_everything` uses — so one
  # run tells an operator everything that needs a second look, not just
  # whichever step happened to fail first.
  local FAILED=()
  if ! delete_old_pm2_names; then
    FAILED+=("deleting the old names")
  fi

  for new in ${MISSING_NEW[@]+"${MISSING_NEW[@]}"}; do
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
}

# Only runs `main` when this file is executed directly, not when
# `scripts/deploy.sh` sources it — see this file's own header and `main`'s
# own comment for why that split exists.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
