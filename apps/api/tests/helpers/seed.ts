/**
 * Test helper: the smallest signed-in-caller graph these tests need —
 * organization, account, membership and a live session — written through
 * `@bloombot/db`'s and `@bloombot/auth`'s own functions, never raw SQL and
 * never through the HTTP surface these tests exercise (the tests proving
 * that surface need a scenario already in place, not one built by the
 * thing they are testing). The same `written through the real repos`
 * convention `packages/actions/tests/helpers/seed.ts` already uses.
 */

import { randomUUID } from 'node:crypto'

import { createSession } from '@bloombot/auth'
import {
  accounts,
  memberships,
  organizations,
  type Database,
} from '@bloombot/db'

import { SESSION_COOKIE_NAME } from '../../src/middleware/session.js'

export interface SignedInCaller {
  organizationId: string
  accountId: string
  /** The session's plaintext token — for a test that needs to prove the token itself later stops validating. */
  token: string
  /** A ready-to-send `Cookie` header value carrying the session. */
  cookieHeader: string
}

/**
 * One organization, one account, a membership binding them, and a live
 * session for that account — everything `routes/actions.ts` needs to
 * resolve a caller's organization from their own membership.
 */
export function seedSignedInCaller(
  db: Database,
  options: { organizationName?: string; role?: memberships.MembershipRole } = {}
): SignedInCaller {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: options.organizationName ?? 'Test Org', isPersonal: false },
    db
  )
  const account = accounts.createAccount(
    organizationId,
    {
      email: `${randomUUID()}@example.edu`,
      displayName: 'Test Caller',
      role: options.role ?? 'owner',
    },
    db
  )
  const session = createSession(account.id, db)

  return {
    organizationId,
    accountId: account.id,
    token: session.token,
    cookieHeader: `${SESSION_COOKIE_NAME}=${session.token}`,
  }
}

/**
 * A second, distinct account — with its own session — in `organizationId`,
 * alongside whatever caller `seedSignedInCaller` already returned for it.
 * For a test proving a guarantee scoped to *which account* acted, not
 * merely which organization it belongs to (finding 1 of the TEN-4..6
 * rework): two members of the same organization must not be
 * interchangeable just because a membership check alone would pass for
 * either of them.
 */
export function seedSecondCallerInOrganization(
  db: Database,
  organizationId: string
): SignedInCaller {
  const account = accounts.createAccount(
    organizationId,
    {
      email: `${randomUUID()}@example.edu`,
      displayName: 'Second Caller',
      role: 'assistant',
    },
    db
  )
  const session = createSession(account.id, db)

  return {
    organizationId,
    accountId: account.id,
    token: session.token,
    cookieHeader: `${SESSION_COOKIE_NAME}=${session.token}`,
  }
}

/** A second organization with no membership for `caller` — for proving TEN-5's "cross-tenant access is indistinguishable from absence." */
export function seedOtherOrganization(db: Database): string {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Other Org', isPersonal: false },
    db
  )
  return organizationId
}
