/**
 * WEB-10: the web chat surface. A signed-in account holds a conversation
 * with one of its own courses' assistants, through the exact same
 * `@bloombot/core#answerQuestion` pipeline the Discord surface calls
 * (`@bloombot/discord`'s `handleMention`) — this router is a different
 * adapter, not a different brain, the same split `discord-servers.ts`'s
 * own module comment already draws for the Discord install flow.
 *
 * Not mounted under `routes/actions.ts`'s generic dispatcher, and for the
 * same reason that file gives for the Discord install flow: every action
 * `dispatch` runs resolves the caller's *organization* from their own
 * *membership* (`memberships.getMembership`) — an instructor's own
 * relationship to a tenant. The person asking a course a question is not
 * necessarily any such thing; ENRL-1..6 already draws the enrolment
 * relation as a separate concept from a membership on purpose (ENRL-5: "a
 * Discord role confers none of [staff authority]"), and this router
 * authorizes against exactly that — an active enrolment
 * (`enrolments.getActiveEnrolment`) — rather than a membership row.
 *
 * **Person resolution.** `people.resolvePersonByIdentity` is the same
 * "create on demand" function every other surface's first contact already
 * uses (PPL-3) — Discord's own `handle-mention.ts` resolves a person the
 * identical way, from the arriving Discord user id. Here the "identity" is
 * the caller's own already-authenticated account id, on the `'web'`
 * surface. This is deliberately *not* the account-linking machinery
 * `LINK-1..5` describes (a person proven to hold more than one surface
 * identity, merged into one so their allowance and transcript follow them
 * everywhere) — that is a distinct, larger feature landing separately (see
 * `docs/DECISIONS.md`), and nothing here reads or writes a `connectedAt`
 * column. What this router gives a signed-in account today is exactly
 * what PPL-3 already gives any other first-time identity: a person of
 * their own, in this organization, admitted into a course only through one
 * of ENRL-3's three ordinary paths (a Discord role, a roster row, or a
 * redeemed join link) — nothing here enrols anybody, so a fresh account
 * asking before an instructor has admitted them any of those three ways
 * sees an empty course list, the same "not found" ENRL-2 already gives a
 * course a person is not enrolled in.
 */

import { Router, type Request } from 'express'
import { z } from 'zod'

import {
  answerQuestion,
  type ModelClient,
  type PricingTable,
} from '@bloombot/core'
import { conversations, enrolments, people, type Database } from '@bloombot/db'
import type { AdmissionGate } from '@bloombot/jobs'
import type { Logger } from '@bloombot/logger'

export interface ChatRouterDependencies {
  db: Database
  logger: Logger
  model: ModelClient
  admission?: AdmissionGate
  pricing?: PricingTable
}

/** `YYYY-MM-DD`, in the process's own local time zone — the same "read the clock once, at the edge" shape `apps/bot`'s own `today.ts` follows, and CORE-3's own "never read from a clock inside the pipeline" discipline that file's doc comment describes. Duplicated rather than imported: `apps/bot` and this app are on opposite sides of the app/app boundary this repo does not cross for a five-line helper neither owns — the same convention `apps/worker`'s own `roster-import.ts` already holds itself to for its own small duplicated helpers. */
function today(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** One message on the transcript, as this router hands it to the browser — `role` rather than `messages.direction`'s own `from_person`/`to_person`, the vocabulary a chat UI actually reads in. */
interface ChatMessageView {
  id: string
  role: 'student' | 'assistant'
  text: string
  createdAt: number
}

function toChatMessageView(message: conversations.Message): ChatMessageView {
  return {
    id: message.id,
    role: message.direction === 'from_person' ? 'student' : 'assistant',
    text: message.content,
    createdAt: message.createdAt,
  }
}

/**
 * `req.session.accountId` — TypeScript cannot carry this router's own
 * `router.use` guard's narrowing across into a separately-declared route
 * handler (`req.session` stays `ValidSession | undefined` in every
 * handler's own type), so each handler below re-checks rather than
 * asserting with `!`. Unreachable in practice (the guard above already
 * ran first for every request that reaches these handlers) — guarded
 * rather than assumed regardless, the same discipline this file's own
 * `getOrCreateConversation` check just below already holds itself to.
 */
function requireAccountId(req: Request): string | undefined {
  return req.session?.accountId
}

/**
 * Resolve the caller's own person record for `organizationId` — every
 * route below needs one, and every one of them resolves it the same way
 * (this module's own comment on why `resolvePersonByIdentity` and not
 * something LINK-shaped).
 */
function resolveCallerPerson(
  organizationId: string,
  accountId: string,
  db: Database
) {
  return people.resolvePersonByIdentity(
    organizationId,
    { surface: 'web', externalId: accountId },
    db
  )
}

export function buildChatRouter(deps: ChatRouterDependencies): Router {
  const router = Router({ mergeParams: true })

  // API-1's own "no session, no [answer]" — a chat route is reachable by
  // exactly the same signed-in-or-not gate `routes/actions.ts` applies,
  // even though what happens past it is authorized differently (this
  // file's own module comment).
  router.use((req, res, next) => {
    if (!req.session) {
      res.status(401).json({ error: 'not_signed_in' })
      return
    }
    next()
  })

  /** ENRL-1/ENRL-2: the courses this account may ask in this organization — its own active enrolments, and no others. */
  router.get<{ organizationId: string }>('/courses', (req, res) => {
    const organizationId = req.params.organizationId
    const accountId = requireAccountId(req)
    if (!accountId) {
      res.status(401).json({ error: 'not_signed_in' })
      return
    }
    const person = resolveCallerPerson(organizationId, accountId, deps.db)
    const courses = enrolments.listCoursesForPerson(
      organizationId,
      person.id,
      deps.db
    )
    res.status(200).json({
      courses: courses.map((course) => ({
        id: course.id,
        title: course.title,
      })),
    })
  })

  /** ENRL-2: this account's own transcript with one course — refused, exactly like any other unauthorized read (TEN-5), when it is not enrolled. */
  router.get<{ organizationId: string; courseId: string }>(
    '/courses/:courseId/messages',
    (req, res) => {
      const { organizationId, courseId } = req.params
      const accountId = requireAccountId(req)
      if (!accountId) {
        res.status(401).json({ error: 'not_signed_in' })
        return
      }
      const person = resolveCallerPerson(organizationId, accountId, deps.db)
      const enrolment = enrolments.getActiveEnrolment(
        organizationId,
        courseId,
        person.id,
        deps.db
      )
      if (!enrolment) {
        res.status(404).json({ error: 'chat_course_not_found' })
        return
      }
      const conversation = conversations.getOrCreateConversation(
        organizationId,
        { courseId, personId: person.id, surface: 'web' },
        deps.db
      )
      // Unreachable in practice — the enrolment above already proved this
      // course and person both belong to this organization — but guarded
      // rather than assumed, the same race `discord-servers.ts`'s own
      // `removeDiscordServerAction` documents for a concurrent change.
      if (!conversation) {
        res.status(404).json({ error: 'chat_course_not_found' })
        return
      }
      const transcript = conversations.getTranscript(
        organizationId,
        conversation.id,
        deps.db
      )
      res.status(200).json({ messages: transcript.map(toChatMessageView) })
    }
  )

  const postMessageInputSchema = z.object({ text: z.string().min(1) })

  /** WEB-10: ask a question, through the same `answerQuestion` pipeline the Discord surface calls. */
  router.post<{ organizationId: string; courseId: string }>(
    '/courses/:courseId/messages',
    (req, res, next) => {
      const { organizationId, courseId } = req.params
      const accountId = requireAccountId(req)
      if (!accountId) {
        res.status(401).json({ error: 'not_signed_in' })
        return
      }
      const parsed = postMessageInputSchema.safeParse(req.body)
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: 'action_input_invalid', issues: parsed.error.issues })
        return
      }

      const person = resolveCallerPerson(organizationId, accountId, deps.db)
      const enrolment = enrolments.getActiveEnrolment(
        organizationId,
        courseId,
        person.id,
        deps.db
      )
      if (!enrolment) {
        res.status(404).json({ error: 'chat_course_not_found' })
        return
      }

      answerQuestion(
        {
          organizationId,
          courseId,
          personId: person.id,
          surface: 'web',
          text: parsed.data.text,
          day: today(),
        },
        {
          db: deps.db,
          model: deps.model,
          logger: deps.logger,
          ...(deps.admission ? { admission: deps.admission } : {}),
          ...(deps.pricing ? { pricing: deps.pricing } : {}),
        }
      )
        .then((result) => res.status(200).json({ result }))
        .catch(next)
    }
  )

  return router
}
