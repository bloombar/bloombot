/**
 * Every spec that signs an account in duplicated the same
 * request-a-link-then-redeem-it sequence — 27 copies of it, at last count.
 * `SignIn.tsx` grew a `required` "I agree to the documents" checkbox
 * (`data-testid="accept-legal"`) that gates the email form's submission, and
 * every one of those copies broke the same way, at the same line, for the
 * same reason: none of them ticked it. Pulled out here so a future change to
 * the sign-in screen means editing this file, not 27 of them.
 *
 * Three exports, because specs redeem the link in three different shapes:
 *
 *  - `signIn` — the ordinary case: a cold `/` load, request, redeem, done.
 *  - `requestSignInLink` — a spec that is already on the page rendering
 *    `SignIn` inline (a join link, an invitation, a connect URL), or that
 *    needs the token itself before deciding where — or on which `page` — to
 *    redeem it (AUTH-6's cross-tab specs redeem on a second `Page` entirely).
 *  - `completeSignIn` — the same "already on the right page" case as
 *    `requestSignInLink`, for a spec that also wants the ordinary immediate
 *    redemption and has no need of the token itself.
 */

import { expect, type Page } from '@playwright/test'

import { readSignInToken } from './read-sign-in-token.js'

/**
 * Ticks the consent checkbox, requests the link, and returns the token the
 * API mailed back — but does not redeem it. The checkbox is ticked here, not
 * left to each caller, because it gates account creation (`SignIn.tsx`'s own
 * module comment: "there is no separate sign-up screen ... signing in for the
 * first time is how an account comes into being") and every caller needs it
 * ticked regardless of what it does with the token afterwards.
 */
export async function requestSignInLink(
  page: Page,
  email: string
): Promise<string> {
  await page.getByTestId('accept-legal').check()
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(email)
  return readSignInToken(email)
}

/**
 * `requestSignInLink`, then redeems the token on this same `page` — for a
 * spec that is already on the page `SignIn` renders inline (a join link, an
 * invitation, a connect URL) and wants the ordinary immediate redemption.
 */
export async function completeSignIn(page: Page, email: string): Promise<void> {
  const token = await requestSignInLink(page, email)
  await page.goto(`/sign-in/${token}`)
}

/**
 * The full sequence from a cold `/` load — the shape almost every spec
 * needs: navigate to the sign-in screen, agree to the documents, request a
 * link, and redeem it.
 */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/')
  await completeSignIn(page, email)
}
