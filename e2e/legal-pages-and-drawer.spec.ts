/**
 * WEB-75/WEB-76, end to end: the drawer's own MCP entry names what it does
 * rather than the protocol acronym, and the published legal documents carry
 * the same header/footer chrome the rest of the signed-out panel does —
 * whether or not anyone is signed in.
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

test('the privacy page carries the site header and footer, signed out (WEB-76)', async ({
  page,
}) => {
  await page.goto('/privacy')

  await expect(page.getByTestId('privacy-page')).toBeVisible()
  // `SignInHeader` — the same branding `pages/Home.tsx` shows above its own
  // `SignIn` panel.
  await expect(
    page.getByRole('heading', { name: 'Bloombot', level: 1 })
  ).toBeVisible()
  // `SiteFooter` — the legal-links row, reachable from here too.
  await expect(page.getByTestId('site-footer')).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Privacy policy', level: 1 })
  ).toBeVisible()
})

test('the privacy page carries the same chrome, signed in, with no sign-in prompt (WEB-76)', async ({
  page,
}) => {
  const email = `web76-${randomUUID().slice(0, 8)}@example.edu`
  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await page.goto('/privacy')

  await expect(page.getByTestId('privacy-page')).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Bloombot', level: 1 })
  ).toBeVisible()
  await expect(page.getByTestId('site-footer')).toBeVisible()
  // `SignInHeader` carries no sign-in action of its own — this is what
  // actually proves a signed-in visitor never sees one here.
  await expect(
    page.getByRole('button', { name: /email me a sign-in link/i })
  ).not.toBeVisible()
})
