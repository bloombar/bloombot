/**
 * ENRL-5, end to end: an owner grants a second account — already a member
 * of their own organization — the instructor role from the Team panel, and
 * sees the roster update in place: role, who granted it, and when.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `course-people-panel.spec.ts`'s own module comment holds itself to):
 *
 *  - Real: the browser (`components/Team.tsx`), a real `apps/api`
 *    (`routes/actions.ts`, unmodified), a real throwaway SQLite database,
 *    and the whole round trip: `memberships.list` and `memberships.grant`
 *    both dispatched exactly the way any other caller reaches them.
 *  - Not real: the second account's own sign-in — it is seeded directly
 *    through `@bloombot/db`'s own `accounts.createAccount`, the same
 *    "already a member of this organization" precondition
 *    `grantMembershipAction`'s own rework-finding-1 comment requires
 *    (`packages/actions/src/actions/memberships.ts`). Inviting a genuinely
 *    new person into an organization for the first time is a distinct,
 *    not-yet-built feature that action's own doc comment names — this spec
 *    proves the grant *this* platform actually offers today: changing the
 *    role of somebody already known to belong to this tenant.
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

test('an owner grants the instructor role to a second account from the Team panel, and sees it listed (ENRL-5)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const ownerEmail = `owner-${suffix}@example.edu`
  const secondEmail = `second-${suffix}@example.edu`
  const secondDisplayName = `Second Person ${suffix}`

  // 1. Sign in as the owner — the same panel-only path every other spec in
  //    this suite establishes.
  await page.goto('/')
  await page.getByLabel('Email').fill(ownerEmail)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(ownerEmail)
  const ownerToken = await readSignInToken(ownerEmail)
  await page.goto(`/sign-in/${ownerToken}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // 2. Seed a second account, an assistant, directly into the owner's own
  //    organization — this spec's own module comment has why this, not a
  //    real second sign-in, is what stands in for "already a member".
  let organizationId: string
  let ownerDisplayName: string
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const ownerAccount = accounts.getAccountByEmail(ownerEmail, db)
    if (!ownerAccount) throw new Error('setup failed: owner account not found')
    ownerDisplayName = ownerAccount.displayName
    const [ownerMembership] = memberships.listMembershipsForAccount(
      ownerAccount.id,
      db
    )
    if (!ownerMembership) throw new Error('setup failed: membership not found')
    organizationId = ownerMembership.organizationId

    accounts.createAccount(
      organizationId,
      { email: secondEmail, displayName: secondDisplayName, role: 'assistant' },
      db
    )
  } finally {
    closeDatabase(db)
  }

  // 3. The Team panel lists both — neither shows a grantor: the owner's own
  //    founding row, and this seeded row, both write no `grantedByAccountId`
  //    (`schema.ts`'s own comment on the column).
  await navigateTo(page, 'Team')
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible()
  await expect(page.getByText(`${ownerDisplayName} — Owner`)).toBeVisible()
  await expect(page.getByText(`${secondDisplayName} — Assistant`)).toBeVisible()
  await expect(page.getByText('Granted by', { exact: false })).toHaveCount(0)

  // 4. Grant the second account the instructor role — the consequence
  //    confirmed before anything is sent (ENRL-5's own "make the
  //    consequence legible at the moment of granting").
  // `exact: true` — ENRL-10's own `MembershipInvitations.tsx`, mounted
  // below this same form, has its own "Invite email" field, and
  // `getByLabel`'s default matching is case-insensitive substring, not just
  // form-control labels, so a plain `getByLabel('Email')` now resolves to
  // both.
  await page.getByLabel('Email', { exact: true }).fill(secondEmail)
  // `exact: true` — the surrounding sections' own `aria-label`s ("Who holds
  // a role", "Grant a role") both contain the substring "Role" too, and
  // ENRL-10's own "Invite role" field (the identical reason as "Email",
  // just above) — `getByLabel`'s default matching is case-insensitive
  // substring, not just form-control labels.
  await page.getByLabel('Role', { exact: true }).selectOption('instructor')
  await page.getByRole('button', { name: 'Grant role' }).click()
  const dialog = page.getByRole('dialog', {
    name: `Grant ${secondEmail} the Instructor role?`,
  })
  await expect(dialog).toContainText(
    'can read every course transcript and chat history'
  )
  await dialog.getByRole('button', { name: 'Grant role' }).click()

  // 5. The row updates in place: now Instructor, granted by the owner,
  //    timestamped — never re-typed from the confirmation, read back from
  //    the server's own response.
  await expect(
    page.getByText(`${secondDisplayName} — Instructor`)
  ).toBeVisible()
  await expect(page.getByText(`Granted by ${ownerDisplayName}`)).toBeVisible()

  // 6. Read back directly — the grant really wrote what the panel shows,
  //    the same "read back directly" step `course-people-panel.spec.ts`
  //    takes for its own ENRL-9 proof.
  const dbAfter = openDatabase(E2E_DATABASE_PATH)
  try {
    const ownerAccount = accounts.getAccountByEmail(ownerEmail, dbAfter)
    if (!ownerAccount) throw new Error('verify failed: owner account not found')
    const secondAccount = accounts.getAccountByEmail(secondEmail, dbAfter)
    if (!secondAccount) {
      throw new Error('verify failed: second account not found')
    }

    const membership = memberships.getMembership(
      organizationId,
      secondAccount.id,
      dbAfter
    )
    expect(membership).toMatchObject({
      role: 'instructor',
      grantedByAccountId: ownerAccount.id,
      grantedAt: expect.any(Number),
    })
  } finally {
    closeDatabase(dbAfter)
  }
})
