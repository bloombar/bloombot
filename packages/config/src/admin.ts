/**
 * Platform administrator checks (AUTH-4).
 *
 * The allowlist is read from `process.env.ADMIN_EMAILS` on *every* call, not
 * captured at import and not taken from the memoized `CONFIG`. That is
 * deliberate: granting or revoking an administrator has to take effect by
 * editing the environment, without a redeploy or a process restart. It is never
 * a self-granted role and never a database flag.
 */

/**
 * Split the raw `ADMIN_EMAILS` value into normalized addresses.
 * Blank entries are dropped so a trailing comma is harmless.
 */
function allowlist(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
}

/**
 * Is this address a platform administrator?
 *
 * Both sides are trimmed and lowercased, because the address arrives from an
 * identity provider in whatever casing the user typed when they signed up.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const candidate = email.trim().toLowerCase()
  if (candidate.length === 0) return false
  return allowlist().includes(candidate)
}

/** The current administrator allowlist, normalized. Useful for diagnostics. */
export function adminEmails(): string[] {
  return allowlist()
}
