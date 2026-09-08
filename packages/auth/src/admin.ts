/**
 * The platform-administrator check (AUTH-4).
 *
 * This file is a thin, deliberate wrapper around `@bloombot/config`'s
 * `isAdminEmail` — it exists so every other module in this package (and
 * every caller of this package) reaches the same check through one name,
 * rather than importing `@bloombot/config` directly and inviting a second,
 * subtly different implementation to appear somewhere else in the platform.
 *
 * The allowlist itself is never captured here: `isAdminEmail` reads
 * `process.env.ADMIN_EMAILS` on every call (see `packages/config/src/admin.ts`),
 * so `isPlatformAdministrator` does too, transitively — adding or removing an
 * administrator takes effect by editing the environment, with no restart.
 *
 * Structurally not self-grantable: there is no exported function in this
 * package — or anywhere in `@bloombot/db`'s schema — that writes an
 * "administrator" value anywhere. It is not a column on `accounts`, not a
 * membership role (`MEMBERSHIP_ROLES` in `@bloombot/db`'s schema is `owner`
 * / `instructor` / `assistant`, and none of those is "platform
 * administrator"), and not a session claim `sign-in.ts` sets. The only way
 * to become one is for someone with access to the deployment's environment
 * to add an address to `ADMIN_EMAILS` — a code change and a deploy, not an
 * action any account, including this one's own, can take against the
 * running system.
 */

import { isAdminEmail } from '@bloombot/config'

/** Is this account's email a platform administrator? */
export function isPlatformAdministrator(
  email: string | null | undefined
): boolean {
  return isAdminEmail(email)
}
