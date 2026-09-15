/**
 * LINK-11 — the one rule for "which organization does this account act in
 * when nothing else names one," shared between `App.tsx`'s own home
 * resolution (`resolveHomeRoute`) and `components/SignedInChrome.tsx`'s own
 * header for a standalone, not-organization-scoped page (`Connect.tsx`,
 * `Connected.tsx`, `JoinLink.tsx`, `Invitation.tsx`, `ConnectAssistant.tsx`,
 * the signed-in `NotFound` rendered by `App.tsx`): a membership, first, then
 * a connected organization — the identical fallback `resolveHomeRoute` used
 * to compute inline (`account.memberships[0]?.organizationId ??
 * account.connectedOrganizations[0]?.organizationId`), pulled out so there
 * is exactly one place this app decides it, rather than a second copy
 * invented for the standalone pages' own header.
 *
 * Returns `undefined` when the account has neither a membership nor a
 * connected organization at all — should not happen (TEN-1 gives every
 * account its own personal organization on first sign in), but this app is
 * written to defend against, not assume, that (`resolveHomeRoute`'s own
 * comment on the same case). `SignedInChrome` renders the header with no
 * organization switcher and no organization-scoped nav in that case, rather
 * than inventing an organization id to show.
 */

import type { AccountSummary } from './api/types.js'

export interface DefaultOrganization {
  organizationId: string
  /** Whether this is a membership (`true`) or only a connected identity (`false`) — the same split `pages/Shell.tsx`'s own `isMember` already draws, needed here too since it decides which tab a switch or a home click lands on (Projects vs. Chat). */
  isMember: boolean
}

export function resolveDefaultOrganization(
  account: AccountSummary
): DefaultOrganization | undefined {
  const membership = account.memberships[0]
  if (membership) {
    return { organizationId: membership.organizationId, isMember: true }
  }
  const connection = account.connectedOrganizations[0]
  if (connection) {
    return { organizationId: connection.organizationId, isMember: false }
  }
  return undefined
}
