/**
 * WEB-29/WEB-30, end to end: the drawer is the only navigation, at a
 * desktop viewport as much as a narrow one — no header row duplicates it —
 * and the header itself names the acting organization and carries the
 * profile control that reaches account settings.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline `keyboard.spec.ts`
 * — this file's own sibling, reached through the identical sign-in flow —
 * already holds itself to): everything here is real — the browser
 * (`components/AppShell.tsx`, `pages/Shell.tsx`, `pages/Account.tsx`), a
 * real `apps/api`, and a real throwaway SQLite database. Nothing in this
 * spec needs a model or a Discord round trip, so neither is stood in for;
 * there is simply none in the path this spec drives.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import { readSignInToken } from './support/read-sign-in-token.js'

test('the navigation drawer is the only nav at a desktop viewport, and the header names the organization and reaches account settings (WEB-29, WEB-30)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web29-${suffix}@example.edu`

  // Playwright's own default viewport (`playwright.config.ts` sets none,
  // so this is Playwright's 1280x720 default) is already a desktop width —
  // WEB-29's own point is that there is no wider breakpoint where a second,
  // header-row copy of the nav appears.
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(email)
  const token = await readSignInToken(email)
  await page.goto(`/sign-in/${token}`)

  // WEB-30: a fresh account has exactly one organization (TEN-1's personal
  // organization) — the header names it plainly, not as a dropdown.
  const organizationName = await page
    .getByTestId('organization-switcher')
    .textContent()
  expect(organizationName).toBeTruthy()

  // WEB-29: the nav is not a header row at this width — "Projects" (the
  // default tab, already active) is not a control the header exposes
  // before the drawer opens.
  await expect(page.getByRole('button', { name: 'Projects' })).not.toBeVisible()

  // Opens from the hamburger, immediately left of the home control.
  await page.getByRole('button', { name: 'Open navigation menu' }).click()
  const drawer = page.getByRole('dialog', { name: 'Navigation' })
  await expect(drawer).toBeVisible()

  // Follow a link — Transcripts, a tab this account's own membership
  // reaches.
  await drawer.getByRole('button', { name: 'Transcripts' }).click()
  await expect(page.getByRole('heading', { name: 'Transcripts' })).toBeVisible()
  // The drawer's own item click closes it (`AppShell.tsx`'s own
  // `closeDrawer` alongside `item.onClick`).
  await expect(drawer).toBeHidden()

  // Reopen, and close with Escape this time — the native `<dialog>` still
  // governs Escape (WEB-17), even though the drawer is now the only nav at
  // every width.
  await page.getByRole('button', { name: 'Open navigation menu' }).click()
  await expect(drawer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()

  // WEB-30: the header's trailing edge is the profile control — it opens
  // account settings.
  await page.getByRole('button', { name: 'Account settings' }).click()
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible()
  await expect(page.getByText(email)).toBeVisible()
  // The one organization this account has is listed, and marked active.
  const accountPage = page.getByTestId('account-page')
  await expect(accountPage.getByText('Active')).toBeVisible()

  // The header still names the acting organization while account settings
  // is the active screen — WEB-30's own text says this is not organization-
  // scoped, not that the header stops showing one.
  await expect(page.getByTestId('organization-switcher')).toContainText(
    (organizationName ?? '').trim()
  )
})
