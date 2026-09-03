/**
 * COST-3, end to end: an owner sets, then clears, their organization's own
 * spending cap from the panel's Usage screen — and, distinctly, sets it to
 * `0` — proving both the write actually lands in the database, in micros,
 * at the right magnitude, and that a cleared cap and a cap of exactly `0`
 * are never confused with each other.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `join-links-panel.spec.ts`'s own module comment holds itself to):
 *
 *  - Real: the browser (`pages/Usage.tsx`), a real `apps/api`
 *    (`routes/actions.ts`, unmodified), a real throwaway SQLite database,
 *    and the whole round trip — `costLedger.setSpendingCap` dispatched
 *    exactly the way any other caller reaches it.
 *  - Not real: the model (unreached — nothing here asks a course a
 *    question; `usage-panel.spec.ts` is what exercises that side of COST-4).
 *
 * Every assertion of what was actually *stored* reads the database
 * directly, through `@bloombot/db`'s own `organizations.getOrganizationById`
 * — never the panel's own copy, which could read correctly while the write
 * itself silently failed or landed at the wrong magnitude.
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
import { readSignInToken } from './support/read-sign-in-token.js'

test("an owner sets, then clears, their organization's spending cap — and 0 is distinct from cleared (COST-3)", async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const ownerEmail = `cost3-${suffix}@example.edu`

  // 1. Sign in — a fresh account's own personal organization (TEN-1), the
  //    owner of it by definition.
  await page.goto('/')
  await page.getByLabel('Email').fill(ownerEmail)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(ownerEmail)
  const token = await readSignInToken(ownerEmail)
  await page.goto(`/sign-in/${token}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  const organizationId = (): string => {
    const db = openDatabase(E2E_DATABASE_PATH)
    try {
      const account = accounts.getAccountByEmail(ownerEmail, db)
      if (!account) throw new Error('verify failed: account not found')
      const [membership] = memberships.listMembershipsForAccount(account.id, db)
      if (!membership) throw new Error('verify failed: membership not found')
      return membership.organizationId
    } finally {
      closeDatabase(db)
    }
  }
  const readCapMicros = (): number | null => {
    const db = openDatabase(E2E_DATABASE_PATH)
    try {
      const organization = organizations.getOrganizationById(
        organizationId(),
        db
      )
      if (!organization) throw new Error('verify failed: organization gone')
      return organization.spendingCapMicros
    } finally {
      closeDatabase(db)
    }
  }

  // 2. The Usage screen, before any cap is ever set.
  await page.getByRole('button', { name: 'Usage' }).click()
  await expect(
    page.getByRole('heading', { name: 'Usage', exact: true })
  ).toBeVisible()
  await expect(page.getByText('No spending cap set')).toBeVisible()
  expect(readCapMicros()).toBeNull()

  // 3. Set a cap of $5.25 — the panel takes dollars, never micros.
  await page.getByLabel('Spending cap ($)').fill('5.25')
  await page.getByRole('button', { name: 'Save cap' }).click()
  await expect(page.getByText('Cap set at $5.25')).toBeVisible()

  // The stored value, read back directly — not the panel's own copy.
  // Asserts the exact magnitude: $5.25 is 5_250_000 micros, not
  // 5_250_000_000 or 5.25.
  await expect.poll(() => readCapMicros()).toBe(5_250_000)

  // 4. Clear the cap entirely.
  await page.getByRole('button', { name: 'Clear cap' }).click()
  await expect(page.getByText('No spending cap set')).toBeVisible()
  await expect.poll(() => readCapMicros()).toBeNull()

  // 5. Set the cap to exactly $0 — COST-3's own text: distinct from
  //    clearing, and blocks every question. Stored as `0`, not `null`.
  await page.getByLabel('Spending cap ($)').fill('0')
  await page.getByRole('button', { name: 'Save cap' }).click()
  await expect(page.getByText(/^Cap reached/)).toBeVisible()
  await expect.poll(() => readCapMicros()).toBe(0)

  // 6. And clearing again is what turns "cap reached" back into "no cap" —
  //    the two states are not the same read differently.
  await page.getByRole('button', { name: 'Clear cap' }).click()
  await expect(page.getByText('No spending cap set')).toBeVisible()
  await expect(page.getByText(/^Cap reached/)).not.toBeVisible()
  await expect.poll(() => readCapMicros()).toBeNull()
})
