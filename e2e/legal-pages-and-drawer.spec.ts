/**
 * WEB-75/WEB-76, end to end: the drawer's own MCP entry names what it does
 * rather than the protocol acronym, and the published legal documents carry
 * a real header bar and drawer (`components/PublicChrome.tsx`, WEB-76
 * rework round 1) — the app's own name and description in the header, never
 * an organization, and a drawer offering to sign in (or a way back into the
 * app, already signed in).
 *
 * Real throughout: the browser, `apps/web`'s own build, a real `apps/api`
 * and a real throwaway SQLite database (the same harness every other spec
 * in this directory shares) — nothing here is faked, since both halves are
 * pure rendering, with no external call to stand in for.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import { signIn } from './support/sign-in.js'

test('the drawer offers "Connect to other AI tools", not the bare acronym (WEB-75)', async ({
  page,
}) => {
  const email = `web75-${randomUUID().slice(0, 8)}@example.edu`
  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await page.getByRole('button', { name: 'Open navigation menu' }).click()
  await expect(
    page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', {
      name: 'Connect to other AI tools',
    })
  ).toBeVisible()
  await expect(
    page
      .getByRole('dialog', { name: 'Navigation' })
      .getByRole('button', { name: 'MCP', exact: true })
  ).not.toBeVisible()

  // The route/key are unchanged — the renamed entry still opens the same
  // screen (`pages/Mcp.tsx`'s own heading, untouched by this rename).
  await page
    .getByRole('dialog', { name: 'Navigation' })
    .getByRole('button', { name: 'Connect to other AI tools' })
    .click()
  await expect(
    page.getByRole('heading', { name: 'MCP', level: 1 })
  ).toBeVisible()
})

test('the privacy page, signed out: header names the app, drawer offers to sign in, Home, Privacy, Terms — no organization link', async ({
  page,
}) => {
  await page.goto('/privacy')

  await expect(page.getByTestId('privacy-page')).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Privacy policy', level: 1 })
  ).toBeVisible()
  // The header names the app itself, never an organization — no
  // `OrganizationSwitcher` anywhere on this page.
  await expect(page.getByRole('banner')).toContainText('Bloombot')
  await expect(page.getByRole('banner')).toContainText('AI course assistant')
  await expect(page.getByTestId('organization-switcher')).not.toBeVisible()

  await page.getByRole('button', { name: 'Open navigation menu' }).click()
  const drawer = page.getByRole('dialog', { name: 'Navigation' })
  await expect(
    drawer.getByRole('button', { name: 'Log in or sign up' })
  ).toBeVisible()
  // Round 2, must-fix 12 — no redundant "Home" item (same address as "Log
  // in or sign up").
  await expect(
    drawer
      .getByRole('navigation', { name: 'Main' })
      .getByRole('button', { name: 'Home' })
  ).not.toBeVisible()
  await expect(
    drawer.getByRole('button', { name: 'Back to Bloombot' })
  ).not.toBeVisible()
  // No org/project/course/chat link anywhere in the drawer.
  for (const label of [
    'Projects',
    'Chat',
    'Transcripts',
    'Organization settings',
  ]) {
    await expect(drawer.getByRole('button', { name: label })).not.toBeVisible()
  }
  // The two legal documents, listed in the drawer the same as every other
  // screen (`components/AppShell.tsx`'s own Legal nav).
  await expect(
    drawer.getByRole('link', { name: 'Privacy policy' })
  ).toBeVisible()
  await expect(
    drawer.getByRole('link', { name: 'Terms & conditions' })
  ).toBeVisible()

  // "Log in or sign up" is the sign-in entry point itself (`/`) —
  // `App.tsx`'s own `resolveHomeRoute` sends a signed-out visitor straight
  // to the sign-in screen.
  await drawer.getByRole('button', { name: 'Log in or sign up' }).click()
  await expect(page.getByTestId('accept-legal')).toBeVisible()
})

test('the privacy page, signed in: same header, drawer offers a way back into the app instead of a sign-in prompt', async ({
  page,
}) => {
  const email = `web76-${randomUUID().slice(0, 8)}@example.edu`
  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await page.goto('/privacy')

  await expect(page.getByTestId('privacy-page')).toBeVisible()
  await expect(page.getByRole('banner')).toContainText('Bloombot')
  await expect(page.getByTestId('organization-switcher')).not.toBeVisible()

  await page.getByRole('button', { name: 'Open navigation menu' }).click()
  const drawer = page.getByRole('dialog', { name: 'Navigation' })
  await expect(
    drawer.getByRole('button', { name: 'Back to Bloombot' })
  ).toBeVisible()
  await expect(
    drawer.getByRole('button', { name: 'Log in or sign up' })
  ).not.toBeVisible()
  // No sign-in prompt anywhere on this page for an account already signed
  // in.
  await expect(
    page.getByRole('button', { name: /email me a sign-in link/i })
  ).not.toBeVisible()

  await drawer.getByRole('button', { name: 'Back to Bloombot' }).click()
  await expect(page.getByTestId('organization-switcher')).toBeVisible()
})
