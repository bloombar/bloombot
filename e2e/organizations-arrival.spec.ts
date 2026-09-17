/**
 * WEB-55/WEB-56, end to end: an account belonging to more than one
 * organization signs in, lands on the arrival list rather than guessing,
 * picks one, and can switch straight back through the header's own
 * organization menu.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `link-10-connected-organization.spec.ts`/`navigation-drawer.spec.ts`
 * already hold themselves to): everything here is real — the browser
 * (`pages/Organizations.tsx`, `components/OrganizationSwitcher.tsx`,
 * `pages/Shell.tsx`), a real `apps/api`, and a real throwaway SQLite
 * database. Nothing in this spec needs a model or a Discord round trip, so
 * neither is stood in for.
 *
 * The account is seeded with two memberships *before* it ever signs in
 * (`accounts.createAccount` for the first, `memberships.createMembership`
 * for the second — the same repository functions a real invitation
 * acceptance or TEN-1's own personal-organization creation would call), so
 * the ordinary emailed-link sign-in redeems as a *returning* account that
 * already has both relationships, the same shape a real instructor teaching
 * at two institutions would have on their very next sign-in.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  memberships,
  openDatabase,
  organizations,
} from '@bloombot/db'

import { E2E_DATABASE_PATH } from './support/env.js'
import { signIn } from './support/sign-in.js'

test('an account belonging to two organizations signs in, sees the arrival list, picks the second, and lands in it; then switches back through the header menu (WEB-55, WEB-56)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web55-${suffix}@example.edu`
  const firstOrganizationId = randomUUID()
  const secondOrganizationId = randomUUID()
  const firstName = `First Institution — ${suffix}`
  const secondName = `Second Institution — ${suffix}`

  const seedDb = openDatabase(E2E_DATABASE_PATH)
  try {
    organizations.createOrganization(
      firstOrganizationId,
      { name: firstName, isPersonal: false },
      seedDb
    )
    organizations.createOrganization(
      secondOrganizationId,
      { name: secondName, isPersonal: false },
      seedDb
    )
    const account = accounts.createAccount(
      firstOrganizationId,
      { email, displayName: 'Instructor', role: 'owner' },
      seedDb
    )
    memberships.createMembership(
      secondOrganizationId,
      account.id,
      'assistant',
      seedDb
    )
  } finally {
    closeDatabase(seedDb)
  }

  // 1. The ordinary emailed-link sign-in — a *returning* account, since it
  //    already exists (seeded above), so no fresh personal organization is
  //    created alongside the two this test already gave it.
  await signIn(page, email)

  // 2. The arrival list, not a guess: both organizations, each named and
  //    labelled with this account's own relationship to it.
  await expect(page).toHaveURL('/choose-organization')
  const list = page.getByTestId('organizations-page')
  await expect(
    list.getByRole('heading', { name: 'Choose an organization' })
  ).toBeVisible()
  await expect(list.getByText(firstName)).toBeVisible()
  await expect(list.getByText(secondName)).toBeVisible()

  // 3. Choosing the second organization lands there.
  const secondRow = list.locator('li').filter({ hasText: secondName })
  await secondRow.getByRole('button', { name: 'Choose' }).click()
  await expect(page.getByTestId('organization-switcher')).toContainText(
    secondName
  )
  await expect(page).toHaveURL(
    new RegExp(`/o/${secondOrganizationId}/projects`)
  )

  // 4. Switching back through the header's own organization menu (WEB-56):
  //    a real menu, not a `<select>` — opened on click, listing every
  //    organization, marking the active one.
  await page.getByTestId('organization-switcher').getByRole('button').click()
  const menu = page.getByRole('group', { name: 'Organizations' })
  await expect(menu.getByText(firstName)).toBeVisible()
  const activeItem = menu.getByRole('button', { name: new RegExp(secondName) })
  await expect(activeItem).toHaveAttribute('aria-current', 'true')
  await menu.getByRole('button', { name: new RegExp(firstName) }).click()

  await expect(page.getByTestId('organization-switcher')).toContainText(
    firstName
  )
  await expect(page).toHaveURL(new RegExp(`/o/${firstOrganizationId}/projects`))
})

/**
 * Code review, must-fix 1 — the test above only ever reaches
 * `/choose-organization` through client-side `pushState`
 * (`resolveHomeRoute`'s own `navigate`), which proves nothing about the
 * address a real bookmark or a hard reload would hit: `vite.config.ts`'s
 * own `server.proxy`/`preview.proxy` — the identical shape
 * `docs/DEPLOY_DROPLET.md`'s own nginx block reproduces in production —
 * matches a proxy context with a bare `url.startsWith(context)`, so
 * `/organizations` (this address's own first choice, before this review)
 * would have been silently forwarded to `apps/api`, which answers nothing
 * there, rather than ever reaching this app's own router. A genuine
 * `page.goto` — not a reload of a page this browser already has open, and
 * not a click that would only ever exercise client-side navigation — is
 * what actually drives the Playwright harness's own `vite preview` process
 * through its proxy the same way a real browser's address bar would.
 */
test('the arrival list’s own address is reachable by a direct page load, not only client-side navigation (code review, must-fix 1)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web55-direct-${suffix}@example.edu`
  const firstOrganizationId = randomUUID()
  const secondOrganizationId = randomUUID()

  const seedDb = openDatabase(E2E_DATABASE_PATH)
  try {
    organizations.createOrganization(
      firstOrganizationId,
      { name: `Direct First — ${suffix}`, isPersonal: false },
      seedDb
    )
    organizations.createOrganization(
      secondOrganizationId,
      { name: `Direct Second — ${suffix}`, isPersonal: false },
      seedDb
    )
    const account = accounts.createAccount(
      firstOrganizationId,
      { email, displayName: 'Instructor', role: 'owner' },
      seedDb
    )
    memberships.createMembership(
      secondOrganizationId,
      account.id,
      'assistant',
      seedDb
    )
  } finally {
    closeDatabase(seedDb)
  }

  // Signs in first (cookie-based session), the same real round trip every
  // other spec in this suite establishes — waited out fully (the switcher
  // actually on screen) before the `page.goto` below, or that fresh
  // navigation would race the still-in-flight `POST /auth/redeem` and fire
  // before the session cookie it sets ever lands, an artefact of this test's
  // own setup, not the address under test. Then a *fresh* navigation —
  // `page.goto`, not the browser's own back/forward or a client-side
  // `navigate` — proves the address itself resolves. Fails, 404-shaped, at
  // the proxy before this fix (`OrganizationsRoute`'s own doc comment has
  // the collision `/organizations` had).
  await signIn(page, email)
  await expect(page.getByTestId('organizations-page')).toBeVisible()
  await page.goto('/choose-organization')

  await expect(
    page.getByRole('heading', { name: 'Choose an organization' })
  ).toBeVisible()
  await expect(page.getByTestId('organizations-page')).toBeVisible()
})
