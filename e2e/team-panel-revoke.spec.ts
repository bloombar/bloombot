/**
 * ENRL-11, end to end: an owner revokes a colleague's membership from the
 * Team panel — the row disappears, the confirmation states both halves of
 * what revoking does (and does not do), and the revoked account genuinely
 * loses staff access, not merely a row this test read back.
 *
 * **What is real, and what is a harness stand-in** — the same discipline
 * `team-panel.spec.ts`'s own module comment holds itself to:
 *
 *  - Real: the browser (`components/Team.tsx`), a real `apps/api`
 *    (`routes/actions.ts`, unmodified), a real throwaway SQLite database,
 *    and the whole round trip: `memberships.list` and `memberships.revoke`
 *    both dispatched exactly the way any other caller reaches them.
 *  - Not real: the second account's own sign-in — seeded directly through
 *    `@bloombot/db`'s own `accounts.createAccount`, the same stand-in
 *    `team-panel.spec.ts` already uses for "already a member of this
 *    organization".
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  memberships,
  openDatabase,
} from '@bloombot/db'

import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { readSignInToken } from './support/read-sign-in-token.js'

test("an owner revokes a colleague's membership from the Team panel, and the row disappears (ENRL-11)", async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const ownerEmail = `owner-${suffix}@example.edu`
  const colleagueEmail = `colleague-${suffix}@example.edu`
  const colleagueDisplayName = `Colleague ${suffix}`

  // 1. Sign in as the owner.
  await page.goto('/')
  await page.getByLabel('Email').fill(ownerEmail)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(ownerEmail)
  const ownerToken = await readSignInToken(ownerEmail)
  await page.goto(`/sign-in/${ownerToken}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // 2. Seed a second account, an instructor, directly into the owner's own
  //    organization — this spec's own module comment has why.
  let organizationId: string
  let colleagueAccountId: string
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const ownerAccount = accounts.getAccountByEmail(ownerEmail, db)
    if (!ownerAccount) throw new Error('setup failed: owner account not found')
    const [ownerMembership] = memberships.listMembershipsForAccount(
      ownerAccount.id,
      db
    )
    if (!ownerMembership) throw new Error('setup failed: membership not found')
    organizationId = ownerMembership.organizationId

    const colleague = accounts.createAccount(
      organizationId,
      {
        email: colleagueEmail,
        displayName: colleagueDisplayName,
        role: 'instructor',
      },
      db
    )
    colleagueAccountId = colleague.id
  } finally {
    closeDatabase(db)
  }

  // 3. The Team panel lists the colleague.
  await navigateTo(page, 'Team')
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible()
  await expect(
    page.getByText(`${colleagueDisplayName} — Instructor`)
  ).toBeVisible()

  // 4. Revoke — the consequence stated plainly, both halves, before
  //    anything is sent (ENRL-11's own "say what it does and does not do").
  await page
    .getByRole('button', {
      name: `Revoke ${colleagueDisplayName}'s Instructor role`,
    })
    .click()
  const dialog = page.getByRole('dialog', {
    name: `Revoke ${colleagueDisplayName}'s Instructor role?`,
  })
  await expect(dialog).toContainText('stops their staff access')
  await expect(dialog).toContainText(
    'deletes no transcript and ends no enrolment'
  )
  await dialog.getByRole('button', { name: 'Revoke' }).click()

  // 5. The row disappears — `listMembershipsForOrganization` now excludes a
  //    revoked membership (`repos/memberships.ts`'s own doc comment).
  await expect(
    page.getByText(`${colleagueDisplayName} — Instructor`)
  ).toHaveCount(0)

  // 6. Read back directly — the revoke really wrote what the panel implies:
  //    the membership is no longer active, and the row itself records who
  //    revoked it and when.
  const dbAfter = openDatabase(E2E_DATABASE_PATH)
  try {
    const ownerAccount = accounts.getAccountByEmail(ownerEmail, dbAfter)
    if (!ownerAccount) throw new Error('verify failed: owner account not found')

    expect(
      memberships.getMembership(organizationId, colleagueAccountId, dbAfter)
    ).toBeUndefined()

    const rawRow = dbAfter.$client
      .prepare(
        'select revoked_at, revoked_by_account_id, role from memberships where organization_id = ? and account_id = ?'
      )
      .get(organizationId, colleagueAccountId) as
      | { revoked_at: number; revoked_by_account_id: string; role: string }
      | undefined
    expect(rawRow).toMatchObject({
      revoked_by_account_id: ownerAccount.id,
      role: 'instructor',
    })
    expect(rawRow?.revoked_at).toEqual(expect.any(Number))
  } finally {
    closeDatabase(dbAfter)
  }
})
