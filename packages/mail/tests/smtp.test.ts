/**
 * AUTH-5 — `createSmtpEmailSender` against a real, in-process SMTP server on
 * loopback (`tests/helpers/fake-smtp-server.ts`), never a real relay. Every
 * scenario nodemailer can actually produce against that fake was reproduced
 * once, by hand, to derive `errors.ts#classifySmtpError`'s own mapping
 * before this suite was written — the comments there cite exactly which of
 * these scenarios proved which code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

    // Must-fix 3 of the AUTH-5 rework: for `connection_failed` (and
    // `timed_out`, below), the underlying `error.message` is kept, not
    // discarded — it is generated locally by Node's own `net` stack, never
    // by a remote server, so it cannot carry a fragment of the message
    // being sent. Before that fix, this and a certificate-trust failure
    // were both indistinguishable `{"kind":"connection_failed","code":"ESOCKET"}`
    // — an operator had no way to tell "the relay is down" from "the relay
    // is up but its certificate is not trusted" (D-46's rework).
    await expect(
      sender.send(
        'student@example.com',
        'Sign in to Bloombot',
        SIGN_IN_LINK_BODY
      )
    ).rejects.toMatchObject({
      name: 'MailTransportError',
      kind: 'connection_failed',
      message: expect.stringContaining('ECONNREFUSED'),
    })
  })

  // Must-fix 3, the other half: `errors.ts`'s own module comment.
  // `smtp-server` does not exercise this shape (a server can only choose
  // when to respond, not never respond at all before its own handshake
  // starts) — a bare `net` listener that accepts the connection and then
  // writes nothing reproduces the exact case a reviewer probed manually.
  it('rejects with a classified timed_out error against a relay that accepts TCP and never greets, quickly', async () => {
    const { createServer } = await import('node:net')
    const neverGreets = createServer(() => {
      /* accept the connection; never write a greeting */
    })
    await new Promise<void>((resolve) =>
      neverGreets.listen(0, '127.0.0.1', resolve)
    )
    server = await FakeSmtpServer.start() // afterEach needs something to stop
    const address = neverGreets.address()
    if (!address || typeof address === 'string') {
      throw new Error('unreachable: bound above')
    }

    const logger = createFakeLogger()
    const sender = createSmtpEmailSender({
      host: '127.0.0.1',
      port: address.port,
      from: 'noreply@bloombot.test',
      logger,
      requireTLS: false,
    })

    const start = Date.now()
    await expect(
      sender.send(
        'student@example.com',
        'Sign in to Bloombot',
        SIGN_IN_LINK_BODY
      )
    ).rejects.toMatchObject({
      name: 'MailTransportError',
      kind: 'timed_out',
      message: expect.stringContaining('Greeting never received'),
    })
    // "Also fix" of the AUTH-5 rework: this used to hold for nodemailer's
    // own default (tens of seconds) — `/auth/request-link` is
    // unauthenticated, so an unbounded hold on it was a resource-hold
    // vector. `smtp.ts`'s own `GREETING_TIMEOUT_MS` bounds it to eight
    // seconds; fifteen leaves headroom for a loaded CI machine without
    // reintroducing the unbounded hold this test exists to catch.
    expect(Date.now() - start).toBeLessThan(15_000)

    await new Promise<void>((resolve) => neverGreets.close(() => resolve()))
  }, 20_000)

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

  // "Also fix" of the AUTH-5 rework: `smtp.ts`'s own single uncovered
  // branch — nothing constructed a sender against port 465 before this.
  // `nodemailer.createTransport` is spied rather than dialed for real: port
  // 465 means implicit TLS from the first byte of the connection, which
  // this fake (and every other one in this file) cannot speak, and proving
  // it would only re-test nodemailer's own TLS client, not this adapter's
  // own `secure`/`requireTLS` derivation.
  it('treats port 465 as implicit TLS, not STARTTLS', async () => {
    const nodemailer = await import('nodemailer')
    const spy = vi.spyOn(nodemailer.default, 'createTransport')
    try {
      createSmtpEmailSender({
        host: '127.0.0.1',
        port: 465,
        from: 'noreply@bloombot.test',
        logger: createFakeLogger(),
      })
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ secure: true, requireTLS: undefined })
      )
    } finally {
      spy.mockRestore()
    }
  })

  // "Also fix" of the AUTH-5 rework: every test above that actually sends
  // uses `requireTLS: false`, so none of them prove the production default
  // (`requireTLS: true`) ever *succeeds* — only that it refuses a relay
  // with no STARTTLS at all. This is that proof: a fake that genuinely
  // offers STARTTLS, backed by a real (self-signed, throwaway) certificate
  // `tests/helpers/self-signed-cert.ts` generates via `openssl`, with
  // `tlsCaPem` (test-only — `smtp.ts`'s own doc comment) telling nodemailer
  // to trust it. `server.received[0].secure` is the server's own account of
  // whether the handshake actually completed, not merely offered.
  it('sends successfully with requireTLS: true, against a relay that genuinely offers STARTTLS', async () => {
    const { generateSelfSignedCert } =
      await import('./helpers/self-signed-cert.js')
    const cert = generateSelfSignedCert()
    try {
      server = await FakeSmtpServer.start({
        tls: { key: cert.keyPem, cert: cert.certPem },
      })
      const logger = createFakeLogger()
      const sender = createSmtpEmailSender({
        host: '127.0.0.1',
        port: server.port,
        from: 'noreply@bloombot.test',
        logger,
        tlsCaPem: cert.certPem,
        // No `requireTLS: false` — the production default, proven to
        // actually succeed this time rather than merely refused.
      })

      await sender.send(
        'student@example.com',
        'Sign in to Bloombot',
        SIGN_IN_LINK_BODY
      )

      expect(server.received).toHaveLength(1)
      expect(server.received[0]?.secure).toBe(true)
      expect(logger.errorCalls).toHaveLength(0)
    } finally {
      cert.cleanup()
    }
  }, 20_000)

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
