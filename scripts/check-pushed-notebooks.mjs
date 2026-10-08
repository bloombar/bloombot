/**
 * Pre-push check (ANLY-8): refuse to push a notebook that still has outputs.
 *
 * Git feeds a pre-push hook one line per ref on stdin:
 *     <local ref> <local sha> <remote ref> <remote sha>
 * and the remote's name as the first argument. Every commit that would be
 * sent is inspected, and the notebooks it adds or changes must have no
 * outputs and no execution counts. Exits 1, naming file and commit, if not,
 * and also (fail closed) if it cannot work out which commits would be sent.
 * Run from inside the repository.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { NOTEBOOK_PATHSPEC, notebookProblems } from './notebook-outputs.mjs'

const ZERO = /^0+$/
const git = (args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe'], // git's own `fatal:` text is replaced by our message
  })

/** Raised when the range of commits to inspect cannot be determined. */
export class UnknownRangeError extends Error {}

/**
 * Commits a push of `localSha` would send, given what the remote already has.
 * `walkedAll` is true when no remote-tracking refs exist, so the whole history
 * had to be inspected.
 */
function commitsToPush(localSha, remoteSha, remoteName) {
  if (!ZERO.test(remoteSha)) {
    try {
      return {
        commits: git(['rev-list', `${remoteSha}..${localSha}`])
          .split('\n')
          .filter(Boolean),
      }
    } catch {
      throw new UnknownRangeError(
        `the remote's current commit ${remoteSha.slice(0, 10)} is not known locally, so the commits ` +
          `to be sent cannot be listed. Run \`git fetch ${remoteName || '<remote>'}\` and push again.`
      )
    }
  }
  // A new branch: everything not already on one of the remote's tracked branches.
  const tracking = git([
    'for-each-ref',
    '--format=%(refname)',
    `refs/remotes/${remoteName ?? ''}`,
  ])
    .split('\n')
    .filter(Boolean)
  const commits = git([
    'rev-list',
    localSha,
    '--not',
    remoteName ? `--remotes=${remoteName}` : '--remotes',
  ])
    .split('\n')
    .filter(Boolean)
  return { commits, walkedAll: tracking.length === 0 }
}

/**
 * Returns `{ offenders, walkedAll }`: `{ commit, path, problems }` for each
 * offending notebook in the pushed range. Throws UnknownRangeError when unsure.
 */
export function findOffendingNotebooks(stdinText, remoteName) {
  const offenders = []
  let walkedAll = false
  for (const line of stdinText.split('\n').filter(Boolean)) {
    const [, localSha, , remoteSha] = line.split(' ')
    if (ZERO.test(localSha)) continue // deleting a ref sends no commits
    const range = commitsToPush(localSha, remoteSha, remoteName)
    walkedAll ||= Boolean(range.walkedAll)
    for (const commit of range.commits) {
      const paths = git([
        'diff-tree',
        '-r',
        '-m',
        '--root',
        '--no-renames',
        '--no-commit-id',
        '--name-only',
        '--diff-filter=AMCR',
        '-z',
        commit,
        '--',
        NOTEBOOK_PATHSPEC,
      ])
        .split('\0')
        .filter(Boolean)
      for (const path of new Set(paths)) {
        const problems = notebookProblems(git(['show', `${commit}:${path}`]))
        if (problems.length) offenders.push({ commit, path, problems })
      }
    }
  }
  return { offenders, walkedAll }
}

/** The steps that actually clear a notebook that is already committed. */
export const REMEDIATION = `To fix it (the pre-commit hook must be enabled: run \`npm run prepare\`):
  - if only your latest commit is affected:
      node scripts/strip-notebook-outputs.mjs --index && git commit --amend --no-edit
  - otherwise squash the branch so the hook strips the new commit:
      git reset --soft $(git merge-base HEAD origin/master) && git commit
  (\`git commit --amend\` on its own strips nothing: the notebook is unchanged in that commit.)`

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  let result
  try {
    result = findOffendingNotebooks(readFileSync(0, 'utf8'), process.argv[2])
  } catch (error) {
    if (!(error instanceof UnknownRangeError)) throw error
    console.error(`pre-push: refusing to push, because ${error.message}`)
    process.exit(1)
  }
  if (result.offenders.length) {
    for (const o of result.offenders)
      console.error(
        `pre-push: ${o.path} in commit ${o.commit.slice(0, 10)}: ${o.problems.join('; ')}`
      )
    console.error(
      'Refusing to push: notebook outputs may contain student data.\n' +
        REMEDIATION
    )
    if (result.walkedAll)
      console.error(
        `No remote-tracking branches exist for this remote, so the whole history was inspected; ` +
          `\`git fetch ${process.argv[2] || '<remote>'}\` first to limit the check to new commits.`
      )
    process.exit(1)
  }
}
