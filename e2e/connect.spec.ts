/**
 * LINK-6/8, end to end: the connect screen (`/connect/:organizationId`)
 * through a real browser, and an MCP-issued token redeemed through the
 * real `apps/api` connect routes underneath it.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `chat.spec.ts`/`course-configuration.spec.ts` already hold themselves
 * to):
 *
 *  - Real: the browser (`pages/Connect.tsx`, `pages/SignIn.tsx`,
 *    `pages/RedeemLink.tsx`), a real `apps/api`
 *    (`routes/person-link.ts`'s own `/mcp/preview`/`/mcp/confirm`,
 *    unmodified), a real throwaway SQLite database, and the whole sign-in
 *    round trip (an emailed link, actually redeemed).
 *  - **Not real**: Discord itself — this spec proves the MCP half of
 *    LINK-8 front-to-back, not the Discord OAuth half of LINK-7, because
 *    driving a real browser through Discord's own consent screen would
 *    need a second, fake OAuth provider standing in for discord.com, which
 *    this harness does not build (`e2e/support/start-api.ts` already
 *    points `apps/api`'s own Discord config at unreachable loopback
 *    addresses on purpose). `apps/api/tests/routes/person-link.test.ts`'s
 *    own acceptance test covers that path instead, over real HTTP against
 *    a real (in-process) database — genuinely end to end for the server
 *    half, just not through a browser.
 *  - **The MCP token itself is minted directly against the e2e database**,
 *    not through a live `apps/mcp` server and a real MCP client — the same
 *    "prove the mechanism, not the transport" split
 *    `apps/mcp/tests/server.test.ts`'s own `bloombot_connectAssistant`
 *    tests already draw between the MCP protocol itself (tested there,
 *    with a real SDK client) and what a token, once minted, actually does
 *    once redeemed (tested here, through the real browser and API).
 *  - **The account is seeded with an existing connected person in the
 *    target organization before this spec ever touches the browser** —
 *    D-44's own rework, round two: an MCP connect resolves the survivor
 *    read-only now (`people.resolveIdentity`), so an account with no
 *    existing person in an organization has nothing for a fresh MCP
 *    identity to attach to. This mirrors the real shape LINK-8 actually
 *    describes — a student who already reached a course (a prior Discord
 *    connect, most often) connecting an *additional* identity, an
 *    assistant, on top of it — not a first-ever connect, which is
 *    LINK-7's own job. `docs/DECISIONS.md` D-44's own corrected framing
 *    has the fuller account of what the panel does and does not yet
 *    expose for an account connected this way (LINK-10, tracked
 *    separately).
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import { issueMcpPersonLinkToken } from '@bloombot/auth'
import {
  accounts,
  closeDatabase,
  memberships,
  openDatabase,
  organizations,
  people,
} from '@bloombot/db'

import { E2E_DATABASE_PATH } from './support/env.js'
import { requestSignInLink } from './support/sign-in.js'

test('the connect screen asks a signed-out visitor to sign in, then redeems an MCP-issued token through the real API (LINK-6/8)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `connect-${suffix}@example.edu`
  const institutionOrganizationId = randomUUID()

  // 1. An institution's own organization — seeded directly, standing in
  //    for one a real Discord install already bound (this spec's own
  //    module comment on why this is not seeded through the panel).
  const seedDb = openDatabase(E2E_DATABASE_PATH)
  try {
    organizations.createOrganization(
      institutionOrganizationId,
      { name: `Institution ${suffix}`, isPersonal: false },
      seedDb
    )
  } finally {
    closeDatabase(seedDb)
  }

  // 2. Follow the LINK-1 invitation's own address, signed out — the exact
  //    shape `packages/discord/src/handle-mention.ts#connectInvitationText`
  //    now publishes into a course channel.
  await page.goto(`/connect/${institutionOrganizationId}`)
  await expect(
    page.getByRole('heading', { name: 'Sign in to Bloombot' })
  ).toBeVisible()

  const token = await requestSignInLink(page, email)

  // 3. Redeeming the link returns the browser to this same organization's
  //    own connect screen — not the ordinary shell. AUTH-6 rework: the
  //    destination is carried on the sign-in token itself now
  //    (`pages/SignIn.tsx`'s own `destination` prop, set here by
  //    `pages/Connect.tsx`), not a `sessionStorage` marker — regression
  //    coverage for "Connect.tsx's own return trip still works after the
  //    mechanism change," since this spec's own round trip stays in one tab
  //    either way and cannot itself distinguish the two mechanisms;
  //    `e2e/join-link.spec.ts`'s own cross-tab test is what actually proves
  //    the difference.
  await page.goto(`/sign-in/${token}`)
  await expect(
    page.getByRole('heading', { name: 'Connect your account' })
  ).toBeVisible()
  await expect(page).toHaveURL(
    new RegExp(`/connect/${institutionOrganizationId}$`)
  )
  await expect(page.getByText(email)).toBeVisible()

  // 4. Seed the one precondition an MCP connect actually needs (this
  //    spec's own module comment): the account already has a connected
  //    person in this organization, and a real, freshly-minted MCP token
  //    naming it.
  const db = openDatabase(E2E_DATABASE_PATH)
  let mintedToken: string
  try {
    const account = accounts.getAccountByEmail(email, db)
    if (!account) throw new Error('setup failed: account not found')
    const [personalMembership] = memberships.listMembershipsForAccount(
      account.id,
      db
    )
    if (!personalMembership) {
      throw new Error('setup failed: personal membership not found')
    }

    const survivor = people.createPerson(institutionOrganizationId, {}, db)
    const connected = people.connectIdentity(
      institutionOrganizationId,
      survivor.id,
      { surface: 'web', externalId: account.id },
      db
    )
    if (!connected) throw new Error('setup failed: connectIdentity refused')

    const issued = issueMcpPersonLinkToken(
      institutionOrganizationId,
      account.id,
      db
    )
    mintedToken = issued.token
  } finally {
    closeDatabase(db)
  }

  // 5. The browser's own part: paste the token, preview (LINK-6's own "a
  //    visit is not consent" — nothing is bound until this is confirmed),
  //    then confirm.
  await page.reload()
  await page.getByLabel('Assistant token').fill(mintedToken)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(
    page.getByText(
      'This identity has not been connected to anyone yet — connecting will attach it to your account.'
    )
  ).toBeVisible()
  await page.getByRole('button', { name: 'Confirm connecting' }).click()
  await expect(page.getByText('Your assistant is connected.')).toBeVisible()

  // 6. The identity is genuinely bound — read back directly (the panel has
  //    no screen for this yet), the same "assert through the database when
  //    the UI does not expose a read" convention `chat.spec.ts` already
  //    uses.
  const verifyDb = openDatabase(E2E_DATABASE_PATH)
  try {
    const account = accounts.getAccountByEmail(email, verifyDb)
    if (!account) throw new Error('verify failed: account not found')
    const mcpIdentity = people.resolveIdentity(
      institutionOrganizationId,
      { surface: 'mcp', externalId: account.id },
      verifyDb
    )
    expect(mcpIdentity).toBeDefined()
    expect(mcpIdentity?.connectedAt).not.toBeNull()
  } finally {
    closeDatabase(verifyDb)
  }
})

/**
 * LINK-7 (polish slice): the durable connect status. Before this slice,
 * `Connect.tsx` always rendered the "Connect Discord" button, even on a
 * return visit after a real connect had already completed — nothing on the
 * server was ever asked. `GET .../person-link/status` is what fixes that,
 * and this spec proves it the way `e2e/join-link.spec.ts`'s own cross-tab
 * test proves durability generally: a *fresh* page load, not the one-time
 * navigation `App.tsx#onConnected` already makes right after confirming.
 *
 * The Discord identity itself is seeded directly against the database
 * (`people.connectIdentity`), not driven through a real OAuth round trip —
 * this file's own module comment already explains why a real browser
 * cannot reach Discord's own consent screen in this harness; the sequence
 * reproduced here (a survivor with a `discord` identity, then the
 * account's own `web` identity attached to it) is exactly what
 * `routes/person-link.ts#attachWebIdentityOrMerge` performs once a genuine
 * `/discord/confirm` succeeds.
 */
test('a completed Discord connect shows the connected status on a later visit, not the button (LINK-7)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `connect-discord-${suffix}@example.edu`
  const institutionOrganizationId = randomUUID()

  const seedDb = openDatabase(E2E_DATABASE_PATH)
  try {
    organizations.createOrganization(
      institutionOrganizationId,
      { name: `Institution ${suffix}`, isPersonal: false },
      seedDb
    )
  } finally {
    closeDatabase(seedDb)
  }

  await page.goto(`/connect/${institutionOrganizationId}`)
  const token = await requestSignInLink(page, email)
  await page.goto(`/sign-in/${token}`)
  await expect(
    page.getByRole('heading', { name: 'Connect your account' })
  ).toBeVisible()
  // Before the Discord identity below exists, the ordinary button.
  await expect(
    page.getByRole('button', { name: 'Connect Discord' })
  ).toBeVisible()

  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const account = accounts.getAccountByEmail(email, db)
    if (!account) throw new Error('setup failed: account not found')
    const survivor = people.createPerson(institutionOrganizationId, {}, db)
    const discordConnected = people.connectIdentity(
      institutionOrganizationId,
      survivor.id,
      { surface: 'discord', externalId: `snowflake-${suffix}` },
      db
    )
    if (!discordConnected) {
      throw new Error('setup failed: connectIdentity refused (discord)')
    }
    const webConnected = people.connectIdentity(
      institutionOrganizationId,
      survivor.id,
      { surface: 'web', externalId: account.id },
      db
    )
    if (!webConnected) {
      throw new Error('setup failed: connectIdentity refused (web)')
    }
  } finally {
    closeDatabase(db)
  }

  // A later, unrelated visit to the same URL — not the one-time navigation
  // `App.tsx` makes right after OAuth — still shows "connected": LINK-7's
  // own durability requirement, answered by the server rather than a
  // transient flag.
  await page.reload()
  await expect(page.getByText(/Discord connected/)).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Connect Discord' })
  ).toHaveCount(0)
})
