/**
 * Tests for the PreToolUse path guard.
 *
 * This hook is the only mechanism standing between an agent and `data/data.db`
 * (real student names, emails and 900+ conversation transcripts) or a `.env`
 * holding a live bot token on a public repository. A regression here is silent
 * — the hook simply stops blocking — so it is tested like production code.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'guard-paths.sh')

/** Runs the hook with a payload; returns its exit code. */
const runHook = (payload) => {
  try {
    execFileSync(HOOK, {
      input: JSON.stringify(payload),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return 0
  } catch (error) {
    return error.status
  }
}

const BLOCKED = 2
const ALLOWED = 0

const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path } })
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } })

test('blocks writes to the live student database', () => {
  assert.equal(runHook(write('data/data.db')), BLOCKED)
  assert.equal(runHook(write('/abs/path/bloombot/data/data.db')), BLOCKED)
})

test('blocks writes to environment files holding live credentials', () => {
  for (const path of [
    '.env',
    '.env.production',
    '/repo/.env',
    '/repo/.env.local',
  ])
    assert.equal(runHook(write(path)), BLOCKED, path)
})

test('blocks writes to logs and merged roster CSVs', () => {
  assert.equal(runHook(write('logs/response_bot.log')), BLOCKED)
  assert.equal(runHook(write('results/py-result.csv')), BLOCKED)
})

test('blocks a force-add, which is how a gitignored secret reaches a public repo', () => {
  assert.equal(runHook(bash('git add -f .env.production')), BLOCKED)
})

test('blocks commands that delete or overwrite the live database', () => {
  assert.equal(runHook(bash('rm -f data/data.db')), BLOCKED)
})

test('allows throwaway test databases outside data/', () => {
  // The vitest and Playwright suites write these on every run; blocking them
  // would break the build rather than protect anything.
  assert.equal(runHook(write('tmp/e2e.db')), ALLOWED)
  assert.equal(runHook(write('e2e/tmp/test.db')), ALLOWED)
})

test('allows the tracked env template', () => {
  // `env.example` (no leading dot) is the tracked template and carries no secrets.
  assert.equal(runHook(write('env.example')), ALLOWED)
})

test('allows ordinary source files', () => {
  assert.equal(runHook(write('packages/db/src/schema/courses.ts')), ALLOWED)
  assert.equal(runHook(bash('npm run typecheck')), ALLOWED)
})

test('allows reads of protected paths — the risk is modification, not inspection', () => {
  assert.equal(
    runHook(bash('sqlite3 data/data.db "SELECT count(*) FROM messages"')),
    ALLOWED
  )
})

test('only the first line is inspected, so prose about a protected path is not a command', () => {
  // Regression: the guard originally matched the whole command string, so a
  // commit message describing the guard tripped the guard. An over-broad rule
  // that blocks honest work is how people learn to disable the rule.
  const message = [
    "git commit -F - <<'EOF'",
    'Add guardrails',
    '',
    'Blocks writes to data/*.db and .env, and refuses git add -f.',
    'EOF',
  ].join('\n')
  assert.equal(runHook(bash(message)), ALLOWED)
  assert.equal(runHook(bash('git add -A')), ALLOWED)
  assert.equal(runHook(bash('grep -r "data/data.db" docs/')), ALLOWED)
  assert.equal(runHook(bash('echo "never commit .env"')), ALLOWED)
})

test('a malformed payload does not block work', () => {
  // A hook that fails open on garbage is right: it runs before every tool call,
  // and an unparseable payload is a bug in the harness, not an attack.
  assert.equal(runHook({}), ALLOWED)
})
