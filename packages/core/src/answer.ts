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
 */

import { conversations, courses, usage, type Database } from '@bloombot/db'
import type { schema } from '@bloombot/db'
import type { Logger } from '@bloombot/logger'

import type { ModelClient } from './ports.js'

/** What one call to `answerQuestion` needs — the organization, course, person, surface and text CORE-1 names. */
export interface AnswerQuestionInput {
  organizationId: string
  courseId: string
  personId: string
  surface: schema.Surface
  text: string
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
 *  - `failed-with-apology` — the model call raised; the reply is a plain
 *    apology pointing at the course's staff (CORE-5).
 */
export type AnswerResult =
  | { kind: 'answered'; conversationId: string; text: string }
  | { kind: 'answered-last-request'; conversationId: string; text: string }
  | { kind: 'declined-over-limit' }
  | { kind: 'failed-with-apology'; conversationId: string; text: string }

/** CORE-5's apology, matching `response_bot.py`'s own wording — a plain statement, not a stack trace. */
function apologyText(courseTitle: string): string {
  return `Sorry, I can't respond intelligently right now. Please see ${courseTitle} admins for help.`
}

/** CORE-3's last-request notice, matching `response_bot.py`'s own wording, prepended to the model's own answer. */
function withLastRequestNotice(courseTitle: string, answer: string): string {
  return `You have reached the maximum number of responses for today. See ${courseTitle} admins for help. ${answer}`
}

/**
 * Answer one question. In order (CORE-1's brief):
 *
 * 1. Check the allowance (CORE-3) — before anything else is read or
 *    written, so an over-limit request costs nothing.
 * 2. Record the inbound message (CORE-6) — before the model is asked, so a
 *    question the model never answers is still on the transcript (CORE-5).
 * 3. Ask the model, through the port (CORE-4).
 * 4. Record the reply (CORE-6) and the day's usage, and return a result.
 *
 * A failure to record (step 2 or step 4) is logged and never stops the
 * reply (CORE-6): both `appendMessage` calls below are wrapped so a broken
 * transcript write degrades to a log line, not a lost answer.
 */
export async function answerQuestion(
  input: AnswerQuestionInput,
  deps: AnswerDependencies
): Promise<AnswerResult> {
  const { organizationId, courseId, personId, surface, text, day } = input
  const { db, model, logger } = deps

  const course = courses.getCourse(organizationId, courseId, db)
  if (!course) {
    throw new Error(
      `answerQuestion: course ${courseId} does not exist in organization ${organizationId}`
    )
  }

  // CORE-3 — checked first, against the count already on record, before any
  // read or write below runs. `limit === null` means the course has not set
  // one (`hasExhaustedDailyLimit`'s own tri-state comment, `repos/usage.ts`)
  // — nothing is ever declined for a course with no configured allowance.
  const limit = course.maxRequestsPerDay
  const usedBefore = usage.getUsageCount(
    organizationId,
    courseId,
    personId,
    day,
    db
  )
  if (limit !== null && usedBefore >= limit) {
    logger.info(
      { organizationId, courseId, personId, day, usedBefore, limit },
      'answerQuestion: declined, daily allowance already exhausted'
    )
    return { kind: 'declined-over-limit' }
  }
  // This request, once counted, reaches (but does not pass) the allowance —
  // decided here, from the count already on record, rather than from
  // `incrementUsage`'s return value below, so it does not depend on the
  // model call having succeeded.
  const isLastRequestOfDay = limit !== null && usedBefore + 1 === limit

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
  // transcript even if the model call below fails (CORE-5).
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

  // CORE-4 — the model is asked through the port, never a vendor SDK.
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
      question: text,
    })
    replyText = isLastRequestOfDay
      ? withLastRequestNotice(course.title, modelAnswer.text)
      : modelAnswer.text
    newUpstreamThreadId = modelAnswer.upstreamThreadId
  } catch (error) {
    // CORE-5 — logged with its cause, and the reply degrades to a plain
    // apology rather than silence or the raw error reaching the person.
    logger.error(
      { err: error, organizationId, courseId, personId },
      'answerQuestion: model call failed'
    )
    replyText = apologyText(course.title)
    failed = true
  }

  if (newUpstreamThreadId) {
    conversations.setUpstreamThreadId(
      organizationId,
      conversation.id,
      newUpstreamThreadId,
      db
    )
  }

  // CORE-6 — recorded after the model call regardless of outcome, and a
  // failure to record here still returns the reply below.
  try {
    conversations.appendMessage(
      organizationId,
      conversation.id,
      { direction: 'to_person', content: replyText, surface },
      db
    )
  } catch (error) {
    logger.error(
      { err: error, organizationId, conversationId: conversation.id },
      'answerQuestion: failed to record the reply'
    )
  }

  // The day's count moves forward whether the model answered or failed —
  // matching `response_bot.py`, whose own counter update runs unconditionally
  // after the try/except around its OpenAI call (the brief's "where the new
  // requirements are silent, match what the bot does today"; see
  // docs/DECISIONS.md). Never incremented on the `declined-over-limit` path
  // above, which returns before reaching here.
  usage.incrementUsage(organizationId, courseId, personId, day, db)

  if (failed) {
    return {
      kind: 'failed-with-apology',
      conversationId: conversation.id,
      text: replyText,
    }
  }
  return {
    kind: isLastRequestOfDay ? 'answered-last-request' : 'answered',
    conversationId: conversation.id,
    text: replyText,
  }
}
