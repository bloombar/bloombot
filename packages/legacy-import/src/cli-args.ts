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
  /** MIG-5 — `--organization <id>`: import into an existing organization. */
  organizationId: string | undefined
  /** MIG-5 — each `--route "<prefix>=<course id>"`. */
  routes: { prefix: string; courseId: string }[]
}

/** Read a flag's value in either `--flag value` or `--flag=value` form; `i` is advanced past a separate value. */
function readValue(
  argv: string[],
  i: number,
  flag: string
): { value: string; next: number } {
  const arg = argv[i] as string
  const inline = arg.startsWith(`${flag}=`)
  const value = inline ? arg.slice(flag.length + 1) : argv[i + 1]
  if (value === undefined || value.trim() === '' || value.startsWith('--')) {
    throw new Error(`${flag} needs a non-empty value.`)
  }
  return { value: value.trim(), next: inline ? i : i + 1 }
}

/**
 * Split `argv` (already without node and script) into the two positional
 * paths and the optional `--source`, `--organization` and repeatable `--route`
 * flags (each as `--flag value` or `--flag=value`). With `--organization` the
 * YAML path is ignored, but still positional (pass `-`).
 * `--i-know` is read elsewhere (`guard.ts`) and ignored here. An empty or
 * missing `--source` value throws — an empty label would silently behave
 * like no label at all.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const positional: string[] = []
  let source: string | undefined
  let organizationId: string | undefined
  const routes: { prefix: string; courseId: string }[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg === '--i-know') continue
    const flag = ['--source', '--organization', '--route'].find(
      (name) => arg === name || arg.startsWith(`${name}=`)
    )
    if (!flag) {
      positional.push(arg)
      continue
    }
    const { value, next } = readValue(argv, i, flag)
    i = next
    if (flag === '--source') source = value
    else if (flag === '--organization') organizationId = value
    else {
      const at = value.lastIndexOf('=')
      const prefix = value.slice(0, at).trim()
      const courseId = value.slice(at + 1).trim()
      if (at < 0 || prefix === '' || courseId === '') {
        throw new Error('--route must look like "Python=<course id>".')
      }
      if (routes.some((r) => r.prefix.toLowerCase() === prefix.toLowerCase())) {
        throw new Error(
          `--route prefix '${prefix}' is given more than once (prefixes are case-insensitive).`
        )
      }
      routes.push({ prefix, courseId })
    }
  }
  if (routes.length > 0 && organizationId === undefined) {
    throw new Error('--route needs --organization.')
  }
  return {
    snapshotPath: positional[0],
    yamlPath: positional[1],
    source,
    organizationId,
    routes,
  }
}
