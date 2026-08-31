/**
 * QA-6 — the environment template cannot drift from the schema.
 *
 * A variable added to the schema but not to `env.example` is invisible until a
 * deployment fails on it hours later. This test makes that a red build instead.
 *
 * The tracked template is `env.example` with no leading dot: `.gitignore`
 * swallows every `.env*` variant because this repository is public and those
 * files hold live credentials.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { envSchema } from '@bloombot/config'

const ENV_EXAMPLE = fileURLToPath(
  new URL('../../../env.example', import.meta.url)
)

/** Variable names assigned in the template, ignoring comments and blank lines. */
function documentedKeys(contents: string): Set<string> {
  const keys = new Set<string>()
  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)
    if (match?.[1]) keys.add(match[1])
  }
  return keys
}

describe('env.example (QA-6)', () => {
  const contents = readFileSync(ENV_EXAMPLE, 'utf8')

  it('documents every variable in the environment schema', () => {
    const documented = documentedKeys(contents)
    const missing = Object.keys(envSchema.shape).filter(
      (key) => !documented.has(key)
    )

    expect(missing).toEqual([])
  })

  it('holds no real credential, only placeholders', () => {
    // A tracked template that ever contains a live value is a leaked secret.
    expect(contents).not.toMatch(/\b(sk-[A-Za-z0-9]{16,}|xox[baprs]-)/)
  })
})
