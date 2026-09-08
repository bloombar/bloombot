/**
 * Test helper: a raw loopback TCP listener that speaks just enough SMTP to
 * get nodemailer through `EHLO`/`MAIL FROM`/`RCPT TO`/`DATA`, then — at the
 * end of `DATA` — writes an **unterminated** reply and destroys the
 * connection, instead of answering cleanly. `smtp-server` (this package's
 * other fake, `fake-smtp-server.ts`) cannot produce this: its own framing
 * always writes a complete, terminated response line, so it cannot
 * reproduce the one shape `packages/mail/src/errors.ts`'s own module
 * comment names — a content filter that rejects and drops mid-conversation
 * rather than answering `DATA`'s own terminator.
 *
 * This is exactly the wire shape that makes nodemailer's `smtp-connection`
 * raise `ECONNECTION` with the server's own trailing reply folded into
 * `.message` (and set as `.response`) — reproduced by hand against a real
 * loopback listener before this helper was written, the same way
 * `fake-smtp-server.ts`'s own module comment describes for its own shapes.
 * Bound to `127.0.0.1:0`, bind awaited, the same as every other fake in
 * this package.
 */

import { createServer, type Server, type Socket } from 'node:net'

export interface FakeDroppingRelayOptions {
  /** The exact, unterminated bytes written at the end of `DATA`, immediately before the socket is destroyed. */
  replyAtEndOfData: string
}

export class FakeDroppingRelay {
  private constructor(private readonly server: Server) {}

  static async start(
    options: FakeDroppingRelayOptions
  ): Promise<FakeDroppingRelay> {
    const server = createServer((socket: Socket) => {
      socket.write('220 fake.test ESMTP\r\n')
      let stage: 'greet' | 'mailfrom' | 'rcptto' | 'data' | 'body' = 'greet'
      let buffered = ''
      socket.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8')
        if (stage === 'greet' && /^(EHLO|HELO)/im.test(buffered)) {
          buffered = ''
          stage = 'mailfrom'
          socket.write('250-fake.test\r\n250 8BITMIME\r\n')
        } else if (stage === 'mailfrom' && /^MAIL FROM/im.test(buffered)) {
          buffered = ''
          stage = 'rcptto'
          socket.write('250 OK\r\n')
        } else if (stage === 'rcptto' && /^RCPT TO/im.test(buffered)) {
          buffered = ''
          stage = 'data'
          socket.write('250 OK\r\n')
        } else if (stage === 'data' && /^DATA/im.test(buffered)) {
          buffered = ''
          stage = 'body'
          socket.write('354 Start mail input\r\n')
        } else if (stage === 'body' && buffered.includes('\r\n.\r\n')) {
          // The end of DATA — a normal relay answers with a complete,
          // terminated line ("550 rejected\r\n"); this one writes an
          // incomplete line and destroys the connection instead, which is
          // what makes nodemailer treat the partial text as a "trailing
          // reply" on close rather than an ordinary parsed response.
          socket.write(options.replyAtEndOfData)
          socket.destroy()
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeAllListeners('error')
        resolve()
      })
    })
    return new FakeDroppingRelay(server)
  }

  get port(): number {
    const address = this.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('FakeDroppingRelay.port read before listening')
    }
    return address.port
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve())
    })
  }
}
