/**
 * Repository for `people` and `person_identities` (PPL-1, PPL-2, PPL-3).
 *
 * A person is the human a course serves — usually a student — reached
 * through one identity per surface (Discord, web, MCP). Every function here
 * is scoped by `organizationId`, its first parameter — there is no
 * exception in this file (TEN-2).
 */

import BetterSqlite3 from 'better-sqlite3'
import { and, eq } from 'drizzle-orm'

import type { Database } from '../client.js'
import { people, personIdentities, type Surface } from '../schema.js'

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

/** Look up a person by id, scoped to `organizationId`. */
export function getPerson(
  organizationId: string,
  personId: string,
  db: Database
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
