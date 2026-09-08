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

export type LinkDecision =
  { action: 'link' } | { action: 'create' } | { action: 'reject' }

/**
 * Decide whether a Google identity should link to an existing account,
 * create a new one, or be refused outright.
 *
 * Links only when both hold: the provider asserts `emailVerified`, and the
 * asserted email matches an existing account's email exactly
 * (case-insensitively — `accounts.ts` itself stores and compares email the
 * same way). Every other case either creates a new account or rejects the
 * sign-in:
 *
 *  - `emailVerified` is false — rejected, whether or not the address
 *    matches an existing account (finding 2 of the AUTH-1..4 rework). An
 *    unverified assertion proves nothing about who controls the address, so
 *    it must not be able to *reach* an account either way: matching an
 *    existing one is the takeover AUTH-2's own sentence names directly, and
 *    matching nobody yet is the same attack one step earlier — an attacker
 *    who asserts a victim's real address before the victim has ever signed
 *    in themselves would otherwise get to pre-create and hold that victim's
 *    account. See docs/DECISIONS.md (D-19).
 *  - `emailVerified` is true but no existing account matches — the
 *    ordinary first-time case: nothing here has been proven false, and
 *    creating an account for an address nobody else holds is exactly
 *    AUTH-2's "otherwise a new account is created."
 *
 * This function only decides; it never queries a database and never creates
 * anything. `existingAccountEmail` is `undefined` when the caller found no
 * matching account.
 */
export function decideLinkOutcome(
  identity: GoogleIdentity,
  existingAccountEmail: string | undefined
): LinkDecision {
  if (!identity.emailVerified) {
    return { action: 'reject' }
  }

  const matches =
    existingAccountEmail !== undefined &&
    identity.email.toLowerCase() === existingAccountEmail.toLowerCase()

  return matches ? { action: 'link' } : { action: 'create' }
}
