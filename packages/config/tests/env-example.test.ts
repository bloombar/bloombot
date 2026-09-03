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

  it('leaves every credential-shaped variable empty, not merely placeholder-shaped', () => {
    // A pasted real credential looks exactly like a placeholder to a pattern
    // list keyed on known vendor prefixes (sk-…, xox[baprs]-) — that check
    // only catches secrets whose shape someone thought to enumerate in
    // advance, and it would have said nothing about a live Discord bot token
    // sitting in BOT_TOKEN=. The stronger, shape-independent invariant: any
    // key whose *name* looks like a credential must carry no value at all.
    const CREDENTIAL_NAME = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/
    const nonEmpty: string[] = []
    for (const line of contents.split('\n')) {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(\S.*)$/.exec(line)
      if (match?.[1] && CREDENTIAL_NAME.test(match[1])) {
        nonEmpty.push(match[1])
      }
    }

    expect(nonEmpty).toEqual([])
  })

  it('holds no known vendor credential prefix, as a second, independent check', () => {
    // A tracked template that ever contains a live value is a leaked secret.
    // Kept alongside the name-based check above: this one catches a real
    // credential pasted into a variable whose name does not happen to
    // contain TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL.
    expect(contents).not.toMatch(/\b(sk-[A-Za-z0-9]{16,}|xox[baprs]-)/)
  })

  // The gap this closes, found by somebody following docs/RUNNING_LOCALLY.md:
  // `MAIL_FILE` was documented in the guide and missing from the template, so
  // `cp env.example .env` produced a checkout where requesting a sign-in link
  // succeeded and the link went nowhere. The schema check above cannot see it —
  // it is read straight from `process.env` by the process that needs it, the
  // same as the credentials, and deliberately not part of `envSchema`. So the
  // variables an app reads outside the schema are pinned here by name: adding
  // one to a `process.env[...]` read without adding it to the template is a red
  // build rather than an afternoon of confusion.
  it('documents the variables the apps read outside the schema', () => {
    const documented = documentedKeys(contents)
    const readDirectly = [
      'BOT_APP_ID',
      'BOT_PERMISSIONS',
      'BOT_TOKEN',
      'DISCORD_CLIENT_SECRET',
      // ENRL-12 — the join link secret's own AES-256-GCM key, read directly
      // by apps/api rather than through the schema (CFG-5), the same reason
      // DISCORD_CLIENT_SECRET is not part of envSchema either.
      'JOIN_LINK_ENCRYPTION_KEY',
      'MAIL_FILE',
      // AUTH-5 — the SMTP relay's own credentials, read directly by
      // apps/api rather than through the schema (CFG-5): a credential, the
      // same reason BOT_TOKEN/OPENAI_API_KEY are not part of envSchema
      // either. MAIL_SMTP_HOST/MAIL_SMTP_PORT/MAIL_FROM are not credentials
      // and go through the schema instead, so they need no entry here.
      'MAIL_SMTP_USER',
      'MAIL_SMTP_PASSWORD',
      'OPENAI_API_KEY',
      // OPS-12 — scripts/ops-monitor.mjs's own webhook and poll interval,
      // read directly rather than through the schema for the same reason
      // this whole list exists: it is not one of the four apps' processes
      // this schema validates, but a variable read from process.env still
      // needs to be pinned here so it cannot silently drift from
      // env.example.
      'OPS_ALERT_WEBHOOK_URL',
      'OPS_ALERT_POLL_INTERVAL_MS',
    ]
    const missing = readDirectly.filter((key) => !documented.has(key))
    expect(missing).toEqual([])
  })
})
