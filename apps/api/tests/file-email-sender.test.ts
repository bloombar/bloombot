/**
 * OPS-14: a developer running the stack locally has to be able to complete a
 * sign-in, and a sign-in link is a bearer credential that is deliberately
 * never logged and cannot be recovered from a database that stores tokens
 * hashed. `MAIL_FILE` is the development-only way in — and the property worth
 * testing is not that it writes a file, but that it *refuses* to in
 * production, where writing sign-in links to disk on the box serving real
 * students is the exact failure the logging stand-in exists to avoid.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileEmailSender } from '../src/file-email-sender.js'
import { buildEmailSender, type SmtpEnv } from '../src/logging-email-sender.js'
import { createFakeLogger } from './helpers/fake-logger.js'

// An `SmtpEnv` with nothing set — `smtp-email-sender.test.ts` covers the
// SMTP branch itself; this file's own concern is `MAIL_FILE` and the
// logging stand-in, so every call here passes SMTP as unconfigured.
const UNCONFIGURED_SMTP: SmtpEnv = {
  host: '',
  port: 587,
  from: '',
  user: undefined,
  password: undefined,
}

// AUTH-5's must-fix 4: a stray `MAIL_FILE` in production, with SMTP fully
// configured, must never resolve to `FileEmailSender` — the one production
// combination that would leak fifteen-minute bearer credentials to disk on
// the box serving real students.
const CONFIGURED_SMTP: SmtpEnv = {
  host: '127.0.0.1',
  port: 587,
  from: 'noreply@bloombot.test',
  user: undefined,
  password: undefined,
}

let scratch: string | undefined

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

const scratchFile = (): string => {
  scratch = mkdtempSync(join(tmpdir(), 'bloombot-mail-'))
  return join(scratch, 'nested', 'mail.jsonl')
}

describe('FileEmailSender', () => {
  it('writes one JSON line per message, body included, creating the directory', async () => {
    const path = scratchFile()
    const sender = new FileEmailSender(path)

    await sender.send(
      'student@example.edu',
      'Sign in',
      'https://panel/sign-in/tok'
    )
    await sender.send(
      'other@example.edu',
      'Sign in',
      'https://panel/sign-in/tok2'
    )

    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    const second = JSON.parse(lines[1] ?? '') as { to: string; body: string }
    expect(second.to).toBe('other@example.edu')
    // The body — the link — is the whole point of this sender: without it a
    // local sign-in cannot be completed at all.
    expect(second.body).toContain('/sign-in/tok2')
  })
})

describe('buildEmailSender', () => {
  it('uses the file sender in development when MAIL_FILE is set', () => {
    const path = scratchFile()
    expect(
      buildEmailSender(
        'development',
        path,
        UNCONFIGURED_SMTP,
        createFakeLogger()
      )
    ).toBeInstanceOf(FileEmailSender)
  })

  it('falls back to the logging stand-in when MAIL_FILE is unset', () => {
    expect(
      buildEmailSender(
        'development',
        undefined,
        UNCONFIGURED_SMTP,
        createFakeLogger()
      )
    ).not.toBeInstanceOf(FileEmailSender)
  })

  it('refuses to start in production, even with MAIL_FILE set, when SMTP is not configured', () => {
    // A stray MAIL_FILE in a production environment must fail loudly rather
    // than quietly begin writing credentials to disk — and production never
    // even looks at it, SMTP-unconfigured or not.
    const path = scratchFile()
    expect(() =>
      buildEmailSender(
        'production',
        path,
        UNCONFIGURED_SMTP,
        createFakeLogger()
      )
    ).toThrow(/no real mail transport/i)
    expect(() =>
      buildEmailSender(
        'production',
        undefined,
        UNCONFIGURED_SMTP,
        createFakeLogger()
      )
    ).toThrow(/no real mail transport/i)
  })

  // AUTH-5's must-fix 4: the 12-case selection matrix's own one dangerous
  // combination. Before this test existed, moving the `MAIL_FILE` branch
  // inside the production check (ahead of the SMTP one) would have left
  // every other test in this file green while a production box with SMTP
  // configured and a stray `MAIL_FILE` started silently appending
  // fifteen-minute sign-in links to a file on the host.
  it('never yields the file sender in production, even with MAIL_FILE set and SMTP configured', () => {
    const path = scratchFile()
    const sender = buildEmailSender(
      'production',
      path,
      CONFIGURED_SMTP,
      createFakeLogger()
    )
    expect(sender).not.toBeInstanceOf(FileEmailSender)
  })
})
