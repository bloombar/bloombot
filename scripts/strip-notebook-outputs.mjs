/**
 * Wipe the outputs from notebooks in the git index (ANLY-8).
 *
 *     node scripts/strip-notebook-outputs.mjs --staged   (pre-commit)
 *     node scripts/strip-notebook-outputs.mjs --post-commit (post-commit; never halts)
 *     node scripts/strip-notebook-outputs.mjs --index    (every indexed notebook, by hand)
 *
 * Only the indexed copy (the blob git commits) is rewritten. The file in the
 * working tree keeps its outputs, so local work is untouched. Run from inside
 * the repository; `git` operates on the current directory.
 */

import { execFileSync } from 'node:child_process'
import { NOTEBOOK_PATHSPEC, stripNotebook } from './notebook-outputs.mjs'

const git = (args, input) =>
  execFileSync('git', args, { input, encoding: 'utf8', maxBuffer: 1 << 28 })

/**
 * Strips notebooks in the index and returns the paths whose indexed copy
 * changed. By default only those staged for this commit; with `all`, every
 * indexed one. Throws (so the commit is refused) on a notebook it cannot clean.
 */
export function stripIndexedNotebooks({
  all = false,
  postCommit = false,
} = {}) {
  const list = all
    ? ['ls-files', '-z', '--', NOTEBOOK_PATHSPEC]
    : [
        'diff',
        '--cached',
        '--name-only',
        // Without --no-renames a `git mv` shows as a rename (R), which a
        // narrower filter would skip, committing the notebook with its outputs.
        '--no-renames',
        '--diff-filter=ACMR',
        '-z',
        '--',
        NOTEBOOK_PATHSPEC,
      ]
  const names = git(list).split('\0').filter(Boolean)
  const changed = []
  for (const path of names) {
    const staged = git(['show', `:${path}`])
    let clean
    try {
      clean = stripNotebook(staged)
    } catch (error) {
      if (!postCommit)
        throw new Error(`${path} ${error.message}`, { cause: error })
      // The commit already exists; report it and move on to the next notebook.
      console.error(
        `post-commit: commit made; could not clean the index copy of ${path}: ${error.message}`
      )
      continue
    }
    if (clean === staged) continue
    const hash = git(['hash-object', '-w', '--stdin'], clean).trim()
    // `ls-files -s` prints "<mode> <hash> <stage>\t<path>"; keep the file mode.
    const mode = git(['ls-files', '-s', '--', path]).split(' ')[0]
    git(['update-index', '--cacheinfo', `${mode},${hash},${path}`])
    changed.push(path)
  }
  return changed
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const flags = process.argv.slice(2)
  const all = flags.includes('--index')
  const postCommit = flags.includes('--post-commit')
  if (!all && !postCommit && !flags.includes('--staged')) {
    console.error(
      'usage: strip-notebook-outputs.mjs --staged | --post-commit | --index'
    )
    process.exit(2)
  }
  try {
    // Post-commit looks only at notebooks where the index differs from HEAD, so in the
    // middle of a rebase or cherry-pick (index == HEAD) it touches nothing.
    for (const path of stripIndexedNotebooks({ all, postCommit }))
      console.error(`cleared outputs from the indexed copy of ${path}`)
  } catch (error) {
    console.error(`refusing to continue: ${error.message}`)
    process.exit(1)
  }
}
