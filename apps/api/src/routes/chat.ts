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
 * **Person resolution — rework, D-37.** This router used to resolve the
 * caller with `people.resolvePersonByIdentity` — create on demand, PPL-3's
 * own first-contact shape. That was wrong for this surface specifically,
 * for three reasons a review round caught together: it minted a *second*,
 * never-connected person for every visit (LINK-5's "one person, one
 * allowance" broken in practice, and — now that LINK-1 has merged —
 * `answerQuestion` declines every one of them outright, `connectedAt`
 * always `null`); it could never find the enrolment a real student already
 * has, because every real enrolment belongs to the *discord*-surface person
 * a roster import or a Discord role admitted, never to a freshly-minted web
 * one; and calling a *creating* function on a raw, unchecked
 * `:organizationId` URL param let any signed-in caller write a `people` row
 * into an organization they have no relationship to at all, before
 * anything checked that they should be able to.
 *
 * The fix: a signed-in web caller *is* the account — they proved control of
 * it by signing in, which is exactly the proof LINK-3 asks of every other
 * surface's own connect step. `@bloombot/auth`'s `sign-in.ts` now creates
 * and *connects* that account's own web person the moment the account
 * itself is (`createConnectedWebPerson`, in the account's own personal
 * organization) — through the real `people.ts#connectIdentity` path, not a
 * raw `connectedAt` write, so it merges with a Discord or MCP identity
 * later exactly the way any other connected person does. This router only
 * ever *looks up* that person (`people.resolveIdentity` — read-only, no
 * insert, so no way to write into an organization the caller merely named
 * in a URL) and refuses with the same "invited to connect" shape LINK-1
 * gives every other unconnected identity when there is none, or when
 * `connectedAt` is somehow still `null`. See `docs/DECISIONS.md` for the
 * fuller account, including what this does and does not make reachable
 * today (a course admitted only through a Discord role or a roster import
 * still needs the join-link/connect flow neither this router nor
 * `sign-in.ts` builds).
 */

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'

import {
  answerQuestion,
  type ModelClient,
  type PricingTable,
} from '@bloombot/core'
import {
  conversations,
  enrolments,
  organizations,
  people,
  type Database,
} from '@bloombot/db'
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
 * rather than assumed regardless, the same discipline this file's own GET
 * transcript handler already holds its own `conversation` lookup to below.
 */
function requireAccountId(req: Request): string | undefined {
  return req.session?.accountId
}

/**
 * Resolve the caller's own, already-connected person for `organizationId` —
 * every route below needs one, and every one of them resolves it the same
 * way (this module's own comment on why `resolveIdentity`, read-only, and
 * not `resolvePersonByIdentity`).
 *
 * Checks the organization exists *before* anything else — TEN-5's own
 * "indistinguishable from absence": without this, a nonexistent
 * `organizationId` reached `resolveIdentity`'s own query and (with the old
 * `resolvePersonByIdentity`) an *insert* whose foreign key then failed,
 * which answered `500` where every other foreign or absent id in this app
 * answers `404` — an oracle a caller could use to tell "this organization
 * exists but I have no relationship to it" apart from "this organization
 * does not exist at all". Both now take the identical path: no person
 * found, refused the identical way.
 *
 * `undefined` when the organization does not exist, when this account has
 * no person here at all, or when it has one whose `connectedAt` is still
 * `null` (defensive — nothing in this codebase can produce that state for
 * a web identity today, since `connectIdentity` always sets it, but this
 * router does not rely on that holding forever).
 */
function resolveConnectedCallerPerson(
  organizationId: string,
  accountId: string,
  db: Database
): people.Person | undefined {
  if (!organizations.getOrganizationById(organizationId, db)) return undefined
  const person = people.resolveIdentity(
    organizationId,
    { surface: 'web', externalId: accountId },
    db
  )
  if (!person || person.connectedAt === null) return undefined
  return person
}

/** LINK-1's own refusal shape, reused here — a caller with no connected person in this organization gets the same "invited to connect" outcome `answerQuestion`'s own `not-connected` result gives a Discord or MCP identity that has never proven itself, not a misleading "you are not enrolled" (this account may never have been offered a way to enrol at all). */
function sendNotConnected(res: Response): void {
  res.status(404).json({ error: 'chat_not_connected' })
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
    const person = resolveConnectedCallerPerson(
      organizationId,
      accountId,
      deps.db
    )
    if (!person) {
      sendNotConnected(res)
      return
    }
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
      const person = resolveConnectedCallerPerson(
        organizationId,
        accountId,
        deps.db
      )
      if (!person) {
        sendNotConnected(res)
        return
      }
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
      // Rework finding — this used to call `getOrCreateConversation`
      // here, which meant *reading* a transcript that had never been
      // asked anything yet silently created a `conversations` row: a
      // `GET` that writes, breaking the invariant `middleware/origin.ts`
      // exempts `GET` requests from the CSRF check on ("a GET is not
      // supposed to change anything in the first place"). Read-only —
      // `conversations.findExistingConversation` never inserts — and "no
      // conversation yet" reads as an empty transcript, not a refusal: the
      // enrolment check above already proved `courseId`/`personId` both
      // belong to this organization, so `undefined` here can only mean
      // exactly that, never a foreign or absent id (this file's own
      // discipline throughout: guarded rather than assumed regardless).
      // The `POST` handler below is the one place that ever creates a
      // conversation, and only when a question is actually asked.
      const conversation = conversations.findExistingConversation(
        organizationId,
        { courseId, personId: person.id, surface: 'web' },
        deps.db
      )
      const transcript = conversation
        ? conversations.getTranscript(organizationId, conversation.id, deps.db)
        : []
      res.status(200).json({ messages: transcript.map(toChatMessageView) })
    }
  )

  // WEB-10 rework, finding 7 — bounded, not just non-empty. The allowance
  // counts *requests* (CORE-3), never tokens or characters, so an unbounded
  // `text` turns "ten questions a day" into no real spending bound at all;
  // one 99 kB request (`express.json()`'s own 100 kB default is the only
  // ceiling this had) reaches the model for the price of one ordinary
  // question, and the spending cap it can run up is organization-wide
  // (COST-3) — one student on the web can exhaust it and take every Discord
  // student in the same tenant down with them. 4,000 characters matches
  // Discord's own outer bound on a single message (`packages/discord/src/split.ts`'s
  // own `DISCORD_MESSAGE_LIMIT`, 2,000, is this app's *reply*-splitting
  // threshold, not the inbound ceiling; Discord itself accepts up to 4,000
  // characters from a Nitro account) — this surface is bounded no more
  // generously than the one it mirrors, not arbitrarily.
  const postMessageInputSchema = z.object({ text: z.string().min(1).max(4000) })

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

      const person = resolveConnectedCallerPerson(
        organizationId,
        accountId,
        deps.db
      )
      if (!person) {
        sendNotConnected(res)
        return
      }
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
