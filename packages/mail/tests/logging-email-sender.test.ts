/**
 * Must-fix 1 of the API-1..6 rework: `LoggingEmailSender` must never write a
 * sign-in link (or any other email body) to the log, and a process must
 * refuse to start with it as the production default — a sign-in link is a
 * bearer credential, and `logs/*.log` is a protected path in this repo for
 * precisely this reason.
 *
 * ADMIN-14 — moved here from `apps/api/tests/logging-email-sender.test.ts`
 * when `LoggingEmailSender`/`buildLoggingEmailSender` moved into this
 * package (`src/build-email-sender.ts`'s own module comment).
 */

import { describe, expect, it } from 'vitest'

import { buildLoggingEmailSender, LoggingEmailSender } from '../src/index.js'
import { createFakeLogger } from './helpers/fake-logger.js'

describe('LoggingEmailSender — never logs the email body', () => {
  it('logs the recipient and subject, but not the body', async () => {
    const logger = createFakeLogger()
    const sender = new LoggingEmailSender('apps/api', logger)

    await sender.send(
      'student@example.edu',
      'Sign in to Bloombot',
      'Use this link to sign in to Bloombot: https://app.bloombot.test/sign-in/super-secret-token'
    )

    expect(logger.infoCalls).toHaveLength(1)
    const [fields] = logger.infoCalls[0]!
    expect(fields).toMatchObject({
      to: 'student@example.edu',
      subject: 'Sign in to Bloombot',
    })
    // The whole point: the credential-bearing body must not appear anywhere
    // in what was logged, under `body` or otherwise.
    expect(JSON.stringify(fields)).not.toContain('super-secret-token')
    expect((fields as Record<string, unknown>)['body']).toBeUndefined()
  })
})

describe('buildLoggingEmailSender — refuses to be the production default', () => {
  it('throws for NODE_ENV=production rather than returning a sender that would log credentials', () => {
    const logger = createFakeLogger()

    expect(() =>
      buildLoggingEmailSender('production', 'apps/api', logger)
    ).toThrow()
    // Startup failing loudly means nothing was logged on the way there —
    // this is a refusal to build, not a sender that logs and then throws.
    expect(logger.infoCalls).toHaveLength(0)
    expect(logger.errorCalls).toHaveLength(0)
  })

  it('returns a working LoggingEmailSender for development and test', async () => {
    const logger = createFakeLogger()

    const devSender = buildLoggingEmailSender('development', 'apps/api', logger)
    const testSender = buildLoggingEmailSender('test', 'apps/api', logger)

    expect(devSender).toBeInstanceOf(LoggingEmailSender)
    expect(testSender).toBeInstanceOf(LoggingEmailSender)
    await expect(
      devSender.send('student@example.edu', 'Subject', 'Body')
    ).resolves.toBeUndefined()
  })
})
