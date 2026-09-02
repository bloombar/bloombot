/**
 * Repository for `conversations` and `messages` (CONV-1, CONV-2).
 *
 * A conversation is the continuity of one person's exchange with one
 * course; a message is one turn of it, in either direction. Every function
 * here is scoped by `organizationId`, its first parameter — there is no
 * exception in this file (TEN-2).
 */

import BetterSqlite3 from 'better-sqlite3'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'

import type { Database } from '../client.js'
import {
  conversations,
  courses,
  messages,
  people,
  type MessageDirection,
  type Surface,
} from '../schema.js'

export type Conversation = typeof conversations.$inferSelect
export type Message = typeof messages.$inferSelect

/**
 * The subset of `Database`'s query methods used inside `appendMessage`'s own
 * transaction — the same device `courses.ts`'s `Executor` uses.
 */
type Executor = Pick<Database, 'select' | 'insert' | 'update'>

/**
 * `SQLITE_CONSTRAINT_UNIQUE` is what `conversations`'s two partial unique
 * indexes (`schema.ts`) throw as.
 */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof BetterSqlite3.SqliteError &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}

/** What `getOrCreateConversation` needs: the course, the person, and the surface the message arrived on. */
export interface GetOrCreateConversationInput {
  courseId: string
  personId: string
  surface: Surface
}

/**
 * The existing conversation for (`courseId`, `personId`, `scopeSurface`), if
 * any — `scopeSurface` is already resolved from the course's
 * `conversationScope` by the caller, not the raw arrival surface. Matches
 * the two partial unique indexes on `conversations` (`schema.ts`): `IS NULL`
 * for a `null` scope surface, `=` otherwise, since `= NULL` never matches
 * anything in SQL.
 */
function findConversation(
  organizationId: string,
  courseId: string,
  personId: string,
  scopeSurface: Surface | null,
  db: Executor
): Conversation | undefined {
  return db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, organizationId),
        eq(conversations.courseId, courseId),
        eq(conversations.personId, personId),
        scopeSurface === null
          ? isNull(conversations.surface)
          : eq(conversations.surface, scopeSurface)
      )
    )
    .get()
}

/** What `resolveConversationLookup` hands back: the scope surface a conversation for this input would use, and the existing row for it, if any. */
interface ConversationLookup {
  scopeSurface: Surface | null
  existing: Conversation | undefined
}

/**
 * Shared by `findExistingConversation` and `getOrCreateConversation`,
 * below: resolves the course's own `conversationScope` into the scope
 * surface that actually keys a conversation row, and looks one up —
 * `undefined` when `courseId`/`personId` is foreign or absent (TEN-2/TEN-5)
 * — the same gap `loadOwnedProject` (`repos/courses.ts`) closes for a
 * course's `projectId`. Read-only — inserting a conversation stays each
 * public function's own decision, not this one's; `getOrCreateConversation`
 * reuses `scopeSurface` from this one read rather than resolving it a
 * second time.
 */
function resolveConversationLookup(
  organizationId: string,
  input: GetOrCreateConversationInput,
  db: Database
): ConversationLookup | undefined {
  const course = db
    .select({ conversationScope: courses.conversationScope })
    .from(courses)
    .where(
      and(
        eq(courses.id, input.courseId),
        eq(courses.organizationId, organizationId)
      )
    )
    .get()
  if (!course) return undefined

  const person = db
    .select({ id: people.id })
    .from(people)
    .where(
      and(
        eq(people.id, input.personId),
        eq(people.organizationId, organizationId)
      )
    )
    .get()
  if (!person) return undefined

  const scopeSurface =
    course.conversationScope === 'course_surface' ? input.surface : null

  const existing = findConversation(
    organizationId,
    input.courseId,
    input.personId,
    scopeSurface,
    db
  )

  return { scopeSurface, existing }
}

/**
 * The existing conversation for one person's exchange with one course, if
 * any — read-only, deliberately never creating one (rework finding: WEB-10's
 * own `routes/chat.ts` GET transcript route used to call
 * `getOrCreateConversation` to *read* a transcript, which meant opening a
 * chat thread that had never been asked anything yet silently wrote a
 * `conversations` row — `middleware/origin.ts`'s own "a GET is not supposed
 * to change anything in the first place" stopped being true for that one
 * route). A caller reading a transcript uses this and treats "no
 * conversation yet" as an empty one; `getOrCreateConversation`, below, is
 * still the only function in this package that ever creates a
 * conversation, and is only ever called from the code path that is
 * actually about to record a question.
 */
export function findExistingConversation(
  organizationId: string,
  input: GetOrCreateConversationInput,
  db: Database
): Conversation | undefined {
  return resolveConversationLookup(organizationId, input, db)?.existing
}

/**
 * Get, or create, the conversation for one person's exchange with one
 * course (CONV-1) — honouring the course's `conversationScope`: `course`
 * (the default) stores `surface: null` and merges every surface into one
 * conversation; `course_surface` stores the arrival `surface` and keeps
 * each surface's conversation distinct. Which one applies is read from the
 * course itself, not passed by the caller, so a caller cannot accidentally
 * bypass the course's own setting.
 *
 * `undefined` when `courseId` or `personId` does not exist, or does not
 * belong to `organizationId` (TEN-2/TEN-5) — `resolveConversationLookup`'s
 * own check, shared with `findExistingConversation` above.
 *
 * Changing a course's `conversationScope` after conversations already exist
 * does not touch them (see `docs/DECISIONS.md`): an existing `course`-scoped
 * row keeps `surface: null` forever, and a later call under
 * `course_surface` looks for a row with `surface` set, which that row is
 * not, so a *new* conversation is created rather than the old one being
 * split or reused. There is no merge or split path in this package.
 */
export function getOrCreateConversation(
  organizationId: string,
  input: GetOrCreateConversationInput,
  db: Database
): Conversation | undefined {
  const lookup = resolveConversationLookup(organizationId, input, db)
  if (!lookup) return undefined
  if (lookup.existing) return lookup.existing
  const { scopeSurface } = lookup

  try {
    return db
      .insert(conversations)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        courseId: input.courseId,
        personId: input.personId,
        surface: scopeSurface,
        upstreamThreadId: null,
        createdAt: Date.now(),
        lastMessageAt: Date.now(),
      })
      .returning()
      .get()
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // A concurrent caller created this conversation first — look it up
      // and return the winner rather than let the raw driver error escape.
      const winner = findConversation(
        organizationId,
        input.courseId,
        input.personId,
        scopeSurface,
        db
      )
      if (winner) return winner
    }
    throw error
  }
}

/** Look up a conversation by id, scoped to `organizationId`. */
export function getConversation(
  organizationId: string,
  conversationId: string,
  db: Database
): Conversation | undefined {
  return db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.organizationId, organizationId)
      )
    )
    .get()
}

/**
 * Set a conversation's upstream model thread id (CONV-1: "a conversation
 * records the upstream model thread it corresponds to, so the model's own
 * context can be resumed") — organization-scoped like everything else in
 * this file. `undefined` when `conversationId` does not exist or does not
 * belong to `organizationId` (TEN-2). Before this function existed,
 * `upstreamThreadId` was always written `null` by `getOrCreateConversation`
 * and never updated by anything, so CONV-1's own text was unreachable
 * through this package's API — see `docs/DECISIONS.md` D-13.
 */
export function setUpstreamThreadId(
  organizationId: string,
  conversationId: string,
  upstreamThreadId: string,
  db: Database
): Conversation | undefined {
  return db
    .update(conversations)
    .set({ upstreamThreadId })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.organizationId, organizationId)
      )
    )
    .returning()
    .get()
}

/** List every conversation a course has (base rows only — use `getTranscript` for messages). */
export function listConversationsForCourse(
  organizationId: string,
  courseId: string,
  db: Database
): Conversation[] {
  return db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, organizationId),
        eq(conversations.courseId, courseId)
      )
    )
    .all()
}

/** Fields the caller supplies when appending a message to a conversation. */
export interface NewMessage {
  /** Defaults to `crypto.randomUUID()` when omitted. */
  id?: string
  direction: MessageDirection
  content: string
  surface?: Surface | null
  channelRef?: string | null
  categoryRef?: string | null
  /**
   * Defaults to `Date.now()` when omitted — the normal case, a message
   * being recorded as it happens. `packages/legacy-import` (MIG-3) is the
   * one caller that supplies this explicitly: a transcript imported from
   * the legacy database keeps the timestamp the message actually occurred
   * at, not the moment it was imported, which would make the transcript
   * useless as the record it exists to be.
   */
  createdAt?: number
}

/**
 * Append a message to a conversation (CONV-2), recording both directions.
 *
 * `personId` and `courseId` on the `messages` row (`schema.ts`) are always
 * derived from the conversation itself, never taken from `input` — a
 * message cannot belong to a different person or course than the
 * conversation it is appended to, so there is no caller-supplied
 * cross-tenant id here for TEN-5 to close (unlike `getOrCreateConversation`,
 * whose `courseId`/`personId` name a *new* conversation to find or create).
 *
 * `undefined` when `conversationId` does not exist or does not belong to
 * `organizationId` (TEN-2). Updates the conversation's `lastMessageAt` — to
 * the *later* of its current value and this message's own `createdAt`
 * (finding 6 of the MIG-1 rework), never backward — in the same transaction
 * as the insert, so the two never drift.
 *
 * There is no delete path for a message anywhere in this file (TEN-6): a
 * transcript is a record an instructor may be required to retain.
 *
 * `messages.sequence` (finding 3 of the CONV-1 rework) is assigned here,
 * inside this function's own transaction, as one more than the highest
 * `sequence` already recorded for this conversation — a real tiebreaker for
 * `getTranscript`'s order, unlike `createdAt` alone: `createdAt` is
 * millisecond precision, several messages can be appended within the same
 * millisecond, and SQL does not define an order among rows tied on the
 * `ORDER BY` column. Reading the previous max and writing the next value in
 * the same transaction is what keeps two concurrent appends to the same
 * conversation from computing the same `sequence`.
 */
export function appendMessage(
  organizationId: string,
  conversationId: string,
  input: NewMessage,
  db: Database
): Message | undefined {
  const conversation = getConversation(organizationId, conversationId, db)
  if (!conversation) return undefined

  return db.transaction((tx) => {
    const createdAt = input.createdAt ?? Date.now()
    const previous = tx
      .select({ sequence: messages.sequence })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.sequence))
      .limit(1)
      .get()
    const sequence = (previous?.sequence ?? -1) + 1

    const message = tx
      .insert(messages)
      .values({
        id: input.id ?? crypto.randomUUID(),
        organizationId,
        conversationId,
        personId: conversation.personId,
        courseId: conversation.courseId,
        direction: input.direction,
        content: input.content,
        surface: input.surface ?? null,
        channelRef: input.channelRef ?? null,
        categoryRef: input.categoryRef ?? null,
        sequence,
        createdAt,
      })
      .returning()
      .get()

    // finding 6 (MIG-1 rework): `lastMessageAt` moves *forward* to the later
    // of its current value and this message's `createdAt` — never
    // backward. A plain unconditional set was correct for every caller that
    // appends "now" (`input.createdAt` omitted), but `packages/legacy-import`
    // (MIG-3) is the one caller that supplies an explicit, potentially
    // backdated `createdAt` — importing a two-year-old transcript into a
    // conversation the live bot has already written to must not rewind
    // "last message" into the past. Computed in the same `UPDATE` (`max`),
    // not read-then-written from the `conversation` fetched before this
    // transaction started, so a concurrent append cannot race it stale.
    tx.update(conversations)
      .set({
        lastMessageAt: sql`max(${conversations.lastMessageAt}, ${createdAt})`,
      })
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.organizationId, organizationId)
        )
      )
      .run()

    return message
  })
}

/**
 * A conversation's transcript, in order (CONV-2) — both directions, oldest
 * first. Ordered by `sequence`, not `createdAt`: `createdAt` alone is not a
 * determined order (see `appendMessage`'s comment on why), and `sequence` is
 * the column that actually is.
 */
export function getTranscript(
  organizationId: string,
  conversationId: string,
  db: Database
): Message[] {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.organizationId, organizationId)
      )
    )
    .orderBy(messages.sequence)
    .all()
}
