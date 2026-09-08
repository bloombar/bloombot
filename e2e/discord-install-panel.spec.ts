/**
 * TEN-8/WEB-4, end to end: an organization's actual Discord binding — not
 * only what this browser session happened to install — is what the panel
 * shows, and Remove is reachable for it. Before this slice, `Shell.tsx`
 * derived install state purely from `justInstalled`, a signal `App.tsx`
 * only ever sets once, for the browser tab that just completed an OAuth
 * callback — a reload lost it, and a second device never had it, so both
 * offered "Install" for a server that was already bound (this file's own
 * scenario is exactly the audit finding that reopened TEN-8/WEB-4,
 * `docs/ROADMAP.md`'s "Audit — surfaces that were never built").
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `course-configuration.spec.ts`/`join-links-panel.spec.ts` both hold
 * themselves to):
 *
 *  - Real: the browser (`pages/Shell.tsx`, `components/InstallButton.tsx`),
 *    a real `apps/api` (`routes/actions.ts`, unmodified), a real throwaway
 *    SQLite database, and the whole read this slice added:
 *    `discordServers.list` dispatched exactly the way any other action is
 *    (`api/client.ts#listDiscordServers`).
 *  - Not real: the OAuth+PKCE install flow itself. The binding this test
 *    needs is inserted directly with `discordServers.claimDiscordServerBinding`
 *    — the same repository function TEN-4's real install flow calls, just
 *    invoked here instead of walked through Discord's own consent screen,
 *    which this harness has no way to automate (`course-configuration.spec.ts`'s
 *    own module comment already documents this same substitution). Because
 *    of that substitution, this browser's `justInstalled` is never set at
 *    all in this test — the binding exists only because this test wrote it
 *    directly to the database, exactly the shape a reload or a second
 *    device is in.
 *
 * So this test proves: a binding this browser session never installed
 * still shows as installed once the panel is loaded (or reloaded), and
 * Remove — reached the ordinary way, behind WEB-15's confirmation — actually
 * removes it, read back directly from the database.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  discordServers,
  memberships,
  openDatabase,
} from '@bloombot/db'

import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { readSignInToken } from './support/read-sign-in-token.js'

test('a Discord binding this browser never installed still shows as installed after a reload, with Remove reachable (TEN-8, WEB-4)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `ten8-${suffix}@example.edu`
  const guildId = `e2e-guild-ten8-${suffix}`

  // 1. Sign in — the same emailed-link flow every other panel spec in this
  //    suite uses, which also creates this account's own personal
  //    organization (TEN-1).
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(email)
  const token = await readSignInToken(email)
  await page.goto(`/sign-in/${token}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // 2. Bind a Discord server directly, bypassing the browser entirely — see
  //    this file's own module comment for why. This is the "a previous
  //    session, or a colleague's device, installed it" shape: nothing this
  //    browser did produced this binding.
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const account = accounts.getAccountByEmail(email, db)
    if (!account) throw new Error('setup failed: account not found')
    const [membership] = memberships.listMembershipsForAccount(account.id, db)
    if (!membership) throw new Error('setup failed: membership not found')
    const organizationId = membership.organizationId

    const claimed = discordServers.claimDiscordServerBinding(
      organizationId,
      { serverId: guildId, installedByAccountId: account.id },
      db
    )
    if (!claimed) throw new Error('setup failed: could not bind guild')
  } finally {
    closeDatabase(db)
  }

  // 3. A real reload — the exact reload the defect report names. This
  //    browser's own `justInstalled` was never set (no OAuth callback ever
  //    ran in this test), so before this slice the Discord tab would have
  //    offered "Install" here regardless of what step 2 just bound.
  await page.reload()
  await navigateTo(page, 'Discord')

  // The fetched binding is shown as installed — proves the panel reads what
  // is actually bound server-side rather than only this session's own
  // memory of installing it. TEN-9 — "Install to Discord" is offered
  // alongside it too, now: an organization can bind more than one server,
  // so this screen no longer treats "already installed" and "offer to
  // install" as mutually exclusive.
  await expect(page.getByText(guildId)).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Install to Discord' })
  ).toBeVisible()

  // 4. Remove is reachable for this binding, the same WEB-15 confirmation
  //    every other destructive control in this panel uses — before this
  //    slice, `handleRemove`'s own `if (!installedServerId) return` made
  //    this unreachable whenever `justInstalled` was unset, which it always
  //    is for a binding this browser did not itself just install.
  await page.getByRole('button', { name: 'Remove' }).click()
  const dialog = page.getByRole('dialog', {
    name: 'Remove this Discord server?',
  })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Remove' }).click()
  await expect(
    page.getByRole('button', { name: 'Install to Discord' })
  ).toBeVisible()

  // 5. Read back directly: the binding is actually marked removed, not
  //    merely hidden by the panel's own local state.
  const verifyDb = openDatabase(E2E_DATABASE_PATH)
  try {
    const account = accounts.getAccountByEmail(email, verifyDb)
    if (!account) throw new Error('verify failed: account not found')
    const [membership] = memberships.listMembershipsForAccount(
      account.id,
      verifyDb
    )
    if (!membership) throw new Error('verify failed: membership not found')
    expect(
      discordServers.getActiveDiscordServerBinding(
        membership.organizationId,
        guildId,
        verifyDb
      )
    ).toBeUndefined()
  } finally {
    closeDatabase(verifyDb)
  }
})
