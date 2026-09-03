/**
 * ENRL-10, end to end: an owner invites a colleague who is not yet in the
 * organization, from the Team panel, copies the link, and a real second
 * account — with no prior membership anywhere in this organization — redeems
 * it, signing in along the way, and the granted role appears on the team
 * screen.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `join-links-panel.spec.ts`/`team-panel.spec.ts` both hold themselves to):
 *
 *  - Real: the browser (`components/Team.tsx`, `components/MembershipInvitations.tsx`,
 *    `pages/Invitation.tsx`, `pages/Shell.tsx`), a real `apps/api`
 *    (`routes/actions.ts`, `routes/membership-invitations.ts`, unmodified),
 *    a real throwaway SQLite database, and the whole round trip:
 *    `membershipInvitations.create`/`.list` dispatched exactly the way any
 *    other caller reaches them, and the created invitation actually
 *    redeemed through the unmodified `/invitations/:secret` flow.
 *  - Not real: the model (unreached — nothing here asks a course a
 *    question).
 *
 * Unlike `team-panel.spec.ts` (ENRL-5's own grant, which requires the
 * target to already hold a membership — that spec's own module comment
 * names this), the colleague here starts with *no* relationship to the
 * owner's organization at all: this is the surface that closes the gap
 * ENRL-10 exists for.
 */

import { createHash, randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  membershipInvitations,
  memberships,
  openDatabase,
  organizations,
} from '@bloombot/db'

import { E2E_DATABASE_PATH, E2E_PUBLIC_APP_URL } from './support/env.js'
import { readSignInToken } from './support/read-sign-in-token.js'

test('an owner invites a colleague with no prior membership; a real second account redeems it and the role appears on the team screen (ENRL-10)', async ({
  page,
  browser,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const ownerEmail = `owner-${suffix}@example.edu`
  const colleagueEmail = `colleague-${suffix}@example.edu`

  // Playwright's own clipboard API needs the origin's permission granted
  // explicitly — the same `join-links-panel.spec.ts`'s own device.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: E2E_PUBLIC_APP_URL,
  })

  // 1. Sign in as the owner — the same panel-only path every other spec in
  //    this suite establishes.
  await page.goto('/')
  await page.getByLabel('Email').fill(ownerEmail)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(ownerEmail)
  const ownerToken = await readSignInToken(ownerEmail)
  await page.goto(`/sign-in/${ownerToken}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  let organizationId: string
  let institutionName: string
  const seedDb = openDatabase(E2E_DATABASE_PATH)
  try {
    const ownerAccount = accounts.getAccountByEmail(ownerEmail, seedDb)
    if (!ownerAccount) throw new Error('setup failed: owner account not found')
    const [ownerMembership] = memberships.listMembershipsForAccount(
      ownerAccount.id,
      seedDb
    )
    if (!ownerMembership) throw new Error('setup failed: membership not found')
    organizationId = ownerMembership.organizationId
    const organization = organizations.getOrganizationById(
      organizationId,
      seedDb
    )
    if (!organization) throw new Error('setup failed: organization not found')
    institutionName = organization.name
  } finally {
    closeDatabase(seedDb)
  }

  // 2. ENRL-10: invite a colleague who has never touched this organization
  //    — the Invitations section, mounted alongside the Grant form.
  await page.getByRole('button', { name: 'Team' }).click()
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Invitations' })).toBeVisible()
  await expect(page.getByText('No invitations issued yet.')).toBeVisible()

  await page.getByLabel('Invite email').fill(colleagueEmail)
  await page.getByLabel('Invite role').selectOption('instructor')
  await page.getByRole('button', { name: 'Invite' }).click()
  const dialog = page.getByRole('dialog', {
    name: `Invite ${colleagueEmail} to the Instructor role?`,
  })
  await expect(dialog).toContainText(
    'can read every course transcript and chat history'
  )
  await dialog.getByRole('button', { name: 'Send invitation' }).click()

  const urlNode = page.getByTestId('created-invitation-url')
  await expect(urlNode).toBeVisible()
  const invitationUrl = (await urlNode.textContent())?.trim()
  if (!invitationUrl)
    throw new Error('the panel never rendered the created URL')
  expect(invitationUrl).toContain('/invitations/')

  await page.getByRole('button', { name: 'Copy link' }).click()
  await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible()
  // The same "copy actually reaches the clipboard with exactly the URL
  // displayed" proof `join-links-panel.spec.ts` already gives WEB-20.
  const clipboardText = await page.evaluate(() =>
    (
      navigator as unknown as { clipboard: { readText(): Promise<string> } }
    ).clipboard.readText()
  )
  expect(clipboardText).toBe(invitationUrl)

  // 3. A real, independent colleague follows the copied URL — a fresh
  //    browser context, since sign-in is cookie-based and this account has
  //    never signed in before at all.
  const colleagueContext = await browser.newContext()
  try {
    const colleaguePage = await colleagueContext.newPage()
    await colleaguePage.goto(invitationUrl)
    await expect(
      colleaguePage.getByRole('heading', { name: 'Sign in to Bloombot' })
    ).toBeVisible()
    await colleaguePage.getByLabel('Email').fill(colleagueEmail)
    await colleaguePage
      .getByRole('button', { name: 'Email me a sign-in link' })
      .click()
    await expect(colleaguePage.getByTestId('link-requested')).toContainText(
      colleagueEmail
    )
    const colleagueToken = await readSignInToken(colleagueEmail)
    // Redeeming the sign-in link returns the browser to this same
    // invitation (`App.tsx`'s own `PENDING_INVITATION_KEY` handling,
    // `pages/Invitation.tsx`) — which redeems automatically and lands on
    // the ordinary shell once it succeeds.
    await colleaguePage.goto(`/sign-in/${colleagueToken}`)
    await expect(
      colleaguePage.getByTestId('organization-switcher')
    ).toBeVisible()

    // A brand-new account starts with only its own personal organization —
    // redeeming the invitation gave it a *second* membership, so the
    // switcher now offers a real choice (`OrganizationSwitcher.tsx`'s own
    // "a single option is the common case" branch, no longer taken).
    await colleaguePage
      .getByRole('combobox', { name: 'Organization' })
      .selectOption({ label: `${institutionName} (instructor)` })
    await expect(
      colleaguePage.getByRole('button', { name: 'Team' })
    ).toBeVisible()
  } finally {
    await colleagueContext.close()
  }

  // 4. Back in the owner's own panel: a real reload, then back to Team —
  //    the invitation now reads as redeemed, and the granted role appears
  //    in the roster above without the owner ever having typed the
  //    colleague's email into the Grant form (which still could not have
  //    reached this account before the invitation existed —
  //    `memberships.grant`'s own "already a member" requirement,
  //    `team-panel.spec.ts`'s own module comment).
  await page.reload()
  await page.getByRole('button', { name: 'Team' }).click()
  await expect(page.getByText(`${colleagueEmail} — Instructor`)).toBeVisible()
  await expect(page.getByText(/^Redeemed /)).toBeVisible()
  await expect(
    page.getByRole('button', { name: /^Revoke invitation/ })
  ).not.toBeVisible()

  // 5. Read back directly — the invitation really granted what the panel
  //    shows, and the grantor recorded is the inviting owner, never the
  //    colleague who redeemed it (ENRL-5's own "recorded" requirement).
  const verifyDb = openDatabase(E2E_DATABASE_PATH)
  try {
    const ownerAccount = accounts.getAccountByEmail(ownerEmail, verifyDb)
    if (!ownerAccount) throw new Error('verify failed: owner account not found')
    const colleagueAccount = accounts.getAccountByEmail(
      colleagueEmail,
      verifyDb
    )
    if (!colleagueAccount) {
      throw new Error('verify failed: colleague account not found')
    }

    const membership = memberships.getMembership(
      organizationId,
      colleagueAccount.id,
      verifyDb
    )
    expect(membership).toMatchObject({
      role: 'instructor',
      grantedByAccountId: ownerAccount.id,
      grantedAt: expect.any(Number),
    })
  } finally {
    closeDatabase(verifyDb)
  }
})

/** The same hash `@bloombot/actions`' own (module-private) `hashSecret` computes — `e2e/join-link.spec.ts`'s own identical device, and the same reason `apps/api/tests/routes/join-links.test.ts`'s own module comment gives for why this file cannot import that function directly. */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/**
 * Seeds an organization, an owner, and a live invitation for
 * `colleagueEmail` — directly against the e2e database, the same
 * `seedJoinLink` device `join-link.spec.ts` uses for its own cross-tab case,
 * standing in for the panel round trip the test above already exercises in
 * full (WEB-20's own "issued through the panel" is proven there; this test
 * is about what happens after a link exists, not how one is issued).
 */
function seedInvitation(
  suffix: string,
  colleagueEmail: string
): { organizationId: string; institutionName: string; secret: string } {
  const organizationId = randomUUID()
  const institutionName = `Institution ${suffix}`
  const secret = `secret-${suffix}`

  const seedDb = openDatabase(E2E_DATABASE_PATH)
  try {
    organizations.createOrganization(
      organizationId,
      { name: institutionName, isPersonal: false },
      seedDb
    )
    const owner = accounts.createAccount(
      organizationId,
      {
        email: `owner-${suffix}@example.edu`,
        displayName: 'Owner',
        role: 'owner',
      },
      seedDb
    )
    membershipInvitations.createInvitation(
      organizationId,
      {
        email: colleagueEmail,
        role: 'instructor',
        secretHash: hashSecret(secret),
        createdByAccountId: owner.id,
      },
      seedDb
    )
  } finally {
    closeDatabase(seedDb)
  }

  return { organizationId, institutionName, secret }
}

// AUTH-6 — the same rework `join-link.spec.ts`'s own identical test proves
// for a course join link, here for a membership invitation: a sign-in
// completing in a *different* browsing context than the one that requested
// it must still land the colleague with their granted membership, which the
// old `PENDING_INVITATION_KEY` `sessionStorage` marker could not survive
// (`join-link.spec.ts`'s own module comment has why a second `Page` in the
// same `BrowserContext` is the right stand-in for that — shared cookies,
// isolated `sessionStorage`, exactly a mail client's own "open in a new
// tab"). Fails without the fix: the redeemed session would land on the
// ordinary, empty shell in the second tab, with no second organization on
// the switcher at all.
test('a sign-in that completes in a different browsing context than the one that requested it still lands the colleague with their membership (AUTH-6)', async ({
  page,
  context,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const colleagueEmail = `crosstab-colleague-${suffix}@example.edu`
  const { institutionName, secret } = seedInvitation(suffix, colleagueEmail)

  // Tab A: follow the invitation link, signed out, and request a sign-in
  // link — exactly as far as a visitor gets before switching to their mail
  // client.
  await page.goto(`/invitations/${secret}`)
  await page.getByLabel('Email').fill(colleagueEmail)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(colleagueEmail)
  const token = await readSignInToken(colleagueEmail)

  // Tab B: a genuinely different browsing context — a fresh `Page` in the
  // same `BrowserContext`, sharing cookies (irrelevant here: neither tab has
  // a session yet) but not `sessionStorage`, the same isolation a mail
  // client's own "open in a new tab" gives a real visitor. This is the tab
  // that actually opens the emailed link.
  const otherTab = await context.newPage()
  await otherTab.goto(`/sign-in/${token}`)

  // Redeemed in tab B, and tab B lands with the granted membership visible
  // on the switcher — carried entirely on the token the server issued,
  // never on anything tab A's own `sessionStorage` wrote (tab B never
  // touched it).
  await expect(otherTab.getByTestId('organization-switcher')).toBeVisible()
  await otherTab
    .getByRole('combobox', { name: 'Organization' })
    .selectOption({ label: `${institutionName} (instructor)` })
  await expect(otherTab.getByRole('button', { name: 'Team' })).toBeVisible()

  await otherTab.close()
})
