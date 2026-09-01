/**
 * QA-7: "At least one test drives a real browser against a real front end,
 * a real API and a real database: sign in, land in an organization, and
 * see what a signed-in instructor sees."
 *
 * Sign in with a real emailed link (read back out of the harness's own
 * `FileEmailSender`, `e2e/support/file-email-sender.ts`), land signed in,
 * see the organization the redeemed session created (TEN-1: a fresh
 * account's own personal organization), sign out, and confirm the session
 * is actually dead — not merely that the tab forgot it.
 */

import { readFileSync } from 'node:fs'

import { expect, test } from '@playwright/test'

import { E2E_MAIL_PATH } from './support/env.js'

interface RecordedEmail {
  to: string
  subject: string
  body: string
}

/** Polls `E2E_MAIL_PATH` (`FileEmailSender`'s own JSONL file) for the sign-in link mailed to `to`, and returns the token off the end of it. */
async function readSignInToken(to: string): Promise<string> {
  await expect(async () => {
    const lines = readFileSync(E2E_MAIL_PATH, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
    const mail: RecordedEmail[] = lines.map((line) => JSON.parse(line))
    expect(mail.some((message) => message.to === to)).toBe(true)
  }).toPass({ timeout: 10_000 })

  const lines = readFileSync(E2E_MAIL_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
  const mail: RecordedEmail[] = lines.map((line) => JSON.parse(line))
  const message = mail.find((entry) => entry.to === to)
  if (!message) throw new Error(`no mail was sent to ${to}`)

  const token = message.body.split('/sign-in/')[1]?.trim()
  if (!token) {
    throw new Error(`sign-in link not found in mail body: ${message.body}`)
  }
  return token
}

test('sign in by emailed link, land in an organization, sign out, and stay signed out', async ({
  page,
}) => {
  const email = `e2e-${Date.now()}@example.edu`

  // 1. The signed-out visitor requests a link.
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: 'Sign in to Bloombot' })
  ).toBeVisible()
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(email)

  // 2. Redeem the link the API actually sent.
  const token = await readSignInToken(email)
  await page.goto(`/sign-in/${token}`)

  // 3. Signed in: the shell renders, showing the organization this
  //    account's first sign-in created (TEN-1) — what a signed-in
  //    instructor sees (WEB-3).
  const organizationSwitcher = page.getByTestId('organization-switcher')
  await expect(organizationSwitcher).toBeVisible()
  await expect(organizationSwitcher).toContainText('owner')
  await expect(page.getByTestId('install-button')).toBeVisible()

  // The URL is replaced, not left on the single-use link — a reload must
  // not attempt to redeem the same token again.
  await expect(page).toHaveURL(/\/$/)

  // 4. Sign out, and confirm the session actually ended server-side: a
  //    fresh navigation must land back on the sign-in screen, not merely
  //    the same tab forgetting a piece of client state.
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(
    page.getByRole('heading', { name: 'Sign in to Bloombot' })
  ).toBeVisible()

  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Sign in to Bloombot' })
  ).toBeVisible()
})
