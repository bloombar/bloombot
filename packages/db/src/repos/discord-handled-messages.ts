/**
 * Repository for `discord_handled_messages` (SURF-9).
 *
 * The durable record of which Discord messages a catch-up scan (and,
 * indirectly, the live path — `apps/bot`'s own `main()` records the live
 * message's id the same way, after `handleMention` returns) has already
 * dispositioned. The message snowflake is the table's primary key
 * (`schema.ts`), so a second `INSERT` for an already-recorded message is
 * refused by SQLite itself before any code in this file runs — the same
 * "let the database refuse it" discipline `discord-servers.ts`'s own module
 * comment holds itself to for TEN-3.
 *
 * Unlike every other repo in this package, this table carries no
 * `organizationId` and its functions take none: a Discord message id is
 * already globally unique on Discord's own side, and the only question this
 * table ever answers — "has this exact message been handled before" — never
 * needs an organization to disambiguate it. Allowlisted in
 * `tests/tenant-scoping-convention.test.ts` accordingly, the same class
 * `discord-install-states.ts` and `sign-in-tokens.ts` already document for
 * themselves.
 */

import { eq, lt } from 'drizzle-orm'

import type { Executor } from '../client.js'
import { discordHandledMessages } from '../schema.js'

export type DiscordHandledMessage = typeof discordHandledMessages.$inferSelect

/** Fields the caller supplies when recording a handled message. */
export interface NewDiscordHandledMessage {
  messageId: string
  serverId: string
  channelId: string
  handledAt: number
}

/**
 * Record a message as handled. Called from `apps/bot`'s live path after
 * `handleMention` returns — for every outcome except the three "not
 * actually handled" ones (`ignored-self`, `ignored-other-bot`,
 * `ignored-not-a-mention`) — and from the catch-up scan
 * (`packages/discord/src/catch-up.ts`) for every `answer` and `apologise`
 * decision.
 *
 * Recording *after* the work is done, not before, is deliberate: a crash
 * mid-answer leaves the id unrecorded, so the next catch-up scan re-handles
 * (and possibly re-answers) the same message — strictly better for this
 * feature than a message that silently never got an answer at all, the same
 * failure this whole feature exists to close.
 *
 * A duplicate `messageId` (the live path and a catch-up scan racing on the
 * same message, or a caller recording twice) is swallowed rather than
 * thrown — `INSERT OR IGNORE` — since "already recorded" is exactly the
 * outcome a caller here wants, not an error to handle.
 */
export function recordHandledMessage(
  input: NewDiscordHandledMessage,
  db: Executor
): void {
  db.insert(discordHandledMessages)
    .values({
      messageId: input.messageId,
      serverId: input.serverId,
      channelId: input.channelId,
      handledAt: input.handledAt,
    })
    .onConflictDoNothing()
    .run()
}

/**
 * Every message id already recorded as handled, for `catch-up.ts`'s own
 * decision function to skip — narrowed to a `Set<string>` here rather than
 * handed back as rows, since membership is all that function ever asks.
 */
export function listHandledMessageIds(db: Executor): Set<string> {
  const rows = db
    .select({ messageId: discordHandledMessages.messageId })
    .from(discordHandledMessages)
    .all()
  return new Set(rows.map((row) => row.messageId))
}

/**
 * Was this exact message id already recorded? What the live path
 * (`apps/bot`) could use to avoid a double answer on its own, though the
 * live path's own single-delivery guarantee from Discord makes this mostly
 * moot there — it exists for a caller that wants a single-id check rather
 * than `listHandledMessageIds`'s full set.
 */
export function isMessageHandled(messageId: string, db: Executor): boolean {
  return (
    db
      .select({ messageId: discordHandledMessages.messageId })
      .from(discordHandledMessages)
      .where(eq(discordHandledMessages.messageId, messageId))
      .get() !== undefined
  )
}

/**
 * Prune every row older than `olderThan` — called once per catch-up run
 * (`apps/bot`'s own ready handler), right before scanning, so a row a
 * catch-up scan could never need again (older than
 * `DISCORD_CATCHUP_LOOKBACK_MS`, the same bound the scan itself reads) does
 * not sit in the table forever. The same "sweep on write" shape
 * `discord-install-states.ts#deleteExpiredInstallStates` already uses.
 */
export function pruneHandledMessagesOlderThan(
  olderThan: number,
  db: Executor
): number {
  const result = db
    .delete(discordHandledMessages)
    .where(lt(discordHandledMessages.handledAt, olderThan))
    .run()
  return result.changes
}
