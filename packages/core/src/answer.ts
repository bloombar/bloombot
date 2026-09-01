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
 */
const NO_PRICING_CONFIGURED: PricingTable = {
  rates: {},
  defaultRate: {
    inputMicrosPerMillionTokens: 0,
    outputMicrosPerMillionTokens: 0,
  },
}

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
 * 3 and 8, and by JOB-4 and COST-3):
 *
 * 1. Guard the course itself — disabled, or not configured to answer at all
 *    — before anything else runs, matching `response_bot.py`'s own early
 *    return (`response_bot.py:208`).
 * 2. Wait for an admission slot (JOB-4), before the allowance is touched at
 *    all. Ordering this ahead of step 4, not around step 6's model call
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
 * 3. Check the organization's own spending cap (COST-3), after admission but
 *    before the allowance — this file's own module comment has the full
 *    reasoning for the ordering, the same D-29 shape JOB-4's own step 2
 *    already takes one step earlier.
 * 4. Reserve a slot against the allowance (CORE-3), atomically, before
 *    anything else is read or written, so an over-limit request costs
 *    nothing and two requests racing the model call's own `await` cannot
 *    both be granted (finding 8 — see `packages/db/repos/usage.ts`'s
 *    `reserveUsageSlot`).
 * 5. Record the inbound message (CORE-6) — before the model is asked, so a
 *    question the model never answers is still on the transcript (CORE-5).
 * 6. Ask the model, through the port (CORE-4), and — for a call that
 *    actually landed a response — record its cost (COST-1/COST-2).
 * 7. Record the reply (CORE-6), and return a result.
 *
 * The admission slot step 2 acquired is released in a single `finally`
 * covering steps 3 through 7 as one unit, not the instant step 6's call
 * settles: releasing the moment `model.ask` resolves would mean every early
 * exit between here and there (an over-limit decline, a conversation that
 * fails to open) would also have to remember its own release, and "nothing
 * forgets to release" is worth more than shaving the hold time by the cost
 * of a few synchronous local database writes.
 *
 * A failure to record (step 5 or step 7), the cost ledger entry (step 6),
 * or to persist the model's own upstream thread id, is logged and never
 * stops the reply (CORE-6): every
 * write from here on is wrapped so a broken database write degrades to a
 * log line, not a lost answer.
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
    try {
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
    } catch (error) {
      logger.error(
        { err: error, organizationId, conversationId: conversation.id },
        'answerQuestion: failed to record the inbound message'
      )
    }

    // Finding 1 of the MDL-1 rework (D-16) — resolved once per turn so a new
    // upstream conversation's opening item can say who is asking and which
    // course they are in, the same information `response_bot.py` seeds with
    // (`response_bot.py:262-269`). `getPerson` cannot come back empty here:
    // PPL-3 already created this person before `personId` ever reached this
    // function, the same trust CORE-2/PPL-3 hold everywhere else in this
    // file — a display name simply not merged in yet reads as `null`, which
    // the port's own contract already treats as "seed without one".
    const person = people.getPerson(organizationId, personId, db)
    const identity = people.getPersonIdentity(
      organizationId,
      personId,
      surface,
      db
    )

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
        personRef: identity ? `<@${identity.externalId}>` : null,
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
        const priced = computeCost(
          modelAnswer.model,
          modelAnswer.usage,
          deps.pricing ?? NO_PRICING_CONFIGURED
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
    // why this write exists at all). Finding 4: guarded like the two
    // `appendMessage` calls around it, so a database write failing here
    // degrades to a log line rather than losing the answer the model already
    // produced — the allowance was already reserved above, so nothing here
    // can cost more than an un-resumable next turn.
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

    // CORE-6 — recorded after the model call regardless of outcome, and a
    // failure to record here still returns the reply below. DATA-4's Discord
    // context travels with the reply too (finding 6), not just the question.
    try {
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
    } catch (error) {
      logger.error(
        { err: error, organizationId, conversationId: conversation.id },
        'answerQuestion: failed to record the reply'
      )
    }

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
