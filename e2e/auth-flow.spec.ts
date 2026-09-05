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

import { expect, test } from '@playwright/test'

import { navigateTo, signOut } from './support/navigate.js'
import { readSignInToken } from './support/read-sign-in-token.js'

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

  // The URL is replaced, not left on the single-use link — a reload must
  // not attempt to redeem the same token again. WEB-34: `/` itself is never
  // the address that lands here — it resolves, once signed in, to this
  // account's own canonical landing address (Projects, for the owner TEN-1
  // creates on first sign-in — `routing/route.ts`'s own `'projects'` route).
  await expect(page).toHaveURL(/\/o\/[^/]+\/projects$/)

  // The Discord tab is not the default one anymore (finding 10 of the
  // WEB-7 rework — `pages/Shell.tsx`'s own module comment) — this opens it
  // explicitly, the way an instructor reaching for the install button would.
  // WEB-32: navigating there is a real address change too.
  await navigateTo(page, 'Discord')
  await expect(page.getByTestId('install-button')).toBeVisible()
  await expect(page).toHaveURL(/\/o\/[^/]+\/discord$/)

  // 4. Sign out, and confirm the session actually ended server-side: a
  //    fresh navigation must land back on the sign-in screen, not merely
  //    the same tab forgetting a piece of client state.
  await signOut(page)
  await expect(
    page.getByRole('heading', { name: 'Sign in to Bloombot' })
  ).toBeVisible()

  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Sign in to Bloombot' })
  ).toBeVisible()
})
