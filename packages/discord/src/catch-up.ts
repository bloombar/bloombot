/**
 * SURF-9 — the pure decision half of catching up on messages missed while
 * `apps/bot` was disconnected.
 *
 * Discord delivers `MESSAGE_CREATE` exactly once, to whichever session is
 * connected at the moment it arrives (`docs/SPEC.md` §32's own incident).
 * A message sent while nothing was connected is simply never delivered —
 * there is no replay, and until this slice, no record it ever happened. On
 * a fresh gateway session (`Events.ShardReady`/`Events.ClientReady`),
 * `apps/bot` fetches one page of recent messages per channel it can see and
 * hands each one here,
 * already reduced to an `InboundMention` the same way the live path builds
 * one (`buildInboundMention`) — this module never touches discord.js
 * itself (`no-vendor-sdk.test.ts`), only the DTO `packages/discord`
 * already exposes.
 *
 * `decideCatchUp` is the whole policy, and it is deliberately a pure
 * function of its inputs: given the candidates, what has already been
 * handled, the current time, and the two configured bounds, it decides —
 * never fetches, never sends, never writes. `apps/bot` is the only thing
 * that acts on what it returns.
 */

import type { InboundMention } from './dto.js'
import type { HandleMentionResult } from './handle-mention.js'
import { mentionsBot } from './mention.js'

/** One message a catch-up scan found, reduced to what the decision needs. */
export interface CatchUpCandidate {
  /** The Discord message snowflake — what `discord_handled_messages` keys on. */
  messageId: string
  /** When the message was created, epoch milliseconds (decoded from its snowflake — see `apps/bot`'s own fetch). */
  createdAt: number
  /** Built the same way the live path builds one, from the same message. */
  mention: InboundMention
}

/** The two configured bounds (`packages/config/src/env.ts`'s own `DISCORD_CATCHUP_*`), passed straight through rather than read from `CONFIG` here — this package never reads configuration (D-29), the same discipline `handle-mention.ts`'s own `HandleMentionDependencies` already holds itself to. */
export interface CatchUpBounds {
  /** A missed message younger than this is answered exactly as it would have been live. */
  answerMaxAgeMs: number
  /** How far back the scan looks at all; `0` disables catch-up completely. */
  lookbackMs: number
}

/** What a candidate decides to: answered normally, apologised to, or left alone. */
export type CatchUpDecision =
  | { kind: 'answer'; candidate: CatchUpCandidate }
  | { kind: 'apologise'; candidate: CatchUpCandidate }
  | { kind: 'skip'; candidate: CatchUpCandidate }

/**
 * Does this candidate address the bot at all — the same test the live path
 * (`handle-mention.ts`) applies before anything else, reused rather than
 * reimplemented: a Discord Reply to one of the bot's own messages counts
 * exactly as a `<@id>` mention does, and the bot's own messages and other
 * bots' messages never do.
 */
function addressesBot(mention: InboundMention): boolean {
  if (mention.authorId === mention.botId) return false
  if (mention.authorIsBot) return false
  return mentionsBot(mention.text, mention.botId) || mention.repliesToBot
}

/**
 * Decide every candidate, oldest first — so a burst of missed messages in
 * one channel is answered/apologised to in the order they were actually
 * sent, the same order the live path would have processed them in had it
 * been connected. Candidates are not required to arrive already sorted;
 * this sorts them itself.
 *
 * `bounds.lookbackMs === 0` disables catch-up completely: every candidate
 * decides `skip`, regardless of age — the documented escape hatch
 * (`env.example`'s own comment) for an operator who wants the live path
 * only.
 */
export function decideCatchUp(
  candidates: CatchUpCandidate[],
  alreadyHandledIds: ReadonlySet<string>,
  now: number,
  bounds: CatchUpBounds
): CatchUpDecision[] {
  const sorted = [...candidates].sort((a, b) => a.createdAt - b.createdAt)

  if (bounds.lookbackMs <= 0) {
    return sorted.map((candidate) => ({ kind: 'skip', candidate }))
  }

  return sorted.map((candidate) => {
    if (alreadyHandledIds.has(candidate.messageId)) {
      return { kind: 'skip', candidate }
    }
    if (!addressesBot(candidate.mention)) {
      return { kind: 'skip', candidate }
    }

    const age = now - candidate.createdAt
    if (age > bounds.lookbackMs) {
      return { kind: 'skip', candidate }
    }
    if (age <= bounds.answerMaxAgeMs) {
      return { kind: 'answer', candidate }
    }
    return { kind: 'apologise', candidate }
  })
}

/**
 * The apology a missed message outside `answerMaxAgeMs` but still inside
 * `lookbackMs` gets, instead of the answer it would have gotten live —
 * the same one-line, no-internals register every refusal in
 * `handle-mention.ts` already holds itself to: what happened, that nothing
 * is coming, and what to do next. Named `catchUpApologyText` rather than
 * folded into `handle-mention.ts`'s own refusal texts — this is
 * `apps/bot`'s own catch-up path speaking, not a routed answer, so it lives
 * beside the decision it belongs to.
 */
export function catchUpApologyText(): string {
  return "I wasn't running when you sent this, so no answer is coming. Ask again if you still need help."
}

/**
 * `HandleMentionResult` kinds that never actually reached `handleMention`'s
 * own database or model work — recording one of these as "handled" would
 * mean every non-mention in a busy server grows `discord_handled_messages`
 * without bound, for a message that was never a candidate to answer twice in
 * the first place.
 */
const NOT_HANDLED_KINDS: ReadonlySet<HandleMentionResult['kind']> = new Set([
  'ignored-self',
  'ignored-other-bot',
  'ignored-not-a-mention',
])

/**
 * Should `apps/bot` record this message as handled, after `handleMention`
 * returns? Shared by both the live path (`apps/bot/src/index.ts`'s own
 * `onMessageCreate`) and the catch-up path (`apps/bot/src/catch-up.ts`) so
 * the two never drift on which outcomes count — `true` for every outcome
 * except the three that never reached this message's own handling at all.
 */
export function isHandledOutcome(kind: HandleMentionResult['kind']): boolean {
  return !NOT_HANDLED_KINDS.has(kind)
}
