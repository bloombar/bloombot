/**
 * Command-line argument parsing for `cli.ts`, kept apart so it can be tested
 * without running the import (and so importing it has no side effects).
 */

/** What the CLI was asked to do. */
export interface CliArgs {
  snapshotPath: string | undefined
  yamlPath: string | undefined
  /** MIG-5 — the `--source <label>` value, when given. */
  source: string | undefined
}

/**
 * Split `argv` (already without node and script) into the two positional
 * paths and the optional `--source <label>` / `--source=<label>` flag.
 * `--i-know` is read elsewhere (`guard.ts`) and ignored here. An empty or
 * missing `--source` value throws — an empty label would silently behave
 * like no label at all.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const positional: string[] = []
  let source: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg === '--i-know') continue
    if (arg === '--source' || arg.startsWith('--source=')) {
      const value =
        arg === '--source' ? argv[(i += 1)] : arg.slice('--source='.length)
      if (
        value === undefined ||
        value.trim() === '' ||
        value.startsWith('--')
      ) {
        throw new Error('--source needs a non-empty label, e.g. --source b')
      }
      source = value.trim()
      continue
    }
    positional.push(arg)
  }
  return { snapshotPath: positional[0], yamlPath: positional[1], source }
}
