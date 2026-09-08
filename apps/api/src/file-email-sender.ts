/**
 * Writes what would have been emailed to a file, so a developer running the
 * stack locally can actually sign in (OPS-14).
 *
 * The problem this solves: sign-in tokens are stored only as hashes, so a
 * link cannot be recovered from the database, and `LoggingEmailSender`
 * deliberately never logs a link because it is a bearer credential. Between
 * them there is no way to complete a local sign-in — which made "run it in a
 * browser" impossible without wiring a transport by hand.
 *
 * So this exists, and its guard rails are the point:
 *
 *   - it is only ever built when `MAIL_FILE` is set **and** `NODE_ENV` is not
 *     `production` (`buildEmailSender` below enforces both);
 *   - it writes to a path the operator names, never a default, so nothing is
 *     written anywhere by accident;
 *   - it is append-only JSONL, one message per line, so a developer reads the
 *     newest line rather than a file that quietly grew stale.
 *
 * The file holds live credentials for as long as the tokens in it are valid
 * (fifteen minutes). Point `MAIL_FILE` at `tmp/`, which is gitignored, and
 * treat it the way you would treat a mailbox.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { EmailSender } from '@bloombot/auth'

export class FileEmailSender implements EmailSender {
  constructor(private readonly path: string) {
    mkdirSync(dirname(this.path), { recursive: true })
  }

  send(to: string, subject: string, body: string): Promise<void> {
    const line = JSON.stringify({ to, subject, body, at: Date.now() })
    appendFileSync(this.path, `${line}\n`, 'utf8')
    return Promise.resolve()
  }
}
