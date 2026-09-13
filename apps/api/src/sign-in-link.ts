/**
 * The one place the emailed sign-in link's own URL is spelled out
 * (`AUTH-1`, `MCP-12`). `@bloombot/auth` issues the token and knows nothing
 * about this app's routes; `pages/RedeemLink.tsx` reads the result back.
 * Extracted from `index.ts`'s process wiring so both ends of that agreement
 * can be tested against the same function the deployment actually runs —
 * a review finding: while this lived as an inline lambda in `main()`, every
 * test built its own lookalike URL, so a typo here (`&destination=` for
 * `?destination=`, a missing `encodeURIComponent`) would have shipped green.
 */

/**
 * Build the emailed link for `token`, returning to `destination` afterward.
 *
 * MCP-12 — `destination` rides along as a query parameter, not only on the
 * token itself. It is a **hint, never a second source of truth**: a
 * successful redemption uses the destination stored against the token
 * (`consumeSignInToken`, `@bloombot/auth`), and this copy exists only so
 * `pages/RedeemLink.tsx`'s failure state can still offer "request a new
 * link that returns here" once the token — and with it the stored
 * destination — can no longer be looked up at all. Already validated as a
 * same-origin path by the time it reaches here (`issueSignInToken` throws
 * before `buildLink` is ever called), and re-validated again on read.
 */
export function buildSignInLink(
  publicAppUrl: string,
  token: string,
  destination?: string
): string {
  const base = `${publicAppUrl}/sign-in/${token}`
  return destination === undefined
    ? base
    : `${base}?destination=${encodeURIComponent(destination)}`
}
