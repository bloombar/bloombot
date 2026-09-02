/**
 * Test helper: a loopback SMTP server (`smtp-server`, the nodemailer
 * project's own testing package) — the same shape
 * `packages/auth/tests/helpers/fake-google-server.ts` uses for Google, and
 * `packages/openai/tests/helpers/fake-openai-server.ts` uses for OpenAI.
 * Bound to `127.0.0.1:0` so the OS picks a free port, and `start()` awaits
 * the bind: the brief for this slice calls out a real, earlier bug in this
 * repository from binding the wildcard address in a test server instead.
 *
 * STARTTLS is disabled on every fake this helper builds — `smtp.ts`'s own
 * `requireTLS: true` default is what proves a relay offering no STARTTLS
 * is refused rather than sent to in the clear (`tests/smtp.test.ts`
 * exercises exactly that), so every *other* scenario here explicitly opts
 * out with `requireTLS: false` to test this adapter's own logic rather than
 * nodemailer's TLS handshake.
 *
 * `received` records every message this fake actually accepted, so a test
 * can assert on what the adapter sent — recipient, subject, body — without
 * trusting the adapter's own account of itself. Never used to assert what a
 * *test* is not allowed to check: this repository's own tests never send
 * real mail (module comment on `tests/smtp.test.ts`), but this fake stands
 * in for a real relay, entirely in-process, on loopback.
 */

import {
  SMTPServer,
  type SMTPServerAuthentication,
  type SMTPServerSession,
} from 'smtp-server'

/** One message this fake actually accepted through `DATA`. */
export interface ReceivedMessage {
  from: string
  to: string[]
  subject: string | undefined
  text: string | undefined
}

/**
 * `from`/`to` come from the envelope (`MAIL FROM`/`RCPT TO`) rather than the
 * message headers — the protocol-level truth of who this was actually sent
 * to, not a header nodemailer could in principle format differently.
 * `subject`/`text` come from the raw `DATA` a real client would only ever
 * read after a real relay accepted it, parsed just enough for a test to
 * assert against: `nodemailer.sendMail({ text })` writes plain 7-bit ASCII
 * with no header folding for the short, ASCII-only subjects and bodies
 * every test here sends, so a full MIME parser would only be exercising
 * itself.
 */
function parseMessage(
  raw: string,
  session: SMTPServerSession
): ReceivedMessage {
  const headerEnd = raw.indexOf('\r\n\r\n')
  const headerBlock = headerEnd === -1 ? raw : raw.slice(0, headerEnd)
  const body = headerEnd === -1 ? '' : raw.slice(headerEnd + 4)
  const subjectMatch = /^Subject: (.*)$/m.exec(headerBlock)
  return {
    from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
    to: session.envelope.rcptTo.map((recipient) => recipient.address),
    subject: subjectMatch?.[1],
    // Trailing CRLF the DATA terminator itself leaves behind.
    text: body.replace(/\r\n$/, '') || undefined,
  }
}

export interface FakeSmtpServerOptions {
  /** Reject every `AUTH` attempt except this exact user/pass pair. Omit to accept any credentials (or none, when the connecting client sends no `AUTH` at all). */
  requireAuth?: { user: string; pass: string }
  /** Reject every `RCPT TO` with this SMTP response code — simulates a relay refusing a recipient. */
  rejectRecipientWith?: number
}

export class FakeSmtpServer {
  private constructor(
    private readonly server: SMTPServer,
    readonly received: ReceivedMessage[]
  ) {}

  static async start(
    options: FakeSmtpServerOptions = {}
  ): Promise<FakeSmtpServer> {
    // Declared before the `SMTPServer` itself so `onData` below can push
    // onto it directly — no forward reference to a not-yet-constructed
    // `FakeSmtpServer` needed, and this same array becomes `received` on
    // the instance returned once listening starts.
    const received: ReceivedMessage[] = []
    const server = new SMTPServer({
      // No real deployment terminates STARTTLS with no certificate — this
      // fake never needs to, since `requireTLS: false` is how a test opts
      // out of TLS instead (this file's own module comment).
      disabledCommands: ['STARTTLS'],
      authOptional: !options.requireAuth,
      onAuth(
        auth: SMTPServerAuthentication,
        _session,
        callback: (err: Error | null, response?: { user: string }) => void
      ) {
        if (!options.requireAuth) {
          callback(null, { user: auth.username ?? '' })
          return
        }
        if (
          auth.username === options.requireAuth.user &&
          auth.password === options.requireAuth.pass
        ) {
          callback(null, { user: auth.username })
          return
        }
        callback(new Error('invalid credentials'))
      },
      onRcptTo(_address, _session, callback: (err?: Error) => void) {
        if (options.rejectRecipientWith) {
          const error = new Error('recipient rejected') as Error & {
            responseCode: number
          }
          error.responseCode = options.rejectRecipientWith
          callback(error)
          return
        }
        callback()
      },
      onData(stream, session, callback: (err?: Error) => void) {
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => {
          received.push(
            parseMessage(Buffer.concat(chunks).toString('utf8'), session)
          )
          callback()
        })
      },
    })
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', (error?: Error) =>
        error ? reject(error) : resolve()
      )
    })
    return new FakeSmtpServer(server, received)
  }

  get port(): number {
    const address = this.server.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('FakeSmtpServer.port read before listening')
    }
    return address.port
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve())
    })
  }
}
