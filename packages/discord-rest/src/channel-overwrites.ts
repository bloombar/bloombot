/**
 * SRV-2/SRV-3's permission overwrites, in Discord's own REST shape — `{ id,
 * type, allow, deny }`, one entry per role or member a channel or category
 * overrides (Discord API v10, "Permission Overwrite Object"). `client.ts`'s
 * `createGuildCategory`/`createGuildChannel` send these straight through in
 * a channel's own `permission_overwrites` field at creation time, the same
 * "computed once, sent with the create call" shape `discord_manager.py`'s
 * `category.edit(overwrites=...)` achieves in two steps (create, then edit)
 * that this REST client does in one.
 *
 * `VIEW_CHANNEL_BIT`/`SEND_MESSAGES_BIT` are `BigInt`, not plain numbers,
 * for the same reason `permissions.ts`'s own `MANAGE_GUILD_BIT` is —
 * Discord's full permission bitfield exceeds the 32 bits JavaScript's `&`/`|`
 * operate on, even though these two low bits alone never would; consistency
 * with the rest of this package matters more than the few bytes saved by a
 * plain number here.
 */

const VIEW_CHANNEL_BIT = 0x400n
const SEND_MESSAGES_BIT = 0x800n

/** Discord's own overwrite-target kind: `0` for a role, `1` for a guild member. Every overwrite this package builds is role-scoped — SRV-2/SRV-3 grant access by course role, never by naming an individual member. */
export type DiscordOverwriteType = 0 | 1

export interface DiscordPermissionOverwrite {
  id: string
  type: DiscordOverwriteType
  /** Decimal string — Discord's own bitfield encoding, the same reason `DiscordGuildSummary.permissions` (`permissions.ts`) is a string rather than a number. */
  allow: string
  deny: string
}

/**
 * Deny `@everyone` read access to a category or channel — SRV-2's "every
 * category created by hydration is made private by default". Discord's own
 * `@everyone` role shares its guild's id (a documented fact of the API, not
 * something this package looks up), so `everyoneRoleId` is simply the guild
 * id the caller already has.
 */
export function denyEveryoneOverwrite(
  everyoneRoleId: string
): DiscordPermissionOverwrite {
  return {
    id: everyoneRoleId,
    type: 0,
    allow: '0',
    deny: VIEW_CHANNEL_BIT.toString(),
  }
}

/** Grant a role read and send access — SRV-2/SRV-3's "granted read_messages and send_messages", applied to a course's admins or students role, or (SRV-3) an admin-only channel's own admins-only overwrite. */
export function allowRoleOverwrite(roleId: string): DiscordPermissionOverwrite {
  return {
    id: roleId,
    type: 0,
    allow: (VIEW_CHANNEL_BIT | SEND_MESSAGES_BIT).toString(),
    deny: '0',
  }
}
