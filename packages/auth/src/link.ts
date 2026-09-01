/**
 * The identity-linking rule (AUTH-2) — the attack this requirement names in
 * one sentence: "linking on an unverified email is account takeover."
 *
 * Deliberately free of any database or network code, so the rule can be
 * read — and tested — with no infrastructure at all. `sign-in.ts` is the
 * only caller: it looks up whatever account already exists for the
 * asserted email, hands both to `decideLinkOutcome`, and acts on the
 * answer.
 */

/** The claims a verified Google identity carries, once `google.ts` has checked its signature. */
export interface GoogleIdentity {
  /** Google's stable per-account identifier (the `sub` claim). */
  subject: string
  email: string
  /** Whether *Google* asserts this address is verified — never trust the caller's own say-so. */
  emailVerified: boolean
}

export type LinkDecision = { action: 'link' } | { action: 'create' }

/**
 * Decide whether a Google identity should link to an existing account or
 * create a new one.
 *
 * Links only when both hold: the provider asserts `emailVerified`, and the
 * asserted email matches an existing account's email exactly
 * (case-insensitively — `accounts.ts` itself stores and compares email the
 * same way). Every other case creates a new account instead of linking:
 *
 *  - No account exists for this email yet — the ordinary first-time case,
 *    verified or not, and creating an account for an *unverified* email a
 *    nobody-else-holds is fine; the risk this rule guards against is
 *    reaching an *existing* account, not making a new one.
 *  - An account exists for this email, but the provider does not assert it
 *    is verified — the attack AUTH-2 names. An attacker able to make an
 *    OAuth app assert an arbitrary, unverified email address must not be
 *    able to walk into a stranger's existing account by typing that
 *    stranger's address; refusing to link here is what closes that.
 *
 * This function only decides; it never queries a database and never creates
 * anything. `existingAccountEmail` is `undefined` when the caller found no
 * matching account.
 */
export function decideLinkOutcome(
  identity: GoogleIdentity,
  existingAccountEmail: string | undefined
): LinkDecision {
  const matches =
    existingAccountEmail !== undefined &&
    identity.email.toLowerCase() === existingAccountEmail.toLowerCase()

  if (identity.emailVerified && matches) {
    return { action: 'link' }
  }
  return { action: 'create' }
}
