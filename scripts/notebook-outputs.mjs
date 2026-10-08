/**
 * Shared logic for keeping Jupyter notebook outputs out of git (ANLY-8).
 *
 * Notebooks may show real student data in their output cells while someone is
 * working locally, but this repository is public, so none of it may be
 * committed or pushed. Outputs are wiped by tooling, not by convention:
 * `strip-notebook-outputs.mjs` (pre-commit) rewrites the *staged* copy,
 * `check-pushed-notebooks.mjs` (pre-push) refuses a push that still contains
 * any, and `notebook-outputs.test.mjs` fails CI if a tracked notebook has some.
 * All three use the two functions below.
 */

const LEGACY_MESSAGE =
  'is in the old notebook format (nbformat < 4 / worksheets), whose outputs cannot be checked: ' +
  'convert it with `jupyter nbconvert --to notebook`'

/** True for a pre-v4 notebook, whose cells live under `worksheets`, not `cells`. */
function isLegacyFormat(nb) {
  return (
    Boolean(nb.worksheets) ||
    (typeof nb.nbformat === 'number' && nb.nbformat < 4)
  )
}

/** Git pathspec matching every notebook, whatever the case of the extension. */
export const NOTEBOOK_PATHSPEC = ':(icase)*.ipynb'

/**
 * Returns the text of a notebook with every output removed: code-cell outputs
 * emptied, execution counts nulled, and the metadata that records a run
 * (per-cell `execution`, notebook-level `widgets`) dropped. Formatting follows
 * what Jupyter itself writes (one-space indent, trailing newline), so a
 * notebook that is already clean comes back byte-for-byte unchanged.
 */
export function stripNotebook(text) {
  const nb = JSON.parse(text)
  // Fail closed: an old-format notebook keeps its outputs under `worksheets`,
  // which the loop below would never see, so refuse rather than pass it through.
  if (isLegacyFormat(nb)) throw new Error(LEGACY_MESSAGE)
  for (const cell of nb.cells ?? []) {
    if (cell.cell_type === 'code') {
      cell.outputs = []
      cell.execution_count = null
    }
    if (cell.metadata) delete cell.metadata.execution
  }
  if (nb.metadata) delete nb.metadata.widgets
  return JSON.stringify(nb, null, 1) + '\n'
}

/**
 * Describes what is wrong with a notebook, as a list of short strings (empty
 * means clean): code cells with outputs, and code cells with an execution count.
 */
export function notebookProblems(text) {
  let nb
  try {
    nb = JSON.parse(text)
  } catch {
    return ['is not valid JSON, so its outputs cannot be checked']
  }
  if (isLegacyFormat(nb)) return [LEGACY_MESSAGE]
  const code = (nb.cells ?? []).filter((c) => c.cell_type === 'code')
  const problems = []
  const withOutputs = code.filter((c) => (c.outputs ?? []).length > 0).length
  const counted = code.filter((c) => c.execution_count != null).length
  if (withOutputs) problems.push(`${withOutputs} cell(s) with outputs`)
  if (counted) problems.push(`${counted} cell(s) with an execution count`)
  return problems
}
