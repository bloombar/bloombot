/**
 * Test helpers for courses that use Discord (TEN-11, WEB-80).
 *
 * A new course starts with "No Discord" selected, and its roles, categories
 * and self-enrolment checkbox stay disabled until a server is chosen. Most
 * specs create a course to exercise something else (chat, people, usage …)
 * and fill in roles and categories on the way, so they need an organization
 * that has a Discord server and a course that names it. These two steps
 * give them that without walking Discord's real install flow, which this
 * harness cannot automate:
 *
 *  - `bindDiscordServer` records a server for the account's organization
 *    directly, through the same repository function the real install
 *    callback uses (`discordServers.claimDiscordServerBinding`). Call it
 *    after signing in and *before* opening the new-course form, because the
 *    editor reads the organization's servers once, when it opens.
 *  - `chooseDiscordServer` picks that server in the open course form.
 */

import { randomUUID } from 'node:crypto'

import { expect, type Page } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  discordServers,
  memberships,
  openDatabase,
} from '@bloombot/db'

import { E2E_DATABASE_PATH } from './env.js'

/**
 * Gives the account's first organization an active Discord server, unless it
 * already has one. Returns the server id. A spec that later claims its own
 * server id (to point a fake Discord at it) passes that id here so the course
 * is pinned to the same server it will be messaged in. Waits for the account and its
 * organization to exist: `signIn` can return a moment before the sign-in
 * request that creates them has committed.
 */
export async function bindDiscordServer(
  email: string,
  serverId?: string
): Promise<string> {
  await expect
    .poll(() => hasOrganization(email), { timeout: 10_000 })
    .toBe(true)
  return bindNow(email, serverId)
}

function hasOrganization(email: string): boolean {
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const account = accounts.getAccountByEmail(email, db)
    return (
      account !== undefined &&
      memberships.listMembershipsForAccount(account.id, db).length > 0
    )
  } finally {
    closeDatabase(db)
  }
}

function bindNow(email: string, requestedServerId?: string): string {
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const account = accounts.getAccountByEmail(email, db)
    if (!account) throw new Error('bindDiscordServer: account not found')
    const [membership] = memberships.listMembershipsForAccount(account.id, db)
    if (!membership) throw new Error('bindDiscordServer: membership not found')
    const existing = discordServers
      .listDiscordServerBindingsForOrganization(membership.organizationId, db)
      .find((binding) => binding.removedAt === null)
    if (existing) return existing.serverId
    const serverId =
      requestedServerId ?? `e2e-guild-${randomUUID().slice(0, 8)}`
    const claimed = discordServers.claimDiscordServerBinding(
      membership.organizationId,
      { serverId, installedByAccountId: account.id },
      db
    )
    if (!claimed) throw new Error('bindDiscordServer: claim refused')
    return serverId
  } finally {
    closeDatabase(db)
  }
}

/** In an open course form, picks the first real Discord server in the selector (anything but "No Discord"). */
export async function chooseDiscordServer(page: Page): Promise<void> {
  const select = page.getByLabel('Discord server')
  const realOption = select.locator(
    'option:not([value="none"]):not([value=""]):not([disabled])'
  )
  await expect(realOption.first()).toBeAttached()
  const value = await realOption.first().getAttribute('value')
  if (!value) throw new Error('chooseDiscordServer: no server option')
  await select.selectOption(value)
}
