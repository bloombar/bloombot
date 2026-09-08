/**
 * The one permission bit TEN-4's install flow checks: `MANAGE_GUILD`
 * (`0x20`, Discord's own permission-flag numbering), or ownership, on a
 * guild summary as `client.ts#getUserGuilds` returns it. A `BigInt`, not a
 * plain number: Discord's `permissions` field is documented as a string
 * specifically because the full bitfield can exceed the 32 bits JavaScript's
 * own `&` operator operates on — a `Number(...) & MANAGE_GUILD_BIT` would
 * silently truncate a permission set with high bits set before the `&` ever
 * ran.
 */

const MANAGE_GUILD_BIT = 0x20n

export interface DiscordGuildSummary {
  id: string
  name: string
  /** Present (and meaningful) only on a guild list read with the *user's* own token — `getUserGuilds`, never `getBotGuilds`. */
  owner?: boolean
  /** Decimal string, Discord's own bitfield encoding — see the module comment. */
  permissions?: string
}

/**
 * Whether `guild` shows its owner, or `MANAGE_GUILD`, on the account that
 * authenticated the `getUserGuilds` call this came from — TEN-4's own
 * check, "read from Discord, not from the request". A guild summary with no
 * `permissions` at all (or one Discord did not encode as a plain decimal
 * integer) proves nothing, so this refuses rather than throws.
 */
export function administersGuild(guild: DiscordGuildSummary): boolean {
  if (guild.owner) return true
  if (!guild.permissions) return false
  try {
    return (BigInt(guild.permissions) & MANAGE_GUILD_BIT) === MANAGE_GUILD_BIT
  } catch {
    return false
  }
}
