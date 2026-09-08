/**
 * Move requirements' cards on the project board (BOARD-4).
 *
 * GitHub's `Closes #N` keywords only fire when a pull request merges into the
 * repository's **default branch**. Every branch in the platform build targets
 * the long-lived integration branch instead, so nothing closes an issue and no
 * card ever leaves Backlog — the board stops describing the work while the work
 * is going on. This script is the explicit substitute: it writes the status into
 * `manifest.yaml`, which is the board's source of truth, and then reconciles the
 * board with it.
 *
 * Usage:
 *
 *   node scripts/board/status.mjs "In progress" TEN-1 TEN-2
 *   node scripts/board/status.mjs "In review" PROJ-1 PROJ-2 PROJ-3
 *   node scripts/board/status.mjs Done PLAT-1 --dry-run
 *   node scripts/board/status.mjs Done QA-6 --no-sync   # manifest only
 *
 * `Done` also closes the issue, because `sync.mjs` derives an issue's
 * open/closed state from its status.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { STATUSES } from './config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MANIFEST = join(HERE, 'manifest.yaml')

/**
 * Rewrite the `status:` line of each named entry.
 *
 * Deliberately line-based rather than parse-and-reserialize: the manifest is
 * written by `derive.mjs`, and CI fails if re-deriving changes a single byte, so
 * a round-trip through a YAML serializer that formats even one value differently
 * would break the build for everyone.
 *
 * @param {string} text     the manifest file's contents
 * @param {string[]} ids    requirement ids to move
 * @param {string} status   one of config.mjs's STATUSES
 * @returns {{text: string, changed: string[], unchanged: string[], missing: string[]}}
 */
export function setStatus(text, ids, status) {
  if (!STATUSES.includes(status))
    throw new Error(
      `Unknown status "${status}". Known: ${STATUSES.join(', ')}.`
    )

  const wanted = new Set(ids)
  const seen = new Set()
  const changed = []
  const unchanged = []

  const lines = text.split('\n')
  let current = null
  for (let i = 0; i < lines.length; i++) {
    const idMatch = /^- id: (\S+)$/.exec(lines[i])
    if (idMatch) {
      current = idMatch[1]
      if (wanted.has(current)) seen.add(current)
      continue
    }
    if (current === null || !wanted.has(current)) continue

    const statusMatch = /^ {2}status: (.+)$/.exec(lines[i])
    if (!statusMatch) continue
    // Written exactly as the YAML serializer writes it — a plain scalar, no
    // quotes, even for "In progress". Quoting it here would survive a round
    // trip but change the bytes, and CI fails on a manifest that re-derives
    // differently.
    if (statusMatch[1] === status) unchanged.push(current)
    else {
      lines[i] = `  status: ${status}`
      changed.push(current)
    }
    current = null // one status line per entry; stop looking
  }

  return {
    text: lines.join('\n'),
    changed,
    unchanged,
    missing: ids.filter(id => !seen.has(id)),
  }
}

// ---- CLI ----
const run = () => {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const noSync = argv.includes('--no-sync')
  const positional = argv.filter(a => !a.startsWith('--'))
  const [status, ...ids] = positional

  if (!status || ids.length === 0) {
    console.error(
      'Usage: node scripts/board/status.mjs <status> <REQ-ID…> [--dry-run] [--no-sync]\n' +
        `Statuses: ${STATUSES.join(' | ')}`
    )
    process.exit(2)
  }

  const before = readFileSync(MANIFEST, 'utf8')
  const result = setStatus(before, ids, status)

  if (result.missing.length) {
    console.error(
      `Not in the manifest: ${result.missing.join(', ')}. ` +
        'Run `npm run board:derive` first, or check the id.'
    )
    process.exit(1)
  }

  console.log(
    `${dryRun ? '[dry-run] ' : ''}${status}: ` +
      `${result.changed.length ? result.changed.join(', ') : 'none'}` +
      (result.unchanged.length
        ? `  (already ${status}: ${result.unchanged.join(', ')})`
        : '')
  )

  if (dryRun) return
  if (result.changed.length) writeFileSync(MANIFEST, result.text)
  if (noSync) return

  // --reconcile is what forces the manifest's status and open/closed state back
  // onto a board that has drifted; without it sync leaves live cards alone.
  execFileSync(
    process.execPath,
    [join(HERE, 'sync.mjs'), '--reconcile'],
    { stdio: 'inherit' }
  )
}

if (process.argv[1] && process.argv[1].endsWith('status.mjs')) run()
