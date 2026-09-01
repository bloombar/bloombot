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
 *
 * `allowMemberOverwrite` (ROST-11) is this file's one addition since
 * SRV-2/SRV-3, both of which are role-scoped — a course's per-student
 * private channel needs to grant exactly one student, by their own member
 * id, never a role every student shares (ROST-5: "grants the individual
 * student read_messages and send_messages").
 */

const VIEW_CHANNEL_BIT = 0x400n
const SEND_MESSAGES_BIT = 0x800n

/** Discord's own overwrite-target kind: `0` for a role, `1` for a guild member. */
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

/** Grant one guild member read and send access — ROST-11's per-student channel, the one place this package overwrites by member id rather than by role. Same bits as `allowRoleOverwrite`, `type: 1` (member) rather than `0` (role). */
export function allowMemberOverwrite(
  memberId: string
): DiscordPermissionOverwrite {
  return {
    id: memberId,
    type: 1,
    allow: (VIEW_CHANNEL_BIT | SEND_MESSAGES_BIT).toString(),
    deny: '0',
  }
}

/**
 * The read half of `VIEW_CHANNEL_BIT` — whether one overwrite entry actually
 * *grants* it. Finding 4 of the SRV-6..8 rework: `discord-scaffold.ts`'s
 * report used to copy a category or channel's `adminsOnly`/privacy state
 * straight from what the course declared, even when the row already existed
 * and this run never touched its permissions at all — so a pre-existing
 * `grades` channel students could already read stayed readable to them the
 * moment `admins_only: true` was set, while the report said `adminsOnly:
 * true` regardless. `SRV-8`'s structural no-edit (this package's own module
 * comment) means the report is the only place that can ever be honest about
 * that, so it needs to read what an existing row's own overwrites actually
 * grant, not merely echo the declaration.
 */
export function overwriteAllowsView(
  overwrite: DiscordPermissionOverwrite
): boolean {
  return (BigInt(overwrite.allow) & VIEW_CHANNEL_BIT) !== 0n
}

/** The write half's inverse — whether one overwrite entry actually *denies* `VIEW_CHANNEL_BIT`. Same reasoning as `overwriteAllowsView`, above. */
export function overwriteDeniesView(
  overwrite: DiscordPermissionOverwrite
): boolean {
  return (BigInt(overwrite.deny) & VIEW_CHANNEL_BIT) !== 0n
}
