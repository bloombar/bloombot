/**
 * The `EmailSender` port (`@bloombot/auth`), implemented for the e2e
 * harness only: appends every "sent" mail as one JSON line to a file, so
 * the Playwright test process — a separate process from the one running
 * `apps/api` (`start-api.ts`) — can read the sign-in link back out (QA-7,
 * this slice's brief: "with the mail port captured so the test can read
 * the sign-in link").
 *
 * Never `apps/api/src/logging-email-sender.ts`: that sender deliberately
 * never logs a sign-in link's body (a bearer credential, per its own module
 * comment) — exactly right for a real deployment, useless for a test that
 * needs to read the link. This is the harness's own stand-in, the same way
 * `RecordingEmailSender` (`@bloombot/auth`) is the unit-test one; this one
 * writes to a file instead of an in-memory array because the sender and
 * the assertion run in different processes here.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { EmailSender } from '@bloombot/auth'

export class FileEmailSender implements EmailSender {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
  }

  send(to: string, subject: string, body: string): Promise<void> {
    appendFileSync(this.path, `${JSON.stringify({ to, subject, body })}\n`)
    return Promise.resolve()
  }
}
