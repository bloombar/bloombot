/**
 * SURF-1..6: the Discord surface's one entry point. Everything `apps/bot`
 * needs from a discord.js `messageCreate` event funnels through here —
 * ignoring what should never reach the model (SURF-2), resolving the
 * server and the person (SURF-3, SURF-4), routing and answering through
 * `@bloombot/core` (CORE-1, CORE-2), and rendering whatever comes back
 * (SURF-5, SURF-6). `apps/bot` itself holds none of this logic (CORE-1's
 * own "a surface adapter ... holds no answering logic of its own"); it only
 * builds an `InboundMention` and a `ReplyPort` and calls this.
 *
 * D-34's own "what the linking slice should change in routing" lands here
 * too (LINK-5): once a message resolves to a person and a matched course,
 * this now also ensures (`enrolments.enrolViaDiscordRole`) that a role
 * holder has an explicit `enrolments` row for it before answering — turning
 * "holds the role, so route it" into "holds the role, so admit them once,
 * then route through the stored enrolment" (D-34's own words). This does
 * not change *whether* a message is answered — `routeMessage`'s own
 * category-or-role match is still the only thing that decides that, exactly
 * as before — it only makes a role holder's enrolment auditable from their
 * first message rather than left implicit forever. See this file's own
 * report for what that means for Discord in practice.
 */

import {
  answerQuestion,
  routeMessage,
  type AnswerDependencies,
  type ModelClient,
  type PricingTable,
  type RoutableCourse,
} from '@bloombot/core'
import {
  courses,
  discordServers,
  enrolments,
  people,
  type Database,
} from '@bloombot/db'
import type { AdmissionGate } from '@bloombot/jobs'
import type { Logger } from '@bloombot/logger'

import type { InboundMention, ReplyPort } from './dto.js'
import {
  DEFAULT_BOT_DISPLAY_NAME,
  mentionsBot,
  rewriteMention,
} from './mention.js'
import { splitForDiscord } from './split.js'

/** What `handleMention` needs beyond the message itself. */
export interface HandleMentionDependencies {
  db: Database
  model: ModelClient
  logger: Logger
  reply: ReplyPort
  /**
   * `YYYY-MM-DD`, supplied by the caller — the same discipline CORE-3's
   * `answerQuestion` holds itself to (`AnswerQuestionInput.day`'s own
   * comment): never read from a clock inside this package, so the day
   * boundary stays testable.
   */
  day: string
  /** The bare name (no `@`) BOT-6 rewrites a mention to. Defaults to `'Bloombot'`; `apps/bot` passes the gateway client's own username instead of hardcoding it here. */
  botDisplayName?: string
  /**
   * JOB-4's bound on concurrent model calls, passed straight through to
   * `answerQuestion`'s own `AnswerDependencies.admission`. Optional, the
   * same reason it is optional there: `apps/bot`'s own `main()` builds the
   * real, configured gate once (from `CONFIG.MODEL_ADMISSION_LIMIT`/
   * `MODEL_ADMISSION_WAIT_MS`) and passes it here; a caller — a test, or a
   * future surface with no admission story yet — that omits it gets
   * `answerQuestion`'s own no-bound default.
   */
  admission?: AdmissionGate
  /** COST-1/COST-6's per-model rates, passed straight through to `answerQuestion`'s own `AnswerDependencies.pricing`. Optional, the same reason `admission` is optional above: `apps/bot`'s own `main()` builds the real, configured table once (from `@bloombot/config`'s `getModelPricingTable`) and passes it here; a caller that omits it gets `answerQuestion`'s own zero-rate default. */
  pricing?: PricingTable
  /**
   * LINK-2's own address: the control panel's URL, embedded verbatim (and
   * alone — no token, see this file's own `connectInvitationText`) in the
   * invitation an unconnected person is answered with. Required, not
   * defaulted: unlike `botDisplayName`/`admission`/`pricing`, there is no
   * safe placeholder for a URL a student would actually be told to visit —
   * `apps/bot`'s own `main()` reads it from `CONFIG.PUBLIC_APP_URL`, the
   * same "packages/core/packages/discord never read CONFIG" discipline
   * (D-29) every other configured value already crosses this boundary
   * under.
   */
  connectUrl: string
}

/**
 * What happened, as a discriminated result — the same "ordinary outcome,
 * not an exception" discipline `AnswerResult` (`@bloombot/core`'s
 * `answer.ts`) holds itself to, one level up: everything `answerQuestion`
 * can return has a case here too, plus the outcomes that never reach it at
 * all (an ignored message, an unbound server, a routing failure).
 */
export type HandleMentionResult =
  | { kind: 'ignored-self' }
  | { kind: 'ignored-other-bot' }
  | { kind: 'ignored-not-a-mention' }
  | { kind: 'unbound-server' }
  | { kind: 'unrouted' }
  | {
      kind: 'routing-ambiguous'
      signal: 'category' | 'role'
      courseIds: string[]
    }
  | { kind: 'course-disabled' }
  | { kind: 'not-configured' }
  | { kind: 'invited-to-connect' }
  | { kind: 'declined-over-limit' }
  | { kind: 'declined-over-cap' }
  | { kind: 'declined-busy' }
  | { kind: 'answered'; conversationId: string; messageCount: number }
  | {
      kind: 'answered-last-request'
      conversationId: string
      messageCount: number
    }
  | {
      kind: 'failed-with-apology'
      conversationId: string
      messageCount: number
    }

/** BOT-5/SURF-6's refusal text for a request that arrives after the allowance is already spent — `response_bot.py` never sends this at all (BOT-5's own "requests beyond the limit are silently ignored"); SURF-6 requires every outcome reach the student or the log, so this one now reaches the student too. See docs/DECISIONS.md. */
function overLimitRefusalText(courseTitle: string): string {
  return `You have reached the maximum number of responses for today. See ${courseTitle} admins for help.`
}

/** Rework finding 1 — JOB-4's own text is "a student who waits is told they are waiting rather than left with silence": a busy, correctly configured course is neither the "answers nothing" nor the "matches no course" case SURF-6 reserves for log-only, so this reaches the student too. */
function busyRefusalText(): string {
  return `Bloombot is busy right now. Please try again shortly.`
}

/** COST-3 — the same "reaches the student, not just the log" treatment `overLimitRefusalText` already gets: an organization at its own spending cap is a refusal that says so, not a silent drop or a generic apology. */
function overSpendingCapRefusalText(courseTitle: string): string {
  return `Bloombot is unable to answer right now. See ${courseTitle} admins for help.`
}

/**
 * LINK-1/LINK-2 — the invitation an unconnected identity's first message
 * gets, instead of an answer: `connectUrl` and nothing else. No token, no
 * course name, no student-specific detail of any kind — LINK-2's own
 * reasoning is that a course channel is public, so anything more than a
 * plain address here is something the first person to read it could spend
 * on this student's behalf.
 */
function connectInvitationText(connectUrl: string): string {
  return `I don't have you connected to an account yet, so I can't answer here. Connect your account at ${connectUrl}, then ask again.`
}

/**
 * Strips anything after a `#` and lowercases — the same cleanup
 * `roster-import.ts`'s own `normalizeHandle` applies to a roster's
 * self-reported `Discord` handle before keying a `handle:`-prefixed
 * identity on it (ROST-10, D-31). Duplicated rather than imported: this
 * package and `apps/worker` are on opposite sides of the app/package
 * boundary this repo does not cross for a two-line helper neither owns,
 * the same convention `roster-import.ts`'s own `normalizeName`/
 * `normalizeChannelName` (duplicated from `discord-scaffold.ts`) already
 * holds itself to.
 */
function normalizeRosterHandle(handle: string): string {
  return (handle.split('#')[0] ?? handle).trim().toLowerCase()
}

/** SURF-5 — send `text` through `reply`, split first if it is over Discord's limit, each part awaited in order so the parts cannot arrive out of sequence. Returns how many messages were sent. */
async function sendReply(reply: ReplyPort, text: string): Promise<number> {
  const parts = splitForDiscord(text)
  for (const part of parts) {
    await reply.reply(part)
  }
  return parts.length
}

/**
 * CORE-2's `routeMessage` wants a flat `RoutableCourse[]`; `@bloombot/db`'s
 * `courses.listRoutableCourses` already builds that exact projection — id,
 * category names, both role names, `enabled` — filtered to courses whose
 * project is not archived (PROJ-2/finding 2 of this rework), in two queries
 * regardless of course count rather than one `getCourse` per course (finding
 * 14: `getCourse` also loads every channel row routing never reads). This
 * function only reshapes that into what `routeMessage` takes, and keeps each
 * course's title, keyed by id, for the one place a title is needed after
 * routing decides a course (`overLimitRefusalText`) — `RoutableCourse` itself
 * carries no title, only what `routeMessage` reads.
 */
function loadRoutableCourses(
  organizationId: string,
  db: Database
): { routable: RoutableCourse[]; titleById: Map<string, string> } {
  const rows = courses.listRoutableCourses(organizationId, db)
  const titleById = new Map<string, string>()
  const routable: RoutableCourse[] = rows.map((row) => {
    titleById.set(row.id, row.title)
    return {
      id: row.id,
      categoryNames: row.categoryNames,
      adminsRole: row.adminsRole,
      studentsRole: row.studentsRole,
      enabled: row.enabled,
    }
  })

  return { routable, titleById }
}

/**
 * Handle one incoming message. In order:
 *
 * 1. SURF-2 — ignore the bot's own messages, another bot's messages, and
 *    anything that does not mention this bot at all, before any database or
 *    model call.
 * 2. SURF-3 — resolve the Discord server to an organization; an unbound
 *    server is logged and dropped.
 * 3. SURF-4 — resolve (or create) the person, and merge in their current
 *    Discord display name.
 * 4. CORE-2 — route the message to exactly one course.
 * 5. CORE-1 — answer through `answerQuestion`, and render whatever it
 *    returns (SURF-5, SURF-6).
 */
export async function handleMention(
  input: InboundMention,
  deps: HandleMentionDependencies
): Promise<HandleMentionResult> {
  const { db, model, logger, reply, day } = deps
  const botDisplayName = deps.botDisplayName ?? DEFAULT_BOT_DISPLAY_NAME

  // SURF-2 — checked before anything else: a loop between two bots (or the
  // bot replying to its own reply) must never depend on whether either
  // message happens to mention the other.
  if (input.authorId === input.botId) {
    return { kind: 'ignored-self' }
  }
  if (input.authorIsBot) {
    return { kind: 'ignored-other-bot' }
  }
  // Finding 3 — a Discord Reply carries no `<@id>` token of its own, so
  // `input.repliesToBot` (set from Discord's own reply relationship, not the
  // message text) is a second, independent way a message can be "addressed
  // to this bot" — checked here, not folded into `mentionsBot` itself, since
  // that function only ever knows about text.
  if (!mentionsBot(input.text, input.botId) && !input.repliesToBot) {
    return { kind: 'ignored-not-a-mention' }
  }

  // SURF-3 — an incoming message is answered only when its Discord server
  // resolves to an organization through the binding record.
  const binding = discordServers.resolveDiscordServerBinding(input.guildId, db)
  if (!binding) {
    logger.info(
      { guildId: input.guildId },
      'handleMention: dropped, Discord server is not bound to an organization'
    )
    return { kind: 'unbound-server' }
  }
  const organizationId = binding.organizationId

  // SURF-4 / D-31 rework — a roster imported *before* this student ever
  // joined the server may already have created a person for them, kept
  // under a synthetic `handle:`-keyed identity (`roster-import.ts`'s own
  // ROST-10 fallback, D-31) rather than the real snowflake, which was not
  // resolvable yet at import time. Left alone, this student's first message
  // would resolve by snowflake, find nothing, and `resolvePersonByIdentity`
  // would mint a *second* person — a second conversation, a second daily
  // allowance, and the roster's own fields stranded on the orphan. Checking
  // for that `handle:`-keyed person first (only when the snowflake itself
  // is not yet known) reuses it instead: same person, same conversation,
  // same allowance, from this student's very first message on. See
  // `docs/DECISIONS.md`'s own entry on this rework for why this does not
  // also rewrite the `handle:` row's own external id to the snowflake — a
  // further step this fix deliberately does not take, and why that is
  // still sound.
  const bySnowflake = people.resolveIdentity(
    organizationId,
    { surface: 'discord', externalId: input.authorId },
    db
  )
  const byRosterHandle = bySnowflake
    ? undefined
    : people.resolveIdentity(
        organizationId,
        {
          surface: 'discord',
          externalId: `handle:${normalizeRosterHandle(input.authorDisplayName)}`,
        },
        db
      )

  // SURF-4 — the author's snowflake resolves to a person, created together
  // with a new identity the first time they are seen (PPL-3), unless the
  // roster-handle fallback just above already found one. Their current
  // Discord display name is merged in now rather than waiting for a roster
  // import: `mergeRosterFields` only fills a field that is still `null`, so
  // a name a later roster import supplies is never overwritten by this.
  const person =
    bySnowflake ??
    byRosterHandle ??
    people.resolvePersonByIdentity(
      organizationId,
      { surface: 'discord', externalId: input.authorId },
      db
    )
  people.mergeRosterFields(
    organizationId,
    person.id,
    { displayName: input.authorDisplayName },
    db
  )

  // CORE-2 — attribute the message to exactly one course.
  const { routable, titleById } = loadRoutableCourses(organizationId, db)
  const routing = routeMessage(routable, {
    categoryName: input.categoryName,
    channelName: input.channelName,
    roleNames: input.authorRoleNames,
  })

  if (routing.kind === 'unmatched') {
    // SURF-6 — "a message that matches no course": logged, not answered.
    logger.info(
      {
        organizationId,
        guildId: input.guildId,
        channelName: input.channelName,
        categoryName: input.categoryName,
      },
      'handleMention: dropped, message matches no course'
    )
    return { kind: 'unrouted' }
  }
  if (routing.kind === 'ambiguous') {
    // CORE-2 — "a configuration error the platform reports rather than a
    // choice it makes quietly": also logged and dropped, at ERROR since an
    // instructor's own configuration needs fixing, not just noting.
    logger.error(
      { organizationId, signal: routing.signal, courseIds: routing.courseIds },
      'handleMention: dropped, message matches more than one course'
    )
    return {
      kind: 'routing-ambiguous',
      signal: routing.signal,
      courseIds: routing.courseIds,
    }
  }

  const courseId = routing.course.id
  const courseTitle = titleById.get(courseId) ?? courseId

  // D-34/LINK-5 — a role holder is admitted (once) through the stored
  // enrolment relation rather than only ever routed by re-checking their
  // Discord role on every message. `enrolViaDiscordRole` is itself the
  // no-op when the author does not hold `courseId`'s own `studentsRole`
  // (`repos/enrolments.ts`'s own doc comment), or when they already hold an
  // active enrolment for it, so this is safe to call on every matched
  // message rather than only the first. Best-effort: this never gates
  // *whether* `answerQuestion` runs below — `routeMessage`'s own
  // category-or-role match already decided that — so a write failure here
  // is logged and never blocks the reply, the same "a broken write degrades
  // to a log line, not a lost answer" discipline `@bloombot/core`'s own
  // `answer.ts` holds every non-essential write to.
  try {
    enrolments.enrolViaDiscordRole(
      organizationId,
      { courseId, personId: person.id, roleNames: input.authorRoleNames },
      db
    )
  } catch (error) {
    logger.error(
      { err: error, organizationId, courseId, personId: person.id },
      'handleMention: failed to record a Discord-role enrolment'
    )
  }

  // BOT-6 — the raw mention token is rewritten to a readable name before
  // the model ever sees the question; `text` (unrewritten) is what the
  // transcript records via `answerQuestion`'s own `text`/`modelText` split.
  const modelText = rewriteMention(input.text, input.botId, botDisplayName)

  const answerDeps: AnswerDependencies = {
    db,
    model,
    logger,
    ...(deps.admission ? { admission: deps.admission } : {}),
    ...(deps.pricing ? { pricing: deps.pricing } : {}),
  }
  const result = await answerQuestion(
    {
      organizationId,
      courseId,
      personId: person.id,
      surface: 'discord',
      text: input.text,
      modelText,
      day,
      channelRef: input.channelName,
      categoryRef: input.categoryName,
    },
    answerDeps
  )

  switch (result.kind) {
    case 'answered':
    case 'answered-last-request': {
      const messageCount = await sendReply(reply, result.text)
      return {
        kind: result.kind,
        conversationId: result.conversationId,
        messageCount,
      }
    }
    case 'failed-with-apology': {
      let messageCount = await sendReply(reply, result.text)
      // Finding 9 — `answerQuestion` carries `lastRequestOfDay` on this
      // variant precisely so a provider outage on a student's last request
      // does not leave them apologised-to *and* silently locked out with no
      // notice at all (`@bloombot/core`'s own `AnswerResult` comment); the
      // apology's own wording never changes (it must stay byte-identical to
      // `response_bot.py`'s), so the notice is a second message, the same
      // wording `declined-over-limit` already sends.
      if (result.lastRequestOfDay) {
        messageCount += await sendReply(
          reply,
          overLimitRefusalText(courseTitle)
        )
      }
      return {
        kind: 'failed-with-apology',
        conversationId: result.conversationId,
        messageCount,
      }
    }
    case 'declined-over-limit': {
      // SURF-6 — the allowance is spent: unlike `response_bot.py`'s own
      // silent drop (BOT-5), a refusal now reaches the student. See
      // docs/DECISIONS.md.
      await sendReply(reply, overLimitRefusalText(courseTitle))
      return { kind: 'declined-over-limit' }
    }
    case 'declined-over-cap': {
      // COST-3 — the organization has reached its own spending cap: the
      // same "reaches the student, not a silent drop" treatment
      // `declined-over-limit` above already gets, with its own wording
      // (`overSpendingCapRefusalText`) so an instructor reading logs can
      // tell "this student is over their daily allowance" apart from "this
      // organization needs its cap raised" — the same distinction
      // `answerQuestion`'s own two result kinds already draw.
      await sendReply(reply, overSpendingCapRefusalText(courseTitle))
      logger.info(
        { organizationId, courseId, personId: person.id },
        'handleMention: declined, organization has reached its spending cap'
      )
      return { kind: 'declined-over-cap' }
    }
    case 'course-disabled':
    case 'not-configured': {
      // SURF-6 — "a course configured to answer nothing": logged, not
      // answered, matching `answerQuestion`'s own treatment of both.
      logger.info(
        { organizationId, courseId, personId: person.id, kind: result.kind },
        'handleMention: dropped, course is not configured to answer'
      )
      return { kind: result.kind }
    }
    case 'not-connected': {
      // LINK-1/LINK-2 — the invitation reaches the student (unlike
      // `course-disabled`/`not-configured` above, this is not a
      // configuration problem to log and drop silently; it is the ordinary
      // first-message outcome for anyone not yet connected). No model call
      // was made and no allowance was spent (`@bloombot/core`'s own
      // `answer.ts` guarantees that, before this ever runs).
      await sendReply(reply, connectInvitationText(deps.connectUrl))
      logger.info(
        { organizationId, courseId, personId: person.id },
        'handleMention: declined, person is not yet connected to a verified account'
      )
      return { kind: 'invited-to-connect' }
    }
    case 'declined-busy': {
      // JOB-4/rework finding 1 — no admission slot became free within the
      // wait ceiling. A busy, correctly configured course is neither of the
      // two cases SURF-6 reserves for log-only (a course configured to
      // answer nothing, or a message matching no course), so the student is
      // told they are waiting rather than left with silence indistinguishable
      // from the bot being offline — the same "reaches the student" treatment
      // `declined-over-limit` above already gets.
      await sendReply(reply, busyRefusalText())
      logger.info(
        { organizationId, courseId, personId: person.id },
        'handleMention: declined, no admission slot became free within the wait ceiling'
      )
      return { kind: 'declined-busy' }
    }
  }
}
