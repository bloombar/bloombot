/**
 * Tests for the notebook-output tooling (ANLY-8): the pre-commit strip, the
 * pre-push check, and the CI backstop over the notebooks this repository tracks.
 *
 * The strip and push tests run the real scripts against throwaway git
 * repositories under `tmp/`, never this repository's own index.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

import { notebookProblems, stripNotebook } from './notebook-outputs.mjs'

const SCRIPTS = dirname(fileURLToPath(import.meta.url))
const REPO = join(SCRIPTS, '..')

/** An environment with no GIT_* variables, so a test never reaches an outer repository. */
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
  )

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' })

/** A notebook as a student-data run would leave it: an output and an execution count. */
const dirtyNotebook = () =>
  JSON.stringify(
    {
      cells: [
        { cell_type: 'markdown', metadata: {}, source: ['# title\n'] },
        {
          cell_type: 'code',
          metadata: { execution: { 'iopub.execute_input': 'x' } },
          source: ['print("hi")'],
          execution_count: 3,
          outputs: [
            {
              output_type: 'stream',
              name: 'stdout',
              text: ['SECRET-STUDENT\n'],
            },
          ],
        },
      ],
      metadata: { widgets: { state: {} } },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1
  ) + '\n'

/** A fresh repository under tmp/, removed by the caller. */
function makeRepo() {
  mkdirSync(join(REPO, 'tmp'), { recursive: true })
  const dir = mkdtempSync(join(REPO, 'tmp', 'nbtest-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

test('stripNotebook clears outputs, counts and run metadata, and is idempotent', () => {
  const clean = stripNotebook(dirtyNotebook())
  assert.deepEqual(notebookProblems(clean), [])
  assert.ok(!clean.includes('SECRET-STUDENT'))
  assert.ok(!clean.includes('widgets'))
  assert.equal(stripNotebook(clean), clean)
  assert.equal(notebookProblems(dirtyNotebook()).length, 2)
})

test('the pre-commit strip rewrites the staged blob and leaves the working copy alone', () => {
  const dir = makeRepo()
  try {
    const file = join(dir, 'nb.ipynb')
    writeFileSync(file, dirtyNotebook())
    git(dir, 'add', 'nb.ipynb')
    const run = spawnSync(
      'node',
      [join(SCRIPTS, 'strip-notebook-outputs.mjs'), '--staged'],
      {
        cwd: dir,
        env: cleanEnv(),
        encoding: 'utf8',
      }
    )
    assert.equal(run.status, 0, run.stderr)

    const staged = git(dir, 'show', ':nb.ipynb')
    assert.deepEqual(notebookProblems(staged), [])
    assert.ok(!staged.includes('SECRET-STUDENT'))
    // The user's copy still has its outputs.
    assert.equal(readFileSync(file, 'utf8'), dirtyNotebook())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the installed pre-commit hook strips what a real commit records', () => {
  const dir = makeRepo()
  try {
    git(dir, 'config', 'core.hooksPath', join(REPO, '.githooks'))
    writeFileSync(join(dir, 'nb.ipynb'), dirtyNotebook())
    git(dir, 'add', 'nb.ipynb')
    git(dir, 'commit', '-q', '-m', 'add notebook')
    assert.deepEqual(notebookProblems(git(dir, 'show', 'HEAD:nb.ipynb')), [])
    assert.equal(readFileSync(join(dir, 'nb.ipynb'), 'utf8'), dirtyNotebook())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Runs the pre-push check as git would: stdin lines for the pushed refs. */
function prePush(dir, stdin) {
  return spawnSync(
    'node',
    [join(SCRIPTS, 'check-pushed-notebooks.mjs'), 'origin'],
    {
      cwd: dir,
      env: cleanEnv(),
      input: stdin,
      encoding: 'utf8',
    }
  )
}

test('the pre-push check blocks a commit with outputs, naming file and commit, and allows a clean one', () => {
  const dir = makeRepo()
  try {
    const zero = '0'.repeat(40)
    writeFileSync(join(dir, 'ok.ipynb'), stripNotebook(dirtyNotebook()))
    git(dir, 'add', 'ok.ipynb')
    git(dir, 'commit', '-q', '-m', 'clean')
    const clean = git(dir, 'rev-parse', 'HEAD').trim()
    assert.equal(
      prePush(dir, `refs/heads/main ${clean} refs/heads/main ${zero}\n`).status,
      0
    )

    writeFileSync(join(dir, 'bad.ipynb'), dirtyNotebook())
    git(dir, 'add', 'bad.ipynb')
    git(dir, 'commit', '-q', '-m', 'dirty')
    const dirty = git(dir, 'rev-parse', 'HEAD').trim()

    // New branch (remote sha all zeros) and update of an existing one (clean..dirty).
    for (const remote of [zero, clean]) {
      const run = prePush(
        dir,
        `refs/heads/main ${dirty} refs/heads/main ${remote}\n`
      )
      assert.equal(run.status, 1)
      assert.match(run.stderr, /bad\.ipynb/)
      assert.ok(run.stderr.includes(dirty.slice(0, 10)))
    }
    // Pushing only the commit before it is still fine.
    assert.equal(
      prePush(dir, `refs/heads/main ${clean} refs/heads/main ${zero}\n`).status,
      0
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no notebook tracked by git carries outputs or an execution count', (t) => {
  const listed = spawnSync('git', ['ls-files', '-z', '--', '*.ipynb'], {
    cwd: REPO,
    encoding: 'utf8',
  })
  if (listed.status !== 0) return t.skip('not a git checkout')
  const paths = listed.stdout.split('\0').filter(Boolean)
  assert.ok(paths.length > 0)
  const offenders = []
  for (const path of paths) {
    // The index copy is what gets committed; the working copy may keep local outputs.
    const blob = execFileSync('git', ['show', `:${path}`], {
      cwd: REPO,
      encoding: 'utf8',
    })
    const problems = notebookProblems(blob)
    if (problems.length) offenders.push(`${path}: ${problems.join(', ')}`)
  }
  assert.deepEqual(
    offenders,
    [],
    'a tracked notebook has outputs. Re-stage it so the hook strips it: ' +
      '`node scripts/strip-notebook-outputs.mjs --index`, then amend or commit.'
  )
})

/** Runs the strip script against a repository's index; returns the process result. */
const strip = (dir, mode = '--staged') =>
  spawnSync('node', [join(SCRIPTS, 'strip-notebook-outputs.mjs'), mode], {
    cwd: dir,
    env: cleanEnv(),
    encoding: 'utf8',
  })

test('a renamed notebook is stripped too (git mv is a rename, not an add)', () => {
  const dir = makeRepo()
  try {
    // Padded with prose cells so git sees the rename as similar enough to pair.
    const padded = (text) => {
      const nb = JSON.parse(text)
      for (let i = 0; i < 40; i++)
        nb.cells.push({
          cell_type: 'markdown',
          metadata: {},
          source: [`filler ${i}\n`],
        })
      return JSON.stringify(nb, null, 1) + '\n'
    }
    writeFileSync(join(dir, 'a.ipynb'), padded(stripNotebook(dirtyNotebook())))
    git(dir, 'add', 'a.ipynb')
    git(dir, 'commit', '-q', '-m', 'clean')
    git(dir, 'mv', 'a.ipynb', 'b.ipynb')
    writeFileSync(join(dir, 'b.ipynb'), padded(dirtyNotebook()))
    git(dir, 'add', 'b.ipynb')
    // Git really does see this as a rename.
    assert.match(git(dir, 'diff', '--cached', '--name-status', '-M'), /^R/)
    assert.equal(strip(dir).status, 0)
    assert.deepEqual(notebookProblems(git(dir, 'show', ':b.ipynb')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an upper-case extension is stripped too', () => {
  const dir = makeRepo()
  try {
    writeFileSync(join(dir, 'NB.IPYNB'), dirtyNotebook())
    git(dir, 'add', 'NB.IPYNB')
    assert.equal(strip(dir).status, 0)
    assert.deepEqual(notebookProblems(git(dir, 'show', ':NB.IPYNB')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** An old-format (nbformat 3) notebook, whose outputs live under `worksheets`. */
const v3Notebook = () =>
  JSON.stringify({
    nbformat: 3,
    nbformat_minor: 0,
    metadata: {},
    worksheets: [
      {
        cells: [
          {
            cell_type: 'code',
            input: ['1'],
            outputs: [{ text: ['SECRET-STUDENT'] }],
            prompt_number: 1,
          },
        ],
      },
    ],
  })

test('an nbformat 3 notebook fails closed everywhere', () => {
  assert.throws(() => stripNotebook(v3Notebook()), /old notebook format/)
  assert.equal(notebookProblems(v3Notebook()).length, 1)
  assert.equal(notebookProblems('not json').length, 1)

  const dir = makeRepo()
  try {
    writeFileSync(join(dir, 'old.ipynb'), v3Notebook())
    git(dir, 'add', 'old.ipynb')
    const run = strip(dir)
    assert.equal(run.status, 1) // the commit is refused
    assert.match(run.stderr, /old\.ipynb/)

    git(dir, 'commit', '-q', '-m', 'old format, hooks off')
    const sha = git(dir, 'rev-parse', 'HEAD').trim()
    assert.equal(
      prePush(dir, `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`)
        .status,
      1
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a partial commit leaves the index clean (post-commit hook)', () => {
  const dir = makeRepo()
  try {
    git(dir, 'config', 'core.hooksPath', join(REPO, '.githooks'))
    writeFileSync(join(dir, 'nb.ipynb'), stripNotebook(dirtyNotebook()))
    git(dir, 'add', 'nb.ipynb')
    git(dir, 'commit', '-q', '-m', 'clean')
    writeFileSync(join(dir, 'nb.ipynb'), dirtyNotebook())
    git(dir, 'commit', '-q', '-m', 'partial', 'nb.ipynb') // `git commit <path>`
    assert.deepEqual(notebookProblems(git(dir, 'show', 'HEAD:nb.ipynb')), [])
    assert.deepEqual(notebookProblems(git(dir, 'show', ':nb.ipynb')), [])
    assert.equal(readFileSync(join(dir, 'nb.ipynb'), 'utf8'), dirtyNotebook())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the pre-push check fails closed, with advice, when it cannot list the commits', () => {
  const dir = makeRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'x')
    git(dir, 'add', 'a.txt')
    git(dir, 'commit', '-q', '-m', 'one')
    const sha = git(dir, 'rev-parse', 'HEAD').trim()
    // The remote's commit is unknown here.
    const run = prePush(
      dir,
      `refs/heads/main ${sha} refs/heads/main ${'a'.repeat(40)}\n`
    )
    assert.equal(run.status, 1)
    assert.match(run.stderr, /git fetch origin/)
    assert.doesNotMatch(run.stderr, /fatal/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('with no remote-tracking refs the whole history is checked, and the message says so', () => {
  const dir = makeRepo()
  try {
    writeFileSync(join(dir, 'bad.ipynb'), dirtyNotebook())
    git(dir, 'add', 'bad.ipynb')
    git(dir, 'commit', '-q', '-m', 'dirty')
    const sha = git(dir, 'rev-parse', 'HEAD').trim()
    const run = prePush(
      dir,
      `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`
    )
    assert.equal(run.status, 1)
    assert.match(run.stderr, /whole history/)
    assert.match(run.stderr, /git fetch origin/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the advice printed on a blocked push actually clears it', () => {
  const zero = '0'.repeat(40)
  for (const fix of ['amend', 'squash']) {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'x')
      git(dir, 'add', 'a.txt')
      git(dir, 'commit', '-q', '-m', 'base')
      const base = git(dir, 'rev-parse', 'HEAD').trim()
      writeFileSync(join(dir, 'bad.ipynb'), dirtyNotebook()) // committed with hooks off
      git(dir, 'add', 'bad.ipynb')
      git(dir, 'commit', '-q', '-m', 'dirty')
      git(dir, 'config', 'core.hooksPath', join(REPO, '.githooks'))
      const range = () =>
        `refs/heads/main ${git(dir, 'rev-parse', 'HEAD').trim()} refs/heads/main ${base}\n`
      assert.equal(prePush(dir, range()).status, 1)

      // A bare `--amend` does nothing: the notebook is unchanged in that commit.
      git(dir, 'commit', '-q', '--amend', '--no-edit')
      assert.equal(prePush(dir, range()).status, 1)

      if (fix === 'amend') {
        assert.equal(strip(dir, '--index').status, 0)
        git(dir, 'commit', '-q', '--amend', '--no-edit')
      } else {
        git(dir, 'reset', '--soft', git(dir, 'merge-base', 'HEAD', base).trim())
        git(dir, 'add', 'bad.ipynb')
        git(dir, 'commit', '-q', '-m', 'squashed')
      }
      assert.equal(prePush(dir, range()).status, 0, fix)
      assert.equal(
        readFileSync(join(dir, 'bad.ipynb'), 'utf8'),
        dirtyNotebook()
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  assert.ok(zero)
})

test('SQLite sidecar files beside the database are gitignored', () => {
  for (const path of [
    'data/data.db-wal',
    'data/data.db-shm',
    'data/data.db-journal',
  ]) {
    const run = spawnSync('git', ['check-ignore', '-q', path], { cwd: REPO })
    assert.equal(run.status, 0, `${path} is not gitignored`)
  }
})

test('the post-commit hook leaves rebases, cherry-picks and unrelated commits alone', () => {
  const dir = makeRepo()
  try {
    // Old history that already holds a notebook with outputs (committed with hooks off).
    const variant = (n) =>
      dirtyNotebook().replace('SECRET-STUDENT', `SECRET-${n}`)
    const commitNotebook = (text, message) => {
      writeFileSync(join(dir, 'old.ipynb'), text)
      git(dir, 'add', 'old.ipynb')
      git(dir, 'commit', '-q', '-m', message)
      return git(dir, 'rev-parse', 'HEAD').trim()
    }
    writeFileSync(join(dir, 'a.txt'), '0')
    git(dir, 'add', 'a.txt')
    git(dir, 'commit', '-q', '-m', 'base')
    commitNotebook(variant(0), 'old notebook')
    git(dir, 'checkout', '-q', '-b', 'feat')
    const a = commitNotebook(variant(1), 'A')
    const b = commitNotebook(variant(2), 'B')
    git(dir, 'checkout', '-q', 'main')
    writeFileSync(join(dir, 'a.txt'), '1')
    git(dir, 'commit', '-q', '-am', 'T')
    const blob = (rev) => git(dir, 'show', `${rev}:old.ipynb`)

    git(dir, 'config', 'core.hooksPath', join(REPO, '.githooks')) // hooks on from here

    // A two-commit cherry-pick completes and carries each commit's notebook exactly.
    git(dir, 'checkout', '-q', '-b', 'pick')
    git(dir, 'cherry-pick', a, b)
    assert.equal(blob('HEAD'), variant(2))
    assert.equal(git(dir, 'status', '--porcelain'), '')

    // A rebase replays commits whose trees are unchanged.
    git(dir, 'checkout', '-q', 'feat')
    git(dir, 'rebase', 'main')
    assert.equal(blob('HEAD'), variant(2))
    assert.equal(blob('HEAD~1'), variant(1))
    assert.equal(git(dir, 'status', '--porcelain'), '')

    // An unrelated commit leaves no staged notebook change behind.
    writeFileSync(join(dir, 'a.txt'), '2')
    git(dir, 'commit', '-q', '-am', 'unrelated')
    assert.equal(git(dir, 'status', '--porcelain'), '')
    assert.equal(blob('HEAD'), variant(2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('post-commit reports a notebook it cannot clean and carries on', () => {
  const dir = makeRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), '0')
    git(dir, 'add', 'a.txt')
    git(dir, 'commit', '-q', '-m', 'base')
    writeFileSync(join(dir, 'old.ipynb'), v3Notebook())
    writeFileSync(join(dir, 'new.ipynb'), dirtyNotebook())
    git(dir, 'add', 'old.ipynb', 'new.ipynb')
    git(dir, 'commit', '-q', '-m', 'both') // hooks off
    git(dir, 'reset', '-q', '--soft', 'HEAD~1') // both are now staged against `base`
    const run = spawnSync(
      'node',
      [join(SCRIPTS, 'strip-notebook-outputs.mjs'), '--post-commit'],
      {
        cwd: dir,
        env: cleanEnv(),
        encoding: 'utf8',
      }
    )
    assert.equal(run.status, 0)
    assert.match(
      run.stderr,
      /commit made; could not clean the index copy of old\.ipynb/
    )
    assert.deepEqual(notebookProblems(git(dir, 'show', ':new.ipynb')), []) // went on to the next
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
