/**
 * Repository for `people` and `person_identities` (PPL-1, PPL-2, PPL-3,
 * LINK-1..5, PPL-4/5).
 *
 * A person is the human a course serves — usually a student — reached
 * through one identity per surface (Discord, web, MCP). Every function here
 * is scoped by `organizationId`, its first parameter — there is no
 * exception in this file (TEN-2).
 *
 * `connectIdentity` and `mergePeople` (below `resolvePersonByIdentity`) are
 * PPL-4/LINK-3/LINK-4's own writes: the only two ways a person ever ends up
 * with an identity nobody proved for them at the moment `resolvePersonByIdentity`
 * first created them — both are called only after a proof has already
 * succeeded (`@bloombot/auth`'s `person-link.ts`), never on an address match
 * alone (PPL-4).
 */

import BetterSqlite3 from 'better-sqlite3'
import { and, eq, isNull, sql } from 'drizzle-orm'

import type { Database } from '../client.js'
import {
  conversations,
  enrolments,
  messages,
  people,
  personIdentities,
  usageCounters,
  type Surface,
} from '../schema.js'

export type Person = typeof people.$inferSelect
export type PersonIdentity = typeof personIdentities.$inferSelect

/**
 * The subset of `Database`'s query methods `resolvePersonByIdentity` needs
 * inside its own transaction — the same device `courses.ts`'s `Executor`
 * uses, for the same reason: `db.transaction(...)`'s callback parameter
 * satisfies this but not `Database` itself.
 */
type Executor = Pick<Database, 'select' | 'insert' | 'update'>

/** Fields the caller supplies when creating a person directly. */
export interface NewPerson {
  /** Defaults to `crypto.randomUUID()` when omitted. */
  id?: string
  displayName?: string | null
  email?: string | null
  firstName?: string | null
  lastName?: string | null
  githubHandle?: string | null
}

/** The surface and external id an identity resolves — PPL-2. */
export interface PersonIdentityInput {
  surface: Surface
  externalId: string
}

/**
 * The roster fields PPL-3 says are "merged onto the person later when a
 * roster is imported" — name, email and GitHub handle, not the identity
 * itself.
 */
export interface RosterFields {
  displayName?: string | null
  email?: string | null
  firstName?: string | null
  lastName?: string | null
  githubHandle?: string | null
}

/**
 * `SQLITE_CONSTRAINT_UNIQUE` is what `person_identities_org_surface_external_unique`
 * (`schema.ts`) throws as — the same check `projects.ts`'s own
 * `isUniqueConstraintError` runs against its own constraint.
 */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof BetterSqlite3.SqliteError &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}

/** Create a person directly — used by an import that already knows the roster fields. */
export function createPerson(
  organizationId: string,
  input: NewPerson,
  db: Database
): Person {
  return db
    .insert(people)
    .values({
      id: input.id ?? crypto.randomUUID(),
      organizationId,
      displayName: input.displayName ?? null,
      email: input.email ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      githubHandle: input.githubHandle ?? null,
      createdAt: Date.now(),
    })
    .returning()
    .get()
}

/**
 * Look up a person by id, scoped to `organizationId`.
 *
 * `db` accepts `Executor`, not just `Database`: `repos/enrolments.ts#admit`
 * (rework finding 2/6) calls this — to refuse a foreign `personId` before an
 * enrolment is written — from inside `repos/course-join-links.ts#redeemJoinLink`'s
 * own transaction.
 */
export function getPerson(
  organizationId: string,
  personId: string,
  db: Executor
): Person | undefined {
  return db
    .select()
    .from(people)
    .where(
      and(eq(people.id, personId), eq(people.organizationId, organizationId))
    )
    .get()
}

/** Every person in an organization. */
export function listPeople(organizationId: string, db: Database): Person[] {
  return db
    .select()
    .from(people)
    .where(eq(people.organizationId, organizationId))
    .all()
}

/**
 * Look up one person's identity on a given surface — the raw external id
 * (a Discord snowflake, a web account id, …) `person_identities` holds for
 * them, scoped to `organizationId` (TEN-2). `undefined` when the person has
 * no identity on that surface, or `personId` does not belong to
 * `organizationId`.
 *
 * Added for finding 1 of the MDL-1 rework (docs/DECISIONS.md, D-16): MDL-4's
 * seeded opening item needs the person's own external id to embed as
 * `metadata.user_id` (`response_bot.py:262-269`'s `<@id>`), and the surface
 * that reported the message knowing the raw snowflake is not a reason to
 * make `answer.ts` ask its caller for something `person_identities` already
 * holds.
 */
export function getPersonIdentity(
  organizationId: string,
  personId: string,
  surface: Surface,
  db: Database
): PersonIdentity | undefined {
  return db
    .select()
    .from(personIdentities)
    .where(
      and(
        eq(personIdentities.personId, personId),
        eq(personIdentities.organizationId, organizationId),
        eq(personIdentities.surface, surface)
      )
    )
    .get()
}

/**
 * Resolve an identity to the person it belongs to, or `undefined` if nobody
 * holds it in this organization yet. Read-only — see
 * `resolvePersonByIdentity` for "create on demand" (PPL-3).
 *
 * `people.organizationId` is constrained explicitly in `where`, not just
 * `personIdentities.organizationId` in the join — not reachable through this
 * package's own API today, because `resolvePersonByIdentity` always writes a
 * person and its identity with the same `organizationId`, so the two can
 * never disagree yet. Left unconstrained, the query would still be correct
 * for every row this package writes, but it is one join condition away from
 * returning another organization's person and roster fields the moment
 * anything writes the two tables out of step (finding 7 of the CONV-1
 * rework).
 */
export function resolveIdentity(
  organizationId: string,
  identity: PersonIdentityInput,
  db: Executor
): Person | undefined {
  return db
    .select({
      id: people.id,
      organizationId: people.organizationId,
      displayName: people.displayName,
      email: people.email,
      firstName: people.firstName,
      lastName: people.lastName,
      githubHandle: people.githubHandle,
      connectedAt: people.connectedAt,
      mergedIntoPersonId: people.mergedIntoPersonId,
      mergedAt: people.mergedAt,
      createdAt: people.createdAt,
    })
    .from(people)
    .innerJoin(
      personIdentities,
      and(
        eq(personIdentities.personId, people.id),
        eq(personIdentities.organizationId, organizationId)
      )
    )
    .where(
      and(
        eq(people.organizationId, organizationId),
        eq(personIdentities.surface, identity.surface),
        eq(personIdentities.externalId, identity.externalId)
      )
    )
    .get()
}

/**
 * PPL-3: resolve an incoming message's identity to a person, creating both
 * the person and the identity together, in one transaction, the first time
 * either is seen. No import step stands between a student and their first
 * answer.
 *
 * The new person is created with every roster field unset — PPL-3 says
 * those are merged in later, not invented here (`mergeRosterFields`,
 * below).
 *
 * A known identity is resolved and returned unchanged: nothing is written.
 * An unknown identity is created inside `db.transaction(...)`, so a failure
 * part-way (the identity insert throwing after the person insert commits, in
 * this connection's own view) rolls both back — neither is left behind. If a
 * concurrent caller resolves the same identity first, this insert loses the
 * race against `person_identities_org_surface_external_unique`
 * (`schema.ts`); that failure is caught, the whole transaction rolls back
 * (so this caller's own, now-orphaned person row is undone too), and the
 * winner's person is looked up and returned instead of a raw driver error
 * escaping.
 */
export function resolvePersonByIdentity(
  organizationId: string,
  identity: PersonIdentityInput,
  db: Database
): Person {
  const existing = resolveIdentity(organizationId, identity, db)
  if (existing) return existing

  try {
    return db.transaction((tx) => {
      const person = tx
        .insert(people)
        .values({
          id: crypto.randomUUID(),
          organizationId,
          displayName: null,
          email: null,
          firstName: null,
          lastName: null,
          githubHandle: null,
          createdAt: Date.now(),
        })
        .returning()
        .get()

      tx.insert(personIdentities)
        .values({
          id: crypto.randomUUID(),
          organizationId,
          personId: person.id,
          surface: identity.surface,
          externalId: identity.externalId,
          createdAt: Date.now(),
        })
        .run()

      return person
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const winner = resolveIdentity(organizationId, identity, db)
      if (winner) return winner
    }
    throw error
  }
}

/**
 * Merge roster fields onto an existing person (PPL-3).
 *
 * "Merge" fills in only the fields the person does not already have —
 * `null` on the row — rather than overwriting a field a surface has already
 * populated (a Discord display name, say) with a roster's value. `undefined`
 * when `personId` does not exist or does not belong to `organizationId`
 * (TEN-2), matching `updateCourse`'s refusal shape. A person that already
 * has every field the roster supplies is left untouched and returned as-is.
 */
export function mergeRosterFields(
  organizationId: string,
  personId: string,
  fields: RosterFields,
  db: Database
): Person | undefined {
  const existing = getPerson(organizationId, personId, db)
  if (!existing) return undefined

  const patch: Partial<
    Pick<
      Person,
      'displayName' | 'email' | 'firstName' | 'lastName' | 'githubHandle'
    >
  > = {}
  for (const key of [
    'displayName',
    'email',
    'firstName',
    'lastName',
    'githubHandle',
  ] as const) {
    const incoming = fields[key]
    if (existing[key] === null && incoming != null) {
      patch[key] = incoming
    }
  }
  if (Object.keys(patch).length === 0) return existing

  return db
    .update(people)
    .set(patch)
    .where(
      and(eq(people.id, personId), eq(people.organizationId, organizationId))
    )
    .returning()
    .get()
}

/**
 * Overwrite roster fields on an existing person — the escape hatch
 * `mergeRosterFields` deliberately does not provide (finding 9 / D-13 of the
 * CONV-1 rework). `mergeRosterFields` only ever fills a field that is
 * currently `null`, so a field merged in wrong once (a bad roster row's
 * email, say) is permanently wrong: a corrected re-import through
 * `mergeRosterFields` alone is a no-op, because the field is no longer
 * `null`. This function is the other half — every field named in `fields`
 * is written exactly as given, including `null` (which clears it),
 * regardless of what the person's row currently holds; a field left
 * `undefined` in `fields` is left untouched, the same "absent means
 * unchanged" reading `updateCourse`'s optional fields use. `undefined` when
 * `personId` does not exist or does not belong to `organizationId` (TEN-2),
 * matching `mergeRosterFields`'s refusal shape.
 */
export function overwriteRosterFields(
  organizationId: string,
  personId: string,
  fields: RosterFields,
  db: Database
): Person | undefined {
  const existing = getPerson(organizationId, personId, db)
  if (!existing) return undefined

  const patch: Partial<
    Pick<
      Person,
      'displayName' | 'email' | 'firstName' | 'lastName' | 'githubHandle'
    >
  > = {}
  for (const key of [
    'displayName',
    'email',
    'firstName',
    'lastName',
    'githubHandle',
  ] as const) {
    if (fields[key] !== undefined) {
      patch[key] = fields[key]
    }
  }
  if (Object.keys(patch).length === 0) return existing

  return db
    .update(people)
    .set(patch)
    .where(
      and(eq(people.id, personId), eq(people.organizationId, organizationId))
    )
    .returning()
    .get()
}

/**
 * PPL-4/LINK-3: attach a *proven* identity to an already-existing person —
 * called only after `@bloombot/auth`'s `person-link.ts` has redeemed a proof
 * (Discord's own OAuth, or an MCP token), never on an address match alone.
 * This is deliberately not `resolvePersonByIdentity`'s job (that function
 * only ever creates a *new* person for an identity nobody has proven
 * anything about, PPL-3) and deliberately not `mergePeople`'s job either
 * (that function combines two existing people; this function has nothing to
 * combine when nobody has ever seen this identity before).
 *
 * Three outcomes:
 *  - the identity has never been seen: a new `person_identities` row is
 *    created for `personId`, and returned.
 *  - the identity already belongs to `personId`: idempotent — the existing
 *    row is returned unchanged, nothing is written twice.
 *  - the identity already belongs to a *different* person: refused
 *    (`undefined`) — that is `mergePeople`'s case, not this function's; a
 *    caller that finds this should call `mergePeople` instead of retrying
 *    here (see `@bloombot/auth`'s `person-link.ts#completeDiscordPersonLink`/
 *    `#completeMcpPersonLink`, which do exactly that).
 *
 * `undefined` also when `personId` does not exist or does not belong to
 * `organizationId` (TEN-2), the same refusal shape every other write in this
 * file gives a foreign id.
 */
export function connectIdentity(
  organizationId: string,
  personId: string,
  identity: PersonIdentityInput,
  db: Database
): PersonIdentity | undefined {
  if (!getPerson(organizationId, personId, db)) return undefined

  const existingOwner = resolveIdentity(organizationId, identity, db)
  if (existingOwner && existingOwner.id !== personId) return undefined

  if (existingOwner) {
    // Idempotent — already this person's own identity.
    return getPersonIdentity(organizationId, personId, identity.surface, db)
  }

  try {
    return db
      .insert(personIdentities)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        personId,
        surface: identity.surface,
        externalId: identity.externalId,
        createdAt: Date.now(),
      })
      .returning()
      .get()
  } catch (error) {
    // A concurrent caller attached (or created a person under) the same
    // identity first — the same "caught, winner looked up instead of a raw
    // driver error escaping" shape `resolvePersonByIdentity` already uses.
    if (isUniqueConstraintError(error)) {
      const winner = resolveIdentity(organizationId, identity, db)
      if (winner && winner.id === personId) {
        return getPersonIdentity(organizationId, personId, identity.surface, db)
      }
      return undefined
    }
    throw error
  }
}

/** What `mergePeople` reports. */
export interface MergeResult {
  survivor: Person
  /** `true` when this call found `loserPersonId` already merged into `survivorPersonId` and did nothing further (LINK-4's own "idempotent"). */
  alreadyMerged: boolean
}

/**
 * The chronological order two conversations' messages merge into: stable on
 * `createdAt`, ties broken by keeping `a`'s own relative order before `b`'s
 * — both lists are already in their own conversation's `sequence` order
 * (chronological within themselves), so a plain two-pointer merge on
 * `createdAt` alone is enough to interleave them correctly.
 */
function mergeMessagesByCreatedAt(
  a: (typeof messages.$inferSelect)[],
  b: (typeof messages.$inferSelect)[]
): (typeof messages.$inferSelect)[] {
  const merged: (typeof messages.$inferSelect)[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    // `a`/`b` are local arrays; `noUncheckedIndexedAccess` cannot see the
    // loop guard already proves both indices in range.
    const left = a[i] as typeof messages.$inferSelect
    const right = b[j] as typeof messages.$inferSelect
    if (left.createdAt <= right.createdAt) {
      merged.push(left)
      i++
    } else {
      merged.push(right)
      j++
    }
  }
  while (i < a.length) merged.push(a[i++] as typeof messages.$inferSelect)
  while (j < b.length) merged.push(b[j++] as typeof messages.$inferSelect)
  return merged
}

/**
 * LINK-4: merge `loserPersonId` into `survivorPersonId` — the operation
 * behind connecting a second surface once its proof has succeeded
 * (`@bloombot/auth`'s `person-link.ts`). "The survivor" is whichever person
 * the connect attempt began from (D-28's "the account being connected");
 * "the loser" is whichever person the identity being proved already
 * belonged to.
 *
 * In one transaction:
 *  - **Identities** (PPL-2) move to the survivor outright — the unique
 *    constraint on `(organizationId, surface, externalId)` cannot collide
 *    from this alone, since the loser and survivor never shared an
 *    `externalId` in the first place (that is exactly what made them two
 *    people).
 *  - **Enrolments** (ENRL-1..6): an *ended* enrolment moves to the survivor
 *    outright (no unique constraint to collide with). An *active* one moves
 *    to the survivor only if the survivor holds no active enrolment for that
 *    same course already; when the survivor already does, the loser's row is
 *    *ended* instead of moved — `enrolments_org_course_person_active_unique`
 *    permits at most one active row per (organization, course, person), and
 *    the survivor's own enrolment is what the merged person keeps going
 *    forward. Nothing is deleted either way — a loser's now-ended row is
 *    still the historical record of how they were admitted.
 *  - **Conversations and messages** (CONV-1, CONV-2) are the "unique
 *    constraints you will hit" case: a loser conversation for a
 *    (course, surface-scope) pair the survivor has no conversation for moves
 *    to the survivor outright. When *both* have one for the same course
 *    (this function's own hard case, and the reason `conversations` has two
 *    partial unique indexes that a plain reassignment would violate), the
 *    two transcripts are combined into the survivor's own conversation row:
 *    every message from both, interleaved back into chronological order
 *    (`mergeMessagesByCreatedAt`), re-sequenced, and re-pointed at the
 *    survivor's conversation and person id. Nothing is dropped — CONV-2's
 *    own "no delete path for a message" holds through a merge too — but the
 *    loser's own conversation row is left in place, now empty, rather than
 *    reassigned or deleted: reassigning it to the survivor would recreate
 *    the exact unique-index collision this branch exists to avoid, and
 *    nothing in this package deletes a conversation row. `upstreamThreadId`
 *    keeps the survivor's own value when it has one (never overwritten by
 *    the loser's); `lastMessageAt` becomes the later of the two, the same
 *    "never rewind" rule `appendMessage` already applies within a single
 *    conversation.
 *  - **The day's usage** (CONV-3) is combined, never restarted — LINK-4's own
 *    text, stated as a requirement, not a suggestion: a merge that reset the
 *    day's count back to the survivor's own pre-merge total (or replaced it
 *    with the loser's) would make connecting the cheapest way to double an
 *    allowance. For every `(course, day)` the loser has a count for, that
 *    count is *added* to the survivor's own row for the same `(course, day)`
 *    (creating one if the survivor had none yet) — never overwritten. The
 *    loser's own row is left exactly as it was: harmless history nothing
 *    reads through the loser's id again once every identity has moved.
 *  - **Cost ledger entries are deliberately left alone** — see
 *    `docs/DECISIONS.md` D-35 for why: they are a historical attribution of
 *    what was actually spent and by which id at the time, not a live balance
 *    a merge needs to keep correct the way usage counters are.
 *
 * Idempotent (LINK-4's own word): calling this again with the same pair
 * after a successful merge does nothing further and reports
 * `alreadyMerged: true` — checked *before* any write below runs, so a retry
 * can never double the usage it already combined once. Refuses
 * (`undefined`) rather than merging when: `survivorPersonId === loserPersonId`;
 * either id does not exist or does not belong to `organizationId` (TEN-2);
 * the survivor has itself already been merged into someone else (a merged-away
 * person is never a valid target); or the loser has already been merged into
 * a *different* survivor (a conflicting merge, not a replay of this one).
 */
export function mergePeople(
  organizationId: string,
  survivorPersonId: string,
  loserPersonId: string,
  db: Database
): MergeResult | undefined {
  if (survivorPersonId === loserPersonId) return undefined

  const survivor = getPerson(organizationId, survivorPersonId, db)
  const loser = getPerson(organizationId, loserPersonId, db)
  if (!survivor || !loser) return undefined
  if (survivor.mergedIntoPersonId !== null) return undefined

  if (loser.mergedIntoPersonId !== null) {
    if (loser.mergedIntoPersonId === survivorPersonId) {
      return { survivor, alreadyMerged: true }
    }
    return undefined
  }

  return db.transaction((tx) => {
    // Identities (PPL-2) — move outright; see this function's own comment
    // for why the unique constraint cannot collide here.
    tx.update(personIdentities)
      .set({ personId: survivorPersonId })
      .where(
        and(
          eq(personIdentities.organizationId, organizationId),
          eq(personIdentities.personId, loserPersonId)
        )
      )
      .run()

    // Enrolments (ENRL-1..6).
    const loserEnrolments = tx
      .select()
      .from(enrolments)
      .where(
        and(
          eq(enrolments.organizationId, organizationId),
          eq(enrolments.personId, loserPersonId)
        )
      )
      .all()
    for (const enrolment of loserEnrolments) {
      if (enrolment.endedAt !== null) {
        tx.update(enrolments)
          .set({ personId: survivorPersonId })
          .where(eq(enrolments.id, enrolment.id))
          .run()
        continue
      }
      const survivorActive = tx
        .select({ id: enrolments.id })
        .from(enrolments)
        .where(
          and(
            eq(enrolments.organizationId, organizationId),
            eq(enrolments.courseId, enrolment.courseId),
            eq(enrolments.personId, survivorPersonId),
            isNull(enrolments.endedAt)
          )
        )
        .get()
      if (survivorActive) {
        // The survivor already has an active enrolment for this course —
        // the loser's own row is ended, not moved, to avoid colliding with
        // `enrolments_org_course_person_active_unique`.
        tx.update(enrolments)
          .set({ endedAt: Date.now() })
          .where(eq(enrolments.id, enrolment.id))
          .run()
      } else {
        tx.update(enrolments)
          .set({ personId: survivorPersonId })
          .where(eq(enrolments.id, enrolment.id))
          .run()
      }
    }

    // Conversations and messages (CONV-1, CONV-2).
    const loserConversations = tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, organizationId),
          eq(conversations.personId, loserPersonId)
        )
      )
      .all()
    for (const loserConversation of loserConversations) {
      const survivorConversation = tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.organizationId, organizationId),
            eq(conversations.courseId, loserConversation.courseId),
            eq(conversations.personId, survivorPersonId),
            loserConversation.surface === null
              ? isNull(conversations.surface)
              : eq(conversations.surface, loserConversation.surface)
          )
        )
        .get()

      if (!survivorConversation) {
        // No collision — move the whole conversation (and, transitively,
        // every message still pointing at it) to the survivor outright.
        tx.update(conversations)
          .set({ personId: survivorPersonId })
          .where(eq(conversations.id, loserConversation.id))
          .run()
        tx.update(messages)
          .set({ personId: survivorPersonId })
          .where(eq(messages.conversationId, loserConversation.id))
          .run()
        continue
      }

      // Both people have a conversation for this course — the hard case
      // this function's own comment names. Combine the two transcripts into
      // the survivor's own conversation, in chronological order.
      const survivorMessages = tx
        .select()
        .from(messages)
        .where(eq(messages.conversationId, survivorConversation.id))
        .orderBy(messages.sequence)
        .all()
      const loserMessages = tx
        .select()
        .from(messages)
        .where(eq(messages.conversationId, loserConversation.id))
        .orderBy(messages.sequence)
        .all()
      const merged = mergeMessagesByCreatedAt(survivorMessages, loserMessages)
      merged.forEach((message, index) => {
        tx.update(messages)
          .set({
            conversationId: survivorConversation.id,
            personId: survivorPersonId,
            sequence: index,
          })
          .where(eq(messages.id, message.id))
          .run()
      })

      tx.update(conversations)
        .set({
          lastMessageAt: Math.max(
            survivorConversation.lastMessageAt,
            loserConversation.lastMessageAt
          ),
          upstreamThreadId:
            survivorConversation.upstreamThreadId ??
            loserConversation.upstreamThreadId,
        })
        .where(eq(conversations.id, survivorConversation.id))
        .run()
      // `loserConversation`'s own row is deliberately left in place, now
      // empty — see this function's own comment for why.
    }

    // The day's usage (CONV-3) — combined, never restarted (LINK-4's own
    // text). The loser's own rows are left exactly as they were.
    const loserUsage = tx
      .select()
      .from(usageCounters)
      .where(
        and(
          eq(usageCounters.organizationId, organizationId),
          eq(usageCounters.personId, loserPersonId)
        )
      )
      .all()
    for (const counter of loserUsage) {
      tx.insert(usageCounters)
        .values({
          organizationId,
          courseId: counter.courseId,
          personId: survivorPersonId,
          day: counter.day,
          count: counter.count,
        })
        .onConflictDoUpdate({
          target: [
            usageCounters.organizationId,
            usageCounters.courseId,
            usageCounters.personId,
            usageCounters.day,
          ],
          set: { count: sql`${usageCounters.count} + ${counter.count}` },
        })
        .run()
    }

    // Record the merge (LINK-4's own "idempotent, and recorded"), and mark
    // the survivor connected (LINK-1) — `coalesce` so a survivor already
    // connected from an earlier merge keeps that earlier timestamp, never
    // moved forward by a later one.
    const now = Date.now()
    tx.update(people)
      .set({ mergedIntoPersonId: survivorPersonId, mergedAt: now })
      .where(eq(people.id, loserPersonId))
      .run()
    const updatedSurvivor = tx
      .update(people)
      .set({ connectedAt: sql`coalesce(${people.connectedAt}, ${now})` })
      .where(eq(people.id, survivorPersonId))
      .returning()
      .get()

    return { survivor: updatedSurvivor, alreadyMerged: false }
  })
}

/**
 * PPL-5: does `personId` have a *verified* address — the gate "reading a
 * transcript back, exporting one, or carrying a conversation onto a second
 * surface" needs, deliberately distinct from whether they can be answered at
 * all (PPL-5's own "the two controls are separate on purpose"). `true` once
 * `mergePeople` has connected at least one proven identity onto this person
 * (`connectedAt` is not `null`) — the same fact LINK-1's own invitation gate
 * reads (`@bloombot/core`'s `answer.ts`), reused here rather than
 * reinvented, since "proven" is exactly what PPL-5 asks for.
 *
 * No action in this platform calls this yet — the reads PPL-5 names (a
 * transcript export, carrying a conversation to a second surface) belong to
 * `ADMIN-1..5` and the web chat surface, neither built yet (see
 * `docs/DECISIONS.md`). This function is the check those reads should call
 * before they disclose anything, so it exists ahead of its own caller rather
 * than being invented inline once one is built.
 *
 * `undefined` when `personId` does not exist or does not belong to
 * `organizationId` (TEN-2).
 */
export function hasVerifiedAddress(
  organizationId: string,
  personId: string,
  db: Database
): boolean | undefined {
  const person = getPerson(organizationId, personId, db)
  if (!person) return undefined
  return person.connectedAt !== null
}
