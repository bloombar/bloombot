/**
 * WEB-69, end to end: the organization settings screen itself — a
 * deep-linked tab survives a reload, an old (pre-WEB-69) address still
 * opens the right tab, the arrow keys move between tabs (General first,
 * Jobs last — rework round 1's own Danger zone tab did not survive to the
 * user's final decision, which put it at the bottom of General instead),
 * and switching tabs (or leaving the screen) while one holds an unsaved
 * edit asks the WEB-38 three-answer question, exactly the way
 * `keyboard.spec.ts` already proves the identical prompt for
 * `pages/CourseEditor.tsx`. A separate test renames the organization from
 * General itself.
 *
 * **What is real, and what is a harness stand-in** (the same discipline
 * `spending-cap.spec.ts`'s own module comment holds itself to):
 *
 *  - Real: the browser (`pages/OrganizationSettings.tsx`), a real
 *    `apps/api` (`routes/actions.ts`, unmodified), a real throwaway SQLite
 *    database.
 *  - Not real: nothing else this spec reaches needs a stand-in — every
 *    write it makes (a spending cap, a rename) is the genuine round trip.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import { navigateToOrganizationSettingsTab } from './support/navigate.js'
import { signIn } from './support/sign-in.js'

test('a deep-linked tab survives a reload, and arrow keys move between tabs (WEB-69)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web69-${suffix}@example.edu`

  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await navigateToOrganizationSettingsTab(page, 'Team')
  await expect(page.getByRole('tab', { name: 'Team' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(page).toHaveURL(/\/o\/[^/]+\/settings\/team$/)

  // A reload keeps the tab the address named, not the first one.
  await page.reload()
  await expect(page.getByRole('tab', { name: 'Team' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible()

  // Arrow Left/Right move the roving tab selection, wrapping around.
  await page.getByRole('tab', { name: 'Team' }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('tab', { name: 'Discord' })).toBeFocused()
  await expect(page.getByRole('tab', { name: 'Discord' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Team' })).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByRole('tab', { name: 'Jobs' })).toBeFocused()
  await expect(page.getByRole('tab', { name: 'Jobs' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.keyboard.press('Home')
  await expect(page.getByRole('tab', { name: 'General' })).toBeFocused()
})

test('an old, pre-WEB-69 address still opens the tab it named, corrected to the canonical one (WEB-69)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web69-legacy-${suffix}@example.edu`

  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  const organizationId = new URL(page.url()).pathname.split('/')[2]
  await page.goto(`/o/${organizationId}/jobs`)

  await expect(page.getByRole('tab', { name: 'Jobs' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible()
  // The address bar is corrected to the canonical form, not left on the
  // retired one.
  await expect(page).toHaveURL(
    new RegExp(`/o/${organizationId}/settings/jobs$`)
  )
})

test('a dirty spending cap asks before switching tabs — save, discard, and stay all behave as specified (WEB-38, WEB-69)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web69-dirty-${suffix}@example.edu`

  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await navigateToOrganizationSettingsTab(page, 'Usage')
  // Wait for the report to actually load before typing — `pages/Usage.tsx`
  // seeds the cap field from it once it resolves, which would otherwise
  // silently overwrite whatever was typed first.
  await expect(page.getByText('No spending cap set')).toBeVisible()
  await page.getByLabel('Spending cap ($)').fill('9.99')

  // Switching tabs while dirty asks; Cancel means stay, and the edit is
  // untouched.
  await page.getByRole('tab', { name: 'Team' }).click()
  const dialog = page.getByRole('dialog', { name: 'Save your changes?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('tab', { name: 'Usage' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(page.getByLabel('Spending cap ($)')).toHaveValue('9.99')

  // Escape means the same as Cancel.
  await page.getByRole('tab', { name: 'Team' }).click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('tab', { name: 'Usage' })).toHaveAttribute(
    'aria-selected',
    'true'
  )

  // Discard changes clears the pending edit and moves to the tab clicked.
  await page.getByRole('tab', { name: 'Team' }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Discard changes' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('tab', { name: 'Team' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.getByRole('tab', { name: 'Usage' }).click()
  await expect(page.getByLabel('Spending cap ($)')).toHaveValue('')

  // Save changes actually sets the cap, and then moves to the tab clicked.
  await page.getByLabel('Spending cap ($)').fill('4.50')
  await page.getByRole('tab', { name: 'Jobs' }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('tab', { name: 'Jobs' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.getByRole('tab', { name: 'Usage' }).click()
  await expect(page.getByText('Cap set at $4.50')).toBeVisible()

  // A clean tab never asks.
  await page.getByRole('tab', { name: 'Discord' }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('tab', { name: 'Discord' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
})

test('renames the organization from the General tab, and the new name appears in the header (WEB-57/WEB-69)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web69-rename-${suffix}@example.edu`

  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // General is the default tab — `navigateToOrganizationSettingsTab` skips
  // its own tab click for exactly that reason (that helper's own doc
  // comment).
  await navigateToOrganizationSettingsTab(page, 'General')

  await page.getByLabel('Organization name').fill('Renamed From General')
  await page.getByRole('button', { name: 'Save' }).click()

  // The header's own switcher — the same real-time proof
  // `organizations-arrival.spec.ts`'s own WEB-57 case already gives the
  // kebab-driven rename on the Account page — shows the new name once
  // `refreshAccount` re-reads `GET /auth/me`.
  await expect(page.getByTestId('organization-switcher')).toContainText(
    'Renamed From General'
  )
})
