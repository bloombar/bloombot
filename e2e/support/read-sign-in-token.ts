/**
 * QA-7's `auth-flow.spec.ts` and QA-8's own spec both need "read the
 * sign-in link the API actually mailed back out of `FileEmailSender`'s own
 * file" — pulled out here so QA-8 does not duplicate it inline. Behaviour
 * unchanged from `auth-flow.spec.ts`'s original inline version: poll
 * `E2E_MAIL_PATH` (`file-email-sender.ts`'s own JSONL file) for the mail
 * sent to `to`, and return the token off the end of its body.
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

  const message = readMail().find((entry) => entry.to === to)
  if (!message) throw new Error(`no mail was sent to ${to}`)

  const token = message.body.split('/sign-in/')[1]?.trim()
  if (!token) {
    throw new Error(`sign-in link not found in mail body: ${message.body}`)
  }
  return token
}
