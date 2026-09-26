/**
 * WEB-72/DATA-7, end to end: an owner deletes their own organization from
 * the bottom of the organization settings screen's own General tab
 * (WEB-69 moved the Danger zone out of the Team panel — rework round 1
 * gave it its own tab, and the user's own final decision put it at the
 * bottom of General instead, alongside the organization's own name — this
 * spec follows that move, unchanged otherwise), confirmed by typing its
 * name — and lands somewhere real afterward, never back on the
 * organization they just deleted (the must-fix review finding this spec
 * exists to catch: a fresh sign-up's own personal organization is this
 * account's only one, so deleting it has to move the caller to `/account`,
 * not loop them into `/o/<deletedOrgId>/projects`, a screen every scoped
 * read now 404s on).
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
import { navigateToOrganizationSettingsTab } from './support/navigate.js'
import { signIn } from './support/sign-in.js'

test('an owner deletes their only organization from the bottom of the General tab, confirmed by typing its name, and lands on /account — never back on the deleted organization (WEB-72)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web72-org-${suffix}@example.edu`

  // A fresh sign-up's own personal organization (TEN-1) makes this account
  // its owner — the same account WEB-72's own Danger zone requires, and
  // the only organization it belongs to, which is exactly what the bug
  // this spec proves needed.
  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // Read the organization's own id and name back from the database — the
  // must-fix assertion below needs the real id, not scraped from the
  // switcher (whose own text also carries a trailing role label, "Name
  // (owner)", not the bare name the typed-name gate itself requires), to
  // prove the browser's address never returns to it.
  const db = openDatabase(E2E_DATABASE_PATH)
  let organizationId: string
  let organizationName: string
  try {
    const account = accounts.getAccountByEmail(email, db)
    if (!account) throw new Error('setup failed: account not found')
    const [membership] = memberships.listMembershipsForAccount(account.id, db)
    if (!membership) throw new Error('setup failed: membership not found')
    organizationId = membership.organizationId
    const organization = organizations.getOrganizationById(organizationId, db)
    if (!organization) throw new Error('setup failed: organization not found')
    organizationName = organization.name
  } finally {
    closeDatabase(db)
  }

  await navigateToOrganizationSettingsTab(page, 'General')
  await expect(page.getByTestId('danger-zone-panel')).toBeVisible()
  await expect(page).toHaveURL(
    new RegExp(`/o/${organizationId}/settings/general`)
  )

  const dangerZone = page.getByRole('region', { name: 'Danger zone' })
  await dangerZone.scrollIntoViewIfNeeded()
  await dangerZone.getByRole('button', { name: 'Delete organization' }).click()

  const dialog = page.getByRole('dialog')
  const confirmButton = dialog.getByRole('button', {
    name: 'Delete organization',
  })
  await expect(confirmButton).toBeDisabled()
  // WEB-50's own typed-name discipline.
  await dialog.getByLabel('Organization name').fill('the wrong name')
  await expect(confirmButton).toBeDisabled()
  await dialog.getByLabel('Organization name').fill(organizationName)
  await expect(confirmButton).toBeEnabled()
  await confirmButton.click()

  // The must-fix this spec is named for: the caller lands on their own
  // account screen — never back on the organization's own id, whether in
  // the address bar (the reported "loops back into
  // /o/<deletedOrgId>/projects" defect) or the switcher (which used to
  // fall back to the raw, now-meaningless organization id once
  // `GET /auth/me` still reported the deleted organization).
  await expect(page).toHaveURL(/\/account$/)
  await expect(page.url()).not.toContain(organizationId)
  await expect(page.getByTestId('account-page')).toBeVisible()

  // A direct visit to the deleted organization's own address, still
  // bookmarked in this browser's own history, is redirected home — this
  // account holds no relationship to it any more (`App.tsx`'s own
  // `isReachableShellRoute` guard) — rather than rendering the dead screen
  // the switcher used to loop the caller into.
  await page.goto(`/o/${organizationId}/projects`)
  await expect(page).toHaveURL(/\/account$/)
  await expect(page.getByTestId('account-page')).toBeVisible()
})
