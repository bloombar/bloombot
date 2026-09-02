/**
 * AUTH-5 — `buildEmailSender`'s SMTP branch: this is the fix for "apps/api
 * cannot start under NODE_ENV=production at all" (this slice's own brief).
 * A test that fails without the fix: before this slice, `buildEmailSender`
 * had no fourth (`smtp`) parameter at all, and its `NODE_ENV=production`
 * branch called `buildLoggingEmailSender`, which throws unconditionally —
 * so `it('starts in production when SMTP is fully configured', …)` below
 * would have thrown before this change existed, for every input.
 *
 * These tests exercise selection and validation only — never a real
 * connection. `createSmtpEmailSender` (`@bloombot/mail`) does not dial
 * anything until `send()` is called (PLAT-5: a factory, not a module-level
 * client), so building one against an address nothing listens on is safe
 * here; `packages/mail/tests/smtp.test.ts` is where the transport itself is
 * proven against a real loopback server.
 */

import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildEmailSender, type SmtpEnv } from '../src/logging-email-sender.js'
import { FileEmailSender } from '../src/file-email-sender.js'
import { LoggingEmailSender } from '../src/logging-email-sender.js'
import { createFakeLogger } from './helpers/fake-logger.js'

const CONFIGURED_SMTP: SmtpEnv = {
  host: '127.0.0.1',
  port: 587,
  from: 'noreply@bloombot.test',
  user: undefined,
  password: undefined,
}

describe('buildEmailSender — SMTP (AUTH-5)', () => {
  it('starts in production when SMTP is fully configured, rather than throwing', () => {
    const sender = buildEmailSender(
      'production',
      undefined,
      CONFIGURED_SMTP,
      createFakeLogger()
    )
    expect(sender).not.toBeInstanceOf(LoggingEmailSender)
    expect(sender).not.toBeInstanceOf(FileEmailSender)
    expect(typeof sender.send).toBe('function')
  })

  it('refuses to start in production when MAIL_SMTP_HOST is unset', () => {
    const smtp: SmtpEnv = { ...CONFIGURED_SMTP, host: '' }
    expect(() =>
      buildEmailSender('production', undefined, smtp, createFakeLogger())
    ).toThrow(/MAIL_SMTP_HOST/)
  })

  it('refuses to start in production when MAIL_FROM is unset', () => {
    const smtp: SmtpEnv = { ...CONFIGURED_SMTP, from: '' }
    expect(() =>
      buildEmailSender('production', undefined, smtp, createFakeLogger())
    ).toThrow(/MAIL_FROM/)
  })

  // "Also fix" of the AUTH-5 rework: `MAIL_FROM=Bloombot` — a plausible
  // typo for `MAIL_FROM=Bloombot <noreply@bloombot.example>` — used to
  // parse as a non-empty string and start happily, sending with an empty
  // envelope sender until a real relay rejected every attempt.
  it('refuses to start in production when MAIL_FROM does not parse to a valid address', () => {
    const smtp: SmtpEnv = { ...CONFIGURED_SMTP, from: 'Bloombot' }
    expect(() =>
      buildEmailSender('production', undefined, smtp, createFakeLogger())
    ).toThrow(/MAIL_FROM does not parse/)
  })

  it('accepts the display-name form of MAIL_FROM', () => {
    const smtp: SmtpEnv = {
      ...CONFIGURED_SMTP,
      from: 'Bloombot <noreply@bloombot.test>',
    }
    const sender = buildEmailSender(
      'production',
      undefined,
      smtp,
      createFakeLogger()
    )
    expect(typeof sender.send).toBe('function')
  })

  it('refuses when MAIL_SMTP_USER is set without MAIL_SMTP_PASSWORD, or the reverse', () => {
    const userOnly: SmtpEnv = { ...CONFIGURED_SMTP, user: 'bloombot' }
    const passwordOnly: SmtpEnv = {
      ...CONFIGURED_SMTP,
      password: 'hunter2',
    }
    expect(() =>
      buildEmailSender('production', undefined, userOnly, createFakeLogger())
    ).toThrow(/MAIL_SMTP_USER and MAIL_SMTP_PASSWORD/)
    expect(() =>
      buildEmailSender(
        'production',
        undefined,
        passwordOnly,
        createFakeLogger()
      )
    ).toThrow(/MAIL_SMTP_USER and MAIL_SMTP_PASSWORD/)
  })

  it('uses SMTP outside production when configured, even with no MAIL_FILE', () => {
    const sender = buildEmailSender(
      'development',
      undefined,
      CONFIGURED_SMTP,
      createFakeLogger()
    )
    expect(sender).not.toBeInstanceOf(LoggingEmailSender)
    expect(sender).not.toBeInstanceOf(FileEmailSender)
  })

  it('prefers MAIL_FILE over SMTP outside production, when both are configured', () => {
    // `FileEmailSender`'s constructor only `mkdirSync`s the parent
    // directory — nothing is ever written here, since `send()` is never
    // called. Under this repo's own `tmp/` (gitignored), the same
    // convention `packages/db/tests/helpers/test-db.ts` uses for a
    // throwaway path, rather than the OS tmpdir every other helper in this
    // suite avoids reaching outside the repo for.
    const path = join(
      process.cwd(),
      'tmp',
      'api-tests',
      'smtp-vs-file-test.jsonl'
    )
    const sender = buildEmailSender(
      'development',
      path,
      CONFIGURED_SMTP,
      createFakeLogger()
    )
    expect(sender).toBeInstanceOf(FileEmailSender)
  })
})
