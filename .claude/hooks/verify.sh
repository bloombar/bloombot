#!/usr/bin/env bash
# Stop hook: the turn does not end until the project's checks pass.
#
# Only runs checks that actually exist. During the early phases the monorepo is
# still being assembled, so `typecheck` and a real test suite may be absent —
# a missing script must read as "nothing to check", never as a failure, or the
# hook blocks every turn for the wrong reason.
#
# Exit 2 blocks the turn and shows stderr to the model.

set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# Nothing to verify before dependencies exist.
[ -f package.json ] || exit 0
[ -d node_modules ] || exit 0

has_script() {
  node -e "
    const pkg = require('./package.json');
    process.exit(pkg.scripts && pkg.scripts['$1'] ? 0 : 1);
  " 2>/dev/null
}

failures=""

run_check() {
  local name="$1"
  has_script "$name" || return 0
  local output
  if ! output=$(npm run --silent "$name" 2>&1); then
    failures="${failures}
--- npm run ${name} ---
${output}
"
  fi
}

run_check typecheck
run_check test

if [ -n "$failures" ]; then
  {
    echo "Checks failed. Fix these before ending the turn:"
    echo "$failures"
  } >&2
  exit 2
fi

exit 0
