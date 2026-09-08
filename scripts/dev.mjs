/**
 * Starts the whole stack for local development: the API, the panel, the
 * background worker and the Discord bot, in one terminal.
 *
 * Written as a script rather than pulling in a process runner, for the same
 * reason the rest of this repository avoids dependencies it can do without:
 * four `spawn` calls and a signal handler are less code than the configuration
 * a runner would need, and nobody has to learn its syntax.
 *
 * Two behaviours are deliberate.
 *
 *   - **The bot and the worker are optional.** They need credentials the API
 *     and the panel do not, so a checkout with no `BOT_TOKEN` still gets a
 *     working sign-in and control panel. They are started anyway when their
 *     credentials are present, and a process that exits on its own is reported
 *     rather than silently missing.
 *   - **Ctrl-C stops everything.** Each child gets the signal, and the script
 *     waits for them rather than orphaning processes that hold ports — a
 *     half-stopped stack is how the next `npm run dev` fails on a port that
 *     something invisible is still holding.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** ANSI colours, one per process, so interleaved output stays readable. */
const COLOURS = ['36', '35', '33', '32']
const DIM = '[2m'
const RESET = '[0m'

/**
 * The processes `npm run dev` starts.
 *
 * `requires` names the environment variables a process cannot start without.
 * A process missing one is skipped with a line saying which — the alternative
 * is a crash loop that scrolls the useful output away.
 */
export const PROCESSES = [
  { name: 'api', script: 'apps/api/src/index.ts', requires: [] },
  { name: 'web', npmScript: 'web:dev', requires: [] },
  // MCP-1..5 — no credential of its own (it authenticates a *connection* via
  // an AUTH-3 session token presented at request time, never a startup
  // secret this process reads itself), so it starts alongside `api`/`web`
  // rather than being gated like the bot and the worker below.
  { name: 'mcp', script: 'apps/mcp/src/index.ts', requires: [] },
  {
    name: 'worker',
    script: 'apps/worker/src/index.ts',
    requires: ['BOT_TOKEN'],
  },
  { name: 'bot', script: 'apps/bot/src/index.ts', requires: ['BOT_TOKEN'] },
]

/**
 * Decide what to start, given an environment.
 *
 * Exported so the decision is testable without spawning anything: the part
 * worth getting right is which processes are skipped and why, not the spawning.
 */
export function planProcesses(env) {
  return PROCESSES.map((process_) => {
    const missing = process_.requires.filter((name) => !env[name])
    return { ...process_, missing, start: missing.length === 0 }
  })
}

/** Reads `.env` into a plain object, so the plan sees what the apps will see. */
function environmentWithDotEnv() {
  const envFile = resolve(REPO_ROOT, '.env')
  if (!existsSync(envFile)) return { ...process.env }
  // Load into this process too: the children inherit it, and the plan above
  // needs to know whether BOT_TOKEN is really absent or merely unexported.
  process.loadEnvFile(envFile)
  return { ...process.env }
}

function run() {
  const plan = planProcesses(environmentWithDotEnv())
  const children = []
  let stopping = false

  plan.forEach((entry, index) => {
    if (!entry.start) {
      console.log(
        `${DIM}[dev] skipping ${entry.name}: ${entry.missing.join(', ')} not set in .env${RESET}`
      )
      return
    }

    const colour = `[${COLOURS[index % COLOURS.length]}m`
    const prefix = `${colour}[${entry.name}]${RESET} `
    const child = entry.npmScript
      ? spawn('npm', ['run', entry.npmScript], { cwd: REPO_ROOT, shell: false })
      : spawn('npx', ['tsx', 'watch', entry.script], {
          cwd: REPO_ROOT,
          shell: false,
        })

    for (const stream of ['stdout', 'stderr']) {
      child[stream].setEncoding('utf8')
      let partial = ''
      child[stream].on('data', (chunk) => {
        const lines = (partial + chunk).split('\n')
        partial = lines.pop() ?? ''
        for (const line of lines) console.log(prefix + line)
      })
    }

    child.on('exit', (code, signal) => {
      if (stopping) return
      console.log(
        `${prefix}exited (${signal ?? code}) — the rest of the stack is still running`
      )
    })

    children.push({ name: entry.name, child })
  })

  if (children.length === 0) {
    console.error('[dev] nothing to start')
    process.exitCode = 1
    return
  }

  const stop = (signal) => {
    if (stopping) return
    stopping = true
    console.log(`\n${DIM}[dev] stopping ${children.length} processes${RESET}`)
    for (const { child } of children) child.kill(signal)
  }

  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
}

// Only run when invoked directly, so the plan above can be imported by a test.
if (process.argv[1] && process.argv[1].endsWith('dev.mjs')) run()
