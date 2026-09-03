/**
 * CORE-1, 3, 5, 6: the one answering pipeline every surface calls.
 *
 * `answerQuestion` takes its dependencies as arguments — the open `Database`,
 * a `ModelClient`, a `Logger`, and `day` — rather than importing any of them,
 * so a test can hand it a throwaway database and `FakeModelClient` with no
 * network and no clock (CORE-4). It writes only through `@bloombot/db`'s
 * repos, the same convention `packages/db`'s own repos hold themselves to.
 *
 * `courseId` and `personId` are trusted to already belong to
 * `organizationId` and to each other's routing/identity decisions (CORE-2's
 * job, PPL-3's job) — this function is not where a course is matched or a
 * person is resolved, only where the answer is produced once both are known.
 * A `courseId`, `personId` or conversation that does not resolve is treated
 * as caller misuse and throws, rather than being folded into the
 * discriminated result: CORE-3's over-limit and CORE-5's model failure are
 * the *ordinary* outcomes this pipeline exists to handle, not every possible
 * failure.
 *
 * A *disabled* course, or one routing found by category/role but that has
 * never been given a `promptId` or `instructions` to answer with, is also
 * ordinary rather than exceptional (finding 1 and finding 3 of the CORE-1
 * rework): CORE-2's routing already filters a disabled course out for the
 * Discord adapter, but the web chat and MCP surfaces call `answerQuestion`
 * directly with a `courseId` they resolved themselves, never through
 * routing — so this function guards both cases itself rather than trusting
 * every caller to have checked first.
 *
 * JOB-4 — admission bounds how many calls to `model.ask` run at once. It is
 * acquired *before* `reserveUsageSlot`, not around `model.ask` alone: see
 * this file's own `answerQuestion` comment for why, and `docs/DECISIONS.md`
 * for the fuller reasoning. `deps.admission` is optional and, when omitted,
 * defaults to `NO_ADMISSION_LIMIT` below — a gate that always grants
 * immediately, applying no bound at all. That default is deliberate, not
 * merely convenient: `@bloombot/config`'s `MODEL_ADMISSION_LIMIT`/
 * `MODEL_ADMISSION_WAIT_MS` are what a *real* bound is configured from, but
 * reading them here — even lazily — would give this file the same
 * environment-validating side effect `@bloombot/config`'s own `CONFIG`
 * proxy has (a missing `PUBLIC_APP_URL`, say, throws), which every existing
 * caller of `answerQuestion` — every test in this package, `@bloombot/discord`'s
 * own test suite, `@bloombot/openai`'s integration test — would suddenly
 * have to satisfy just to answer a question with a `FakeModelClient` and no
 * database concurrency at all. CORE-4's own "dependencies as arguments"
 * rule exists exactly to prevent that: the real, configured gate is built
 * once, from `CONFIG`, by whichever process actually runs concurrent
 * traffic (`apps/bot`'s own `main()`, mirroring how it already builds
 * `model` from `CONFIG.OPENAI_API_KEY`) and handed down through
 * `@bloombot/discord`'s own `HandleMentionDependencies.admission` — this
 * file only has to expose the seam, not decide when it is real.
 *
 * COST-3 — the organization's spending cap is checked in exactly the same
 * place, and for the same reason, D-29 already gives for admission: it runs
 * *before* `reserveUsageSlot`, not merely before `model.ask`, because
 * `usage.ts` has no operation that gives an already-reserved daily slot
 * back. Ordered *after* admission is granted but *before* the allowance is
 * reserved — a request that is still queued behind admission has spent
 * nothing yet (D-29's own "waiting costs nothing" reasoning), so there is
 * nothing to check the cap against until admission itself is settled; and
 * checking the cap before the allowance means a caller who is going to be
 * refused for being over the spending cap never spends a daily request on
 * that refusal either — `declined-over-cap` and `declined-over-limit` are
 * independent refusals, and this ordering is what keeps one from silently
 * consuming the other (COST-3's own "over the cap costs nothing" reading,
 * carried to the daily allowance too). Unlike the allowance, the cap check
 * itself is a plain read (`@bloombot/db`'s own
 * `costLedger.hasReachedSpendingCap`), not a reservation — there is nothing
 * to give back on an early exit because nothing was ever held.
 */

import {
  conversations,
  costLedger,
  courses,
  people,
  usage,
  type Database,
} from '@bloombot/db'
import type { schema } from '@bloombot/db'
import type { AdmissionGate } from '@bloombot/jobs'
import type { Logger } from '@bloombot/logger'

import { ModelAskError, type ModelClient } from './ports.js'
import { computeCost, type PricingTable } from './pricing.js'

/** BOT-5's platform default, applied here — the layer D-13 named as responsible for it — for a course whose `maxRequestsPerDay` was never configured (`null`). */
const DEFAULT_MAX_REQUESTS_PER_DAY = 10 // BOT-5

/**
 * `deps.admission`'s default (this file's own module comment has the full
 * reasoning): always grants immediately, applying no bound. A single,
 * shared, stateless instance — `release` is a no-op, so nothing about
 * sharing it across calls is unsafe the way sharing a real gate's internal
 * counter across unrelated tests would be.
 */
const NO_ADMISSION_LIMIT: AdmissionGate = {
  acquire: async () => ({ granted: true, release: () => {} }),
}

/**
 * `deps.pricing`'s default when a caller omits it — the same "expose the
 * seam, do not decide when it is real" reasoning `NO_ADMISSION_LIMIT` above
 * already follows for admission: an empty rate table prices every model
 * against `defaultRate` alone (`pricing.ts#computeCost`'s own fallback),
 * flagged `estimated` rather than measured. `apps/bot`'s own `main()`
 * builds the real table from `CONFIG.MODEL_PRICING_JSON`
 * (`@bloombot/config`'s `getModelPricingTable`) and hands it down, the same
 * "read `CONFIG` once at startup, thread it through" discipline `model`
 * and `admission` already follow there — `packages/core` itself never
 * reads `@bloombot/config` at all (D-29).
 *
 * `defaultRate` is `0`/`0` on purpose, not a guessed nonzero rate (finding 3
 * of this rework): the seam this constant exposes is meant to be caught by
 * an operator, not papered over with a number that would look like a real
 * estimate. Silent, this default already once meant a whole surface's own
 * spending cap could never fire (`hasReachedSpendingCap` sums exactly the
 * column this default zeroes) — the call site below logs a `warn` every
 * time this default is actually reached, so a caller that forgot to wire
 * `deps.pricing` finds out from its own logs, not from an invoice.
 */
const NO_PRICING_CONFIGURED: PricingTable = {
  rates: {},
  defaultRate: {
    inputMicrosPerMillionTokens: 0,
    outputMicrosPerMillionTokens: 0,
  },
}

/**
 * `deps.addressPerson`'s default when a caller omits it (CORE-7, CORE-8) —
 * the same "expose the seam, default to the *safe* choice rather than a
 * merely convenient one" discipline `NO_ADMISSION_LIMIT`/
 * `NO_PRICING_CONFIGURED` above already hold themselves to, applied to
 * addressing rather than concurrency or cost: a surface that has not
 * decided how to address a person addresses nobody, exactly as CORE-8
 * orders as the last resort of its own fallback — never an internal id,
 * which is the defect this pair of ports fields replaces. This is what
 * makes CORE-7's own "a new surface cannot inherit the bug by doing
 * nothing" true structurally rather than by convention: the dangerous
 * behaviour (build an id-shaped reference and hand it to the model) is not
 * reachable by omission any more, on any surface, including one not yet
 * written.
 */
const NO_ADDRESS: NonNullable<AnswerDependencies['addressPerson']> = () => null

/** What one call to `answerQuestion` needs — the organization, course, person, surface and text CORE-1 names. */
export interface AnswerQuestionInput {
  organizationId: string
  courseId: string
  personId: string
  surface: schema.Surface
  text: string
  /**
   * The text the model is asked, when it differs from `text` (BOT-6, finding
   * 10 of the CORE-1 rework) — a Discord adapter rewrites the bot's own
   * mention token to `@Bloombot` before sending, but `text` still records
   * what the student actually typed, the same split `response_bot.py` keeps
   * between `message.content` (stored) and `message_content` (sent).
   * Defaults to `text` for a surface with nothing to rewrite.
   */
  modelText?: string
  /** `YYYY-MM-DD`, supplied by the caller (CORE-3) — never read from a clock in here, so the day boundary is testable. */
  day: string
  /** DATA-4's Discord context — `null`/absent on every other surface. */
  channelRef?: string | null
  categoryRef?: string | null
}

/** The dependencies the pipeline is handed rather than importing (CORE-4). */
export interface AnswerDependencies {
  db: Database
  model: ModelClient
  logger: Logger
  /** JOB-4's bound on concurrent model calls. Defaults to `NO_ADMISSION_LIMIT` (this file's own module comment) when omitted — a test that wants to observe or control admission passes its own instead, and a real process wires its own configured gate through (`apps/bot`'s own `main()`). */
  admission?: AdmissionGate
  /** COST-1/COST-6's per-model rates, priced against a successful call's own reported tokens. Defaults to `NO_PRICING_CONFIGURED` (this file's own module comment) when omitted — a real process wires the configured table through (`apps/bot`'s own `main()`, from `@bloombot/config`'s `getModelPricingTable`). */
  pricing?: PricingTable
  /**
   * CORE-7 — how the calling surface wants the person addressed, given the
   * person and (when they have one) their identity on this request's own
   * surface; threaded through to `ModelRequest.addressAs` (`ports.ts`).
   * Defaults to `NO_ADDRESS` (this file's own module comment) when omitted:
   * addresses nobody, the safe choice, never an id. `@bloombot/discord`'s
   * own `handleMention` supplies Discord's mention token here — unchanged
   * from before this slice, just moved out of this package, which is meant
   * to know nothing about any one surface's own syntax (CORE-4's rule,
   * applied here to addressing too) — and `apps/api`'s own `routes/chat.ts`
   * supplies CORE-8's fallback order (first name, then display name, then
   * nothing) for the web chat.
   */
  addressPerson?: (
    person: people.Person,
    identity: people.PersonIdentity | undefined
  ) => string | null
}

/**
 * What happened, as a discriminated result rather than a thrown error
 * (CORE-3's brief: "over-limit and model failure are ordinary outcomes here,
 * not exceptions"):
 *  - `answered` — under the allowance, the model answered.
 *  - `answered-last-request` — this request reached the allowance; the
 *    caller still gets an answer, with a notice that it was the day's last
 *    (CORE-3).
 *  - `declined-over-limit` — past the allowance; no model call was made and
 *    nothing was recorded (CORE-3's "costs nothing").
 *  - `declined-over-cap` — COST-3: the organization has already reached its
 *    own spending cap; no model call was made, no allowance was reserved
 *    and nothing was charged — the same "costs nothing" shape
 *    `declined-over-limit` and `declined-busy` both already take, and a
 *    distinct outcome from either so a caller can tell "this course is
 *    busy today" apart from "this organization needs its cap raised"
 *    (this file's own module comment has the full ordering reasoning).
 *  - `declined-busy` — JOB-4: no admission slot became free within the wait
 *    ceiling; no allowance was reserved and nothing was recorded, the same
 *    "costs nothing" treatment `declined-over-limit` gets, and for the same
 *    reason — see this file's own `answerQuestion` comment for why
 *    admission is acquired *before* the allowance is reserved.
 *  - `failed-with-apology` — the model call raised; the reply is a plain
 *    apology pointing at the course's staff (CORE-5). `lastRequestOfDay`
 *    carries the fact this request also reached the allowance (finding 7 of
 *    the CORE-1 rework) — the apology's own text never changes to say so
 *    (it must stay byte-identical to `response_bot.py`'s), but a provider
 *    outage on a student's last request of the day must not leave them
 *    apologised-to *and* silently locked out with no notice at all.
 *  - `course-disabled` — the course exists but is not enabled; ignored, the
 *    same as CORE-2's "no enabled course matched" (finding 1).
 *  - `not-configured` — the course has neither a `promptId` nor
 *    `instructions` to answer with; ignored rather than answered from the
 *    model's general knowledge or sent to the model unguarded (finding 3,
 *    matching `response_bot.py`'s own refusal at `response_bot.py:208`).
 *  - `not-connected` — LINK-1: this person has no connected account yet
 *    (`person.connectedAt` is `null`); invited to connect rather than
 *    answered, before admission or the allowance are ever touched — no
 *    model call, no allowance spent. Carries no text of its own: the
 *    invitation's wording (the panel's address, and nothing else, LINK-2) is
 *    the calling surface's job, the same split every other refusal kind
 *    here already leaves to its caller.
 */
export type AnswerResult =
  | { kind: 'answered'; conversationId: string; text: string }
  | { kind: 'answered-last-request'; conversationId: string; text: string }
  | { kind: 'declined-over-limit' }
  | { kind: 'declined-over-cap' }
  | { kind: 'declined-busy' }
  | {
      kind: 'failed-with-apology'
      conversationId: string
      text: string
      lastRequestOfDay: boolean
    }
  | { kind: 'course-disabled' }
  | { kind: 'not-configured' }
  | { kind: 'not-connected' }

/** CORE-5's apology, matching `response_bot.py`'s own wording — a plain statement, not a stack trace. */
function apologyText(courseTitle: string): string {
  return `Sorry, I can't respond intelligently right now. Please see ${courseTitle} admins for help.`
}

/** CORE-3's last-request notice, matching `response_bot.py`'s own wording, prepended to the model's own answer. */
function withLastRequestNotice(courseTitle: string, answer: string): string {
  return `You have reached the maximum number of responses for today. See ${courseTitle} admins for help. ${answer}`
}

/**
 * Answer one question. In order (CORE-1's brief, as reworked by findings 1,
 * 3 and 8, and by JOB-4, COST-3 and LINK-1):
 *
 * 1. Guard the course itself — disabled, or not configured to answer at all
 *    — before anything else runs, matching `response_bot.py`'s own early
 *    return (`response_bot.py:208`).
 * 2. Guard the person (LINK-1): a person the platform cannot attribute to a
 *    connected account (`person.connectedAt` is `null`) is declined here,
 *    before admission or the allowance are ever touched — cheaper even than
 *    `declined-busy`/`declined-over-limit` below, since this needs no
 *    admission slot at all.
 * 3. Wait for an admission slot (JOB-4), before the allowance is touched at
 *    all. Ordering this ahead of step 5, not around step 7's model call
 *    alone, is deliberate: the alternative — reserve the allowance first,
 *    then wait behind admission — lets a request spend a day's slot while
 *    it is still queued, and a caller that times out waiting (`declined-
 *    busy`, below) would have paid for an answer it never got. There is no
 *    `usage.ts` operation that gives an already-reserved slot back, so
 *    "reserve, then maybe wait" cannot be undone if the wait fails — while
 *    "wait, then reserve" costs nothing when the wait itself is what fails.
 *    The cost of that ordering: a queued request holds no allowance and
 *    counts as nothing yet, so a very busy course could in principle let
 *    more distinct people queue than its daily limit alone would predict,
 *    each waiting its turn rather than one holding a reservation while the
 *    rest are refused outright. JOB-4's own text — "wait for a slot rather
 *    than failing" — is exactly that trade, made on purpose.
 * 4. Check the organization's own spending cap (COST-3), after admission but
 *    before the allowance — this file's own module comment has the full
 *    reasoning for the ordering, the same D-29 shape JOB-4's own step 3
 *    already takes one step earlier.
 * 5. Reserve a slot against the allowance (CORE-3), atomically, before
 *    anything else is read or written, so an over-limit request costs
 *    nothing and two requests racing the model call's own `await` cannot
 *    both be granted (finding 8 — see `packages/db/repos/usage.ts`'s
 *    `reserveUsageSlot`).
 * 6. Record the inbound message (CORE-6) — before the model is asked, so a
 *    question the model never answers is still on the transcript (CORE-5).
 * 7. Ask the model, through the port (CORE-4), and — for a call that
 *    actually landed a response — record its cost (COST-1/COST-2).
 * 8. Record the reply (CORE-6), and return a result.
 *
 * The admission slot step 3 acquired is released in a single `finally`
 * covering steps 4 through 8 as one unit, not the instant step 7's call
 * settles: releasing the moment `model.ask` resolves would mean every early
 * exit between here and there (an over-limit decline, a conversation that
 * fails to open) would also have to remember its own release, and "nothing
 * forgets to release" is worth more than shaving the hold time by the cost
 * of a few synchronous local database writes.
 *
 * CONV-4/D-49 — step 6 and step 8 are no longer among the writes that
 * degrade to a log line: recording the question and recording the reply
 * are what CONV-2's retention guarantee and ADMIN-1's transcript actually
 * rest on, so a failure to write either now propagates out of this
 * function instead of being caught here and continued past. This is a real
 * behaviour change, not only a safety net: `conversations.ts#appendMessage`
 * itself now retries a genuinely transient write conflict before either of
 * these calls ever throws (its own doc comment has the mechanism), so what
 * reaches this function is a failure retrying has already given up on, and
 * "surface it" is the only honest thing left to do with it — an answered
 * student and an unrecorded record of it (the bug this fixes) is worse
 * than a student who sees an error, which every caller already turns into
 * one (`apps/api/src/routes/chat.ts`'s own `.catch(next)`,
 * `apps/bot/src/index.ts`'s own `onMessageCreate(...).catch(...)`), not a
 * silently wrong transcript.
 *
 * The cost ledger entry (step 7) and the model's own upstream thread id are
 * unchanged: neither is retention data an instructor can be required to
 * produce (COST-1/CONV-2's own scope, respectively) — losing either still
 * degrades to a log line here, the same as before this slice.
 */
export async function answerQuestion(
  input: AnswerQuestionInput,
  deps: AnswerDependencies
): Promise<AnswerResult> {
  const { organizationId, courseId, personId, surface, text, day } = input
  const modelText = input.modelText ?? text
  const { db, model, logger } = deps

  const course = courses.getCourse(organizationId, courseId, db)
  if (!course) {
    throw new Error(
      `answerQuestion: course ${courseId} does not exist in organization ${organizationId}`
    )
  }

  // Finding 1 — a disabled course is reached here directly by a web/MCP
  // caller that never passed through CORE-2's routing (routing's own filter
  // covers only the Discord adapter). Guarded before any allowance check or
  // write, the same "ignored, not answered" treatment CORE-2 gives it.
  if (!course.enabled) {
    logger.info(
      { organizationId, courseId, personId },
      'answerQuestion: declined, course is disabled'
    )
    return { kind: 'course-disabled' }
  }

  // Finding 3 — neither escape hatch is set, so there is nothing to answer
  // with: sending the request anyway would either answer from the model's
  // general knowledge (CORE-2 forbids this) or fail at the adapter having
  // already spent a request. Matches `response_bot.py:208`'s own refusal.
  if (!course.promptId && !course.instructions) {
    logger.info(
      { organizationId, courseId, personId },
      'answerQuestion: declined, course has neither a promptId nor instructions configured'
    )
    return { kind: 'not-configured' }
  }

  // Resolved once, here, rather than only later for the model's opening item
  // (finding 1 of the MDL-1 rework, D-16) — `person` cannot come back empty:
  // PPL-3 already created this person before `personId` ever reached this
  // function, the same trust CORE-2/PPL-3 hold everywhere else in this file.
  const person = people.getPerson(organizationId, personId, db)
  if (!person) {
    throw new Error(
      `answerQuestion: person ${personId} does not exist in organization ${organizationId}`
    )
  }

  // LINK-1/LINK-2 — an identity the platform cannot attribute to a connected
  // account is invited to connect, not answered: no model call, no allowance
  // spent (checked here, before admission and the allowance, the same
  // "costs nothing" shape `declined-over-limit`/`declined-busy` below
  // already take — cheaper still, since this needs no admission slot at
  // all). `person.connectedAt` is set exactly once, by `@bloombot/db`'s
  // `people.ts#markConnected` — reached from `connectIdentity` when a proof
  // attaches a brand-new identity, and from `mergePeople` when that proof
  // merges two records (LINK-3, LINK-4). Never by an address match (PPL-4),
  // and never moved once written.
  // The invitation's own wording (the panel's address, and nothing else) is
  // the surface's job, not this pipeline's (`answerQuestion` returns kinds,
  // never rendered text — the same split CORE-5/SURF-6's other refusals
  // already use), so this returns a bare kind for whichever adapter called
  // this to render.
  if (person.connectedAt === null) {
    logger.info(
      { organizationId, courseId, personId },
      'answerQuestion: declined, person is not yet connected to a verified account'
    )
    return { kind: 'not-connected' }
  }

  // JOB-4 — waits for a slot, up to the configured ceiling, before the
  // allowance is touched at all (this function's own module comment has
  // the ordering reasoning). Declining here costs nothing: no reservation,
  // no conversation, no write, no model call — the same "costs nothing"
  // shape `declined-over-limit` below already takes.
  const admission = deps.admission ?? NO_ADMISSION_LIMIT
  const admitted = await admission.acquire()
  if (!admitted.granted) {
    logger.info(
      { organizationId, courseId, personId },
      'answerQuestion: declined, no admission slot became free within the wait ceiling'
    )
    return { kind: 'declined-busy' }
  }

  // JOB-4 — everything from here through the end of this function runs
  // with the admission slot above held; `finally` releases it once this
  // whole block finishes, success, decline or throw alike (this function's
  // own module comment says why this is one release rather than one per
  // early exit).
  try {
    // COST-3 — the organization's own spending cap, checked here: after
    // admission (a queued request has spent nothing yet to check a cap
    // against) but before the allowance is reserved (this file's own
    // module comment has the full ordering reasoning). A plain read, not a
    // reservation — `hasReachedSpendingCap` holds nothing that needs
    // releasing, so an early return here is as cheap as `declined-busy`'s
    // own.
    if (costLedger.hasReachedSpendingCap(organizationId, db)) {
      logger.info(
        { organizationId, courseId, personId },
        'answerQuestion: declined, organization has reached its spending cap'
      )
      return { kind: 'declined-over-cap' }
    }

    // BOT-5's default, applied here (D-13 named this the layer responsible for
    // it): a course that never configured `maxRequestsPerDay` is capped at
    // `DEFAULT_MAX_REQUESTS_PER_DAY`, not left unlimited.
    const limit = course.maxRequestsPerDay ?? DEFAULT_MAX_REQUESTS_PER_DAY

    // CORE-3/finding 8 — the allowance check and the count that enforces it
    // are the same atomic statement, reserved before the model is ever asked:
    // an over-limit request costs nothing (no conversation, no write, no
    // model call), and two requests from the same person arriving close
    // together cannot both be granted by racing the `await` below.
    const reservation = usage.reserveUsageSlot(
      organizationId,
      courseId,
      personId,
      day,
      limit,
      db
    )
    if (!reservation) {
      throw new Error(
        `answerQuestion: could not reserve a usage slot for course ${courseId} and person ${personId} in organization ${organizationId}`
      )
    }
    if (!reservation.granted) {
      logger.info(
        { organizationId, courseId, personId, day, limit },
        'answerQuestion: declined, daily allowance already exhausted'
      )
      return { kind: 'declined-over-limit' }
    }
    // This request reaches (but does not pass) the allowance — known now,
    // before the model is asked, so it can be carried on whichever result
    // comes back, including a failed one (finding 7).
    const isLastRequestOfDay = reservation.count === limit

    const conversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId, personId, surface },
      db
    )
    if (!conversation) {
      throw new Error(
        `answerQuestion: could not open a conversation for course ${courseId} and person ${personId} in organization ${organizationId}`
      )
    }

    // CORE-1/CORE-6 — recorded before the model is asked, so it is on the
    // transcript even if the model call below fails (CORE-5). DATA-4's
    // Discord context travels with it, the same as the reply below (finding
    // 6) — both directions of one exchange carry the same context.
    //
    // CONV-4/D-49 — deliberately not wrapped in a `try`/`catch` that
    // continues: writing the question is part of answering it, not a side
    // effect of answering it. A write `appendMessage`'s own retry cannot
    // recover throws straight out of `answerQuestion`, before the model is
    // ever asked (this function's own module comment has the full
    // reasoning) — the allowance reserved above is still spent (there is
    // no `usage.ts` operation that gives it back), the same cost a model
    // failure already pays under `failed-with-apology` below, paid here one
    // step earlier. Smaller than the alternative: answering a question this
    // platform then has no record was ever asked.
    conversations.appendMessage(
      organizationId,
      conversation.id,
      {
        direction: 'from_person',
        content: text,
        surface,
        channelRef: input.channelRef ?? null,
        categoryRef: input.categoryRef ?? null,
      },
      db
    )

    // Finding 1 of the MDL-1 rework (D-16) — `person` was already resolved
    // above (the LINK-1 gate needed it first); reused here so a new upstream
    // conversation's opening item can say who is asking and which course
    // they are in, the same information `response_bot.py` seeds with
    // (`response_bot.py:262-269`) — a display name simply not merged in yet
    // reads as `null`, which the port's own contract already treats as
    // "seed without one".
    const identity = people.getPersonIdentity(
      organizationId,
      personId,
      surface,
      db
    )

    // CORE-7 — the calling surface decides how, or whether, to address this
    // person (`deps.addressPerson`, defaulting to `NO_ADDRESS` above when
    // omitted); this package builds neither Discord's mention token nor any
    // other surface's own syntax itself any more.
    const addressAs = (deps.addressPerson ?? NO_ADDRESS)(person, identity)

    // CORE-4 — the model is asked through the port, never a vendor SDK.
    // `modelText` (finding 10), not `text`: a surface may have rewritten the
    // question before sending it (BOT-6's mention rewriting) without that
    // rewrite reaching the transcript above.
    let replyText: string
    let newUpstreamThreadId: string | null = null
    let failed = false
    try {
      const modelAnswer = await model.ask({
        promptId: course.promptId,
        instructions: course.instructions,
        vectorStoreId: course.vectorStoreId,
        model: course.model,
        upstreamThreadId: conversation.upstreamThreadId,
        question: modelText,
        displayName: person?.displayName ?? null,
        courseTitle: course.title,
        // MDL-4 — genuinely opaque (`ports.ts`'s own comment on the split):
        // the raw identity, never rendered to a person, for a later
        // transcript read.
        personIdentifier: identity?.externalId ?? null,
        addressAs,
      })
      replyText = isLastRequestOfDay
        ? withLastRequestNotice(course.title, modelAnswer.text)
        : modelAnswer.text
      newUpstreamThreadId = modelAnswer.upstreamThreadId

      // COST-1/COST-2 — recorded for every call that actually landed a
      // response, whether or not the provider reported usage for it
      // (COST-6's own estimate path, `pricing.ts#computeCost`). A call that
      // threw below (the `catch` this `try` feeds) never reaches here: there
      // is no answer, and — for a plain thrown error, as opposed to
      // `ModelAskError`'s own already-minted conversation — nothing this
      // adapter reported actually happened to price, the same "nothing to
      // give back because nothing was reserved" reasoning this function's
      // own module comment gives the cap check above. Wrapped like every
      // other write in this function (CORE-6): a broken ledger write
      // degrades to a log line, never a lost answer.
      try {
        // Finding 3 of this rework — a caller that never wires `deps.pricing`
        // at all gets `NO_PRICING_CONFIGURED` (this file's own module
        // comment), which prices every call at zero and — because
        // `hasReachedSpendingCap` sums exactly that column — quietly
        // disables the organization's own spending cap for every call this
        // surface makes. `apps/bot` always wires the real table today, so
        // this branch does not fire in production yet, but the web chat and
        // MCP surfaces this file's own module comment already names as
        // future callers are not required to, and nothing before this log
        // line would have told an operator that. Logged once per call
        // rather than once per process: cheap, and a busy surface running
        // unconfigured makes that plain in the logs immediately rather than
        // waiting on a cap that will never fire to be noticed at all.
        if (!deps.pricing) {
          logger.warn(
            { organizationId, courseId, personId },
            'answerQuestion: no pricing table configured — every call is being priced at zero and this organization’s spending cap will never fire until one is wired through (see deps.pricing)'
          )
        }
        const priced = computeCost(
          modelAnswer.model,
          modelAnswer.usage,
          deps.pricing ?? NO_PRICING_CONFIGURED,
          { question: modelText, answer: modelAnswer.text }
        )
        costLedger.recordCostLedgerEntry(
          organizationId,
          {
            courseId,
            personId,
            model: modelAnswer.model,
            inputTokens: priced.inputTokens,
            outputTokens: priced.outputTokens,
            costMicros: priced.costMicros,
            measurement: priced.measurement,
          },
          db
        )
      } catch (error) {
        logger.error(
          { err: error, organizationId, courseId, personId },
          'answerQuestion: failed to record the cost ledger entry'
        )
      }
    } catch (error) {
      // CORE-5 — logged with its cause, and the reply degrades to a plain
      // apology rather than silence or the raw error reaching the person.
      logger.error(
        { err: error, organizationId, courseId, personId },
        'answerQuestion: model call failed'
      )
      replyText = apologyText(course.title)
      failed = true
      // Finding 6 of the MDL-1 rework — a call that already minted a new
      // upstream conversation id before failing must not orphan it:
      // `ModelAskError` (`ports.ts`) carries the id across the throw, and the
      // write below persists it exactly the way a successful call's own id
      // is persisted, so the next turn resumes it instead of creating (and
      // failing to use) yet another one.
      if (error instanceof ModelAskError) {
        newUpstreamThreadId = error.upstreamThreadId
      }
    }

    // CONV-1 — "the model's own context can be resumed" (D-13's own text for
    // why this write exists at all). Finding 4: a database write failing
    // here still degrades to a log line rather than losing the answer the
    // model already produced — the allowance was already reserved above,
    // so nothing here can cost more than an un-resumable next turn.
    // CONV-4/D-49 — unlike the two `appendMessage` calls this used to sit
    // between (this function's own module comment explains the split): the
    // upstream thread id is a resumption pointer, not retention data
    // CONV-2/ADMIN-1 require, so losing it costs a fresh upstream
    // conversation next turn, never a hole in a transcript.
    if (newUpstreamThreadId) {
      try {
        conversations.setUpstreamThreadId(
          organizationId,
          conversation.id,
          newUpstreamThreadId,
          db
        )
      } catch (error) {
        logger.error(
          { err: error, organizationId, conversationId: conversation.id },
          'answerQuestion: failed to record the upstream thread id'
        )
      }
    }

    // CORE-6 — recorded after the model call regardless of outcome (a
    // failed call's own apology, `replyText`, still gets a transcript
    // entry — CORE-5). DATA-4's Discord context travels with the reply
    // too (finding 6), not just the question.
    //
    // CONV-4/D-49 — not wrapped, for the same reason the question's own
    // `appendMessage` above is not (this function's own module comment has
    // the full reasoning): the model has already answered by the time this
    // runs, so a write that still fails after `appendMessage`'s own retry
    // means this function throws *after* paying for the call — a real
    // cost, named here rather than hidden, and the same one a model
    // failure already pays under `failed-with-apology` (both reach this
    // point with the allowance already spent and nothing to show for it
    // once caller-side error handling takes over). The alternative this
    // slice rejects is cheaper for this one request and wrong for what
    // CONV-2/ADMIN-1 promise: a reply the student received with no record
    // it was ever sent.
    conversations.appendMessage(
      organizationId,
      conversation.id,
      {
        direction: 'to_person',
        content: replyText,
        surface,
        channelRef: input.channelRef ?? null,
        categoryRef: input.categoryRef ?? null,
      },
      db
    )

    if (failed) {
      return {
        kind: 'failed-with-apology',
        conversationId: conversation.id,
        text: replyText,
        lastRequestOfDay: isLastRequestOfDay,
      }
    }

    // BOT-10 — the one INFO line a surface cannot reproduce on its own: only
    // this function knows both the count `reserveUsageSlot` just granted and
    // the limit it was granted against.
    logger.info(
      {
        organizationId,
        courseId,
        personId,
        conversationId: conversation.id,
        promptId: course.promptId,
        answer: replyText,
        count: reservation.count,
        limit,
      },
      'answerQuestion: answered'
    )

    return {
      kind: isLastRequestOfDay ? 'answered-last-request' : 'answered',
      conversationId: conversation.id,
      text: replyText,
    }
  } finally {
    admitted.release()
  }
}
