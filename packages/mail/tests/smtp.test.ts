/**
 * AUTH-5 — `createSmtpEmailSender` against a real, in-process SMTP server on
 * loopback (`tests/helpers/fake-smtp-server.ts`), never a real relay. Every
 * scenario nodemailer can actually produce against that fake was reproduced
 * once, by hand, to derive `errors.ts#classifySmtpError`'s own mapping
 * before this suite was written — the comments there cite exactly which of
 * these scenarios proved which code.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSmtpEmailSender } from '../src/smtp.js'
import { createFakeLogger } from './helpers/fake-logger.js'
import { FakeSmtpServer } from './helpers/fake-smtp-server.js'

// The credential this whole slice's brief says may never reach a log line,
// an error message or an exception — present in every message body this
// suite sends, so a leak anywhere would fail the "never contains" assertion
// below rather than pass by accident.
const SIGN_IN_LINK_BODY =
  'Use this link to sign in: https://panel.example/sign-in/SECRET-TOKEN-abc123'

describe('createSmtpEmailSender (AUTH-5)', () => {
  let server: FakeSmtpServer

  afterEach(async () => {
    await server.stop()
  })

  it('sends a message through a real SMTP conversation', async () => {
    server = await FakeSmtpServer.start()
    const logger = createFakeLogger()
    const sender = createSmtpEmailSender({
      host: '127.0.0.1',
      port: server.port,
      from: 'noreply@bloombot.test',
      logger,
      requireTLS: false, // this fake never offers STARTTLS — see its own module comment
    })

    await sender.send(
      'student@example.com',
      'Sign in to Bloombot',
      SIGN_IN_LINK_BODY
    )

    expect(server.received).toHaveLength(1)
    expect(server.received[0]).toMatchObject({
      from: 'noreply@bloombot.test',
      to: ['student@example.com'],
      subject: 'Sign in to Bloombot',
      text: SIGN_IN_LINK_BODY,
    })
    // The success log carries recipient and subject only — the same rule
    // `apps/api/src/logging-email-sender.ts`'s own stand-in holds itself
    // to for exactly the same reason.
    expect(JSON.stringify(logger.infoCalls)).not.toContain(
      'SECRET-TOKEN-abc123'
    )
  })

  it('sends through an authenticated relay when credentials are correct', async () => {
    server = await FakeSmtpServer.start({
      requireAuth: { user: 'bloombot', pass: 'hunter2' },
    })
    const logger = createFakeLogger()
    const sender = createSmtpEmailSender({
      host: '127.0.0.1',
      port: server.port,
      from: 'noreply@bloombot.test',
      auth: { user: 'bloombot', pass: 'hunter2' },
      logger,
      requireTLS: false,
    })

    await sender.send(
      'student@example.com',
      'Sign in to Bloombot',
      SIGN_IN_LINK_BODY
    )

    expect(server.received).toHaveLength(1)
  })

  it('rejects with a classified auth_failed error on bad credentials, logging no credential and no body', async () => {
    server = await FakeSmtpServer.start({
      requireAuth: { user: 'bloombot', pass: 'hunter2' },
    })
    const logger = createFakeLogger()
    const sender = createSmtpEmailSender({
      host: '127.0.0.1',
      port: server.port,
      from: 'noreply@bloombot.test',
      auth: { user: 'bloombot', pass: 'wrong-password' },
      logger,
      requireTLS: false,
    })

    const rejection = sender.send(
      'student@example.com',
      'Sign in to Bloombot',
      SIGN_IN_LINK_BODY
    )
    await expect(rejection).rejects.toMatchObject({
      name: 'MailTransportError',
      kind: 'auth_failed',
    })
    expect(server.received).toHaveLength(0)

    // The whole point of this test: nothing about the failed attempt —
    // not the password, not the link this send was carrying — reached the
    // log this adapter itself writes on a failed send.
    const serialized = JSON.stringify(logger.errorCalls)
    expect(serialized).not.toContain('wrong-password')
    expect(serialized).not.toContain('SECRET-TOKEN-abc123')
    expect(serialized).not.toContain(SIGN_IN_LINK_BODY)
  })

  it('rejects with a classified rejected error when the relay refuses the recipient, logging no body', async () => {
    server = await FakeSmtpServer.start({ rejectRecipientWith: 550 })
    const logger = createFakeLogger()
    const sender = createSmtpEmailSender({
      host: '127.0.0.1',
      port: server.port,
      from: 'noreply@bloombot.test',
      logger,
      requireTLS: false,
    })

    const rejection = sender.send(
      'nobody@example.com',
      'Sign in to Bloombot',
      SIGN_IN_LINK_BODY
    )
    await expect(rejection).rejects.toMatchObject({
      name: 'MailTransportError',
      kind: 'rejected',
      responseCode: 550,
    })

    const serialized = JSON.stringify(logger.errorCalls)
    expect(serialized).not.toContain(SIGN_IN_LINK_BODY)
    expect(serialized).not.toContain('SECRET-TOKEN-abc123')
  })

  it('rejects with a classified connection_failed error against nothing listening', async () => {
    // No `server = ...` here — `afterEach` guards with `server.stop()`, so
    // point it at a fake this test itself starts and stops, closed before
    // the send is attempted, to prove ECONNREFUSED classifies correctly
    // without leaving a real listener on the port this asserts against.
    const closed = await FakeSmtpServer.start()
    const port = closed.port
    await closed.stop()
    server = await FakeSmtpServer.start() // afterEach needs something to stop

    const logger = createFakeLogger()
    const sender = createSmtpEmailSender({
      host: '127.0.0.1',
      port,
      from: 'noreply@bloombot.test',
      logger,
      requireTLS: false,
    })

    await expect(
      sender.send(
        'student@example.com',
        'Sign in to Bloombot',
        SIGN_IN_LINK_BODY
      )
    ).rejects.toMatchObject({
      name: 'MailTransportError',
      kind: 'connection_failed',
    })
  })

  it('refuses to send in the clear when the relay offers no STARTTLS and requireTLS is left at its default', async () => {
    server = await FakeSmtpServer.start()
    const logger = createFakeLogger()
    // No `requireTLS: false` this time — the production default, against a
    // fake that (this file's own module comment) never offers STARTTLS.
    const sender = createSmtpEmailSender({
      host: '127.0.0.1',
      port: server.port,
      from: 'noreply@bloombot.test',
      logger,
    })

    await expect(
      sender.send(
        'student@example.com',
        'Sign in to Bloombot',
        SIGN_IN_LINK_BODY
      )
    ).rejects.toMatchObject({ name: 'MailTransportError' })
    // Never delivered — this is the assertion that matters: a bearer
    // credential must never have crossed the network unencrypted.
    expect(server.received).toHaveLength(0)
  })

  describe('construction', () => {
    beforeEach(async () => {
      server = await FakeSmtpServer.start()
    })

    it('throws when host is empty', () => {
      const logger = createFakeLogger()
      expect(() =>
        createSmtpEmailSender({
          host: '',
          port: server.port,
          from: 'noreply@bloombot.test',
          logger,
        })
      ).toThrow(/host/)
    })

    it('throws when from is empty', () => {
      const logger = createFakeLogger()
      expect(() =>
        createSmtpEmailSender({
          host: '127.0.0.1',
          port: server.port,
          from: '',
          logger,
        })
      ).toThrow(/from/)
    })
  })
})
