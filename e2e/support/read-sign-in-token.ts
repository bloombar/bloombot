/**
 * QA-7's `auth-flow.spec.ts` and QA-8's own spec both need "read the
 * sign-in link the API actually mailed back out of `FileEmailSender`'s own
 * file" — pulled out here so neither duplicates it inline (finding 9 of the
 * WEB-7 rework fixed `auth-flow.spec.ts`'s own copy, which had drifted back
 * into a byte-identical inline duplicate rather than importing this).
 * Polls `E2E_MAIL_PATH` (`file-email-sender.ts`'s own JSONL file) for the
 * mail sent to `to`, and returns the token off the end of its body.
 */

import { readFileSync } from 'node:fs'

import { expect } from '@playwright/test'

import { E2E_MAIL_PATH } from './env.js'

interface RecordedEmail {
  to: string
  subject: string
  body: string
}

function readMail(): RecordedEmail[] {
  return readFileSync(E2E_MAIL_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecordedEmail)
}

export async function readSignInToken(to: string): Promise<string> {
  await expect(async () => {
    expect(readMail().some((message) => message.to === to)).toBe(true)
  }).toPass({ timeout: 10_000 })

  // The *latest* mail to `to`, not the first — `FileEmailSender` appends,
  // so an address mailed more than once in the same run (a test requesting
  // a second link, say, after letting the first one go stale) had `.find`
  // return the earliest, already-redeemed-or-stale token instead of the one
  // that still works (finding 9 of the WEB-7 rework).
  const message = readMail()
    .reverse()
    .find((entry) => entry.to === to)
  if (!message) throw new Error(`no mail was sent to ${to}`)

  const token = message.body.split('/sign-in/')[1]?.trim()
  if (!token) {
    throw new Error(`sign-in link not found in mail body: ${message.body}`)
  }
  return token
}
