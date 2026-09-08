/**
 * Repository for `discord_server_bindings` (TEN-3, TEN-6).
 *
 * The record that binds one Discord server to one organization. The
 * snowflake is the table's primary key (see `schema.ts`), so a second
 * `INSERT` for an already-bound server is refused by SQLite itself before any
 * code in this file runs — TEN-3 holds even if a future caller bypasses these
 * functions and writes to the table directly.
 */

import BetterSqlite3 from 'better-sqlite3'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'

import type { Database, Executor } from '../client.js'
import { courses, discordServerBindings } from '../schema.js'
import { getMembership } from './memberships.js'

export type DiscordServerBinding = typeof discordServerBindings.$inferSelect

/**
 * Resolve a Discord server's snowflake to its active binding.
 *
 * TEN-2 exception #2: unscoped by design. This *is* the lookup that
 * establishes which organization an incoming Discord message belongs to, so
 * it cannot itself take an organization id — nothing has determined one yet.
 * A removed binding (TEN-6: `removed_at` set) resolves to `undefined`, the
 * same as a server that was never bound: the bot has left, so no organization
 * owns this server's messages any more.
 */
export function resolveDiscordServerBinding(
  serverId: string,
  db: Database
): DiscordServerBinding | undefined {
  return db
    .select()
    .from(discordServerBindings)
    .where(
      and(
        eq(discordServerBindings.serverId, serverId),
        isNull(discordServerBindings.removedAt)
      )
    )
    .get()
}

/** Fields the caller supplies when claiming a Discord server. */
export interface ClaimDiscordServer {
  serverId: string
  installedByAccountId: string
}

/**
 * Claim a Discord server for an organization.
 *
 * Refused, up front: `installedByAccountId` is not a member of
 * `organizationId` — the foreign key only proves the account exists
 * *somewhere*, not that it administers *this* organization, and a foreign
 * tenant's account must not be recordable as the installer. (This is only
 * the data-layer half of TEN-4's fuller "verify the account actually
 * administers the Discord server" check, which belongs to the phase with
 * the OAuth flow.)
 *
 * Otherwise, three outcomes:
 *  - the snowflake has never been bound: insert a fresh binding. If a
 *    concurrent claim wins the race, SQLite's primary key refuses the second
 *    insert; that failure is caught here and reported the same way as any
 *    other "already claimed elsewhere" outcome — `undefined`, not a thrown
 *    driver error a caller would have to pattern-match on.
 *  - it was bound and later removed (TEN-6, `removed_at` set): re-bind it to
 *    `organizationId`, which may or may not be who held it before (TEN-3
 *    explicitly allows re-claiming a released server). The `UPDATE` repeats
 *    `removed_at IS NULL` — the same condition that qualified `existing` — so
 *    a concurrent claim that re-binds the row first makes this one a no-op
 *    rather than a silent second write to a binding that is actively bound
 *    again by the time this statement runs; the loser gets `undefined`.
 *  - it is actively bound (`removed_at` is null) to a *different*
 *    organization: refused — returns `undefined` rather than throwing,
 *    because "already claimed elsewhere" is a routine outcome an installer
 *    flow needs to handle, not an exceptional one. Actively bound to the same
 *    organization already is idempotent: the existing binding is returned
 *    unchanged.
 */
/**
 * TEN-9 — the moment a *second* active binding appears for an organization
 * is exactly the moment a null `courses.discord_server_id` stops meaning
 * "the organization's only server" and starts meaning "undecided which of
 * two." Left alone, every course that had ever routed through the
 * organization's one server before this claim would go silently unrouted
 * the instant this claim commits: `resolveCourseDiscordServer` and
 * `packages/discord`'s own routing filter can no longer tell "always meant
 * this one server" apart from "genuinely never assigned," and a null column
 * now resolves to neither. Backfilling here, once, at the exact transition
 * from one active binding to two, converts every course that implicitly
 * meant the organization's *previous* sole binding into one that says so
 * explicitly — continuity preserved by recording what was always true,
 * rather than guessed at read time. See `docs/DECISIONS.md` for why this
 * was chosen over "fail loudly and visibly instead."
 *
 * Runs only on the exact 1-to-2 transition (`active.length === 2` after
 * this claim, one of the two being the server just claimed) — a third
 * binding, or a binding re-claimed while the organization already held two
 * or more, changes nothing here: a null-column course in an organization
 * that is already ambiguous is correctly refused at its next enable
 * (`repos/courses.ts`), the outcome TEN-9 actually wants once there is no
 * longer a single "previous" server left to attribute it to.
 *
 * Called from both `claimDiscordServerBinding` success paths — the fresh
 * insert and the re-claim of a released binding — since either can be the
 * write that takes an organization from one active binding to two.
 */
function backfillNullServerCoursesOnNewSecondBinding(
  organizationId: string,
  justClaimedServerId: string,
  db: Executor
): void {
  const active = db
    .select()
    .from(discordServerBindings)
    .where(
      and(
        eq(discordServerBindings.organizationId, organizationId),
        isNull(discordServerBindings.removedAt)
      )
    )
    .all()
  if (active.length !== 2) return
  const previous = active.find(
    (binding) => binding.serverId !== justClaimedServerId
  )
  if (!previous) return
  db.update(courses)
    .set({ discordServerId: previous.serverId })
    .where(
      and(
        eq(courses.organizationId, organizationId),
        isNull(courses.discordServerId)
      )
    )
    .run()
}

export function claimDiscordServerBinding(
  organizationId: string,
  input: ClaimDiscordServer,
  db: Database
): DiscordServerBinding | undefined {
  // TEN-4 (data-layer half): the installer must actually belong to the
  // organization claiming the server.
  if (!getMembership(organizationId, input.installedByAccountId, db)) {
    return undefined
  }

  const existing = db
    .select()
    .from(discordServerBindings)
    .where(eq(discordServerBindings.serverId, input.serverId))
    .get()

  if (!existing) {
    try {
      const claimed = db
        .insert(discordServerBindings)
        .values({
          serverId: input.serverId,
          organizationId,
          installedByAccountId: input.installedByAccountId,
          installedAt: Date.now(),
        })
        .returning()
        .get()
      // TEN-9 — see `backfillNullServerCoursesOnNewSecondBinding`'s own
      // comment: this may be the write that takes the organization from one
      // active binding to two.
      backfillNullServerCoursesOnNewSecondBinding(
        organizationId,
        input.serverId,
        db
      )
      return claimed
    } catch (error) {
      // A concurrent insert claimed this snowflake first: SQLite's primary
      // key on `server_id` refuses the second insert. Report it the same way
      // as every other "already claimed elsewhere" outcome, not as a thrown
      // driver error the caller has to recognise by string.
      if (
        error instanceof BetterSqlite3.SqliteError &&
        error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
      ) {
        return undefined
      }
      throw error
    }
  }

  if (existing.removedAt === null) {
    return existing.organizationId === organizationId ? existing : undefined
  }

  // TEN-3 / TEN-6: a released binding can be re-claimed by any organization.
  // `removed_at IS NULL` here — not just `server_id = ?` — makes this a
  // single conditional write: a concurrent claim that re-binds the row
  // between the `SELECT` above and this `UPDATE` makes the row no longer
  // match, so `.get()` returns no row and this caller is refused rather than
  // silently overwriting the winner's binding.
  const reclaimed = db
    .update(discordServerBindings)
    .set({
      organizationId,
      installedByAccountId: input.installedByAccountId,
      installedAt: Date.now(),
      removedAt: null,
    })
    .where(
      and(
        eq(discordServerBindings.serverId, input.serverId),
        isNotNull(discordServerBindings.removedAt)
      )
    )
    .returning()
    .get()
  // TEN-9 — same reasoning as the fresh-insert branch above: a re-claim of a
  // released binding can just as well be the write that takes the
  // organization from one active binding to two. A losing concurrent
  // re-claim (`reclaimed` undefined — the race this function's own module
  // comment already documents) backfills nothing, since it did not actually
  // change the organization's active-binding count.
  if (reclaimed) {
    backfillNullServerCoursesOnNewSecondBinding(
      organizationId,
      input.serverId,
      db
    )
  }
  return reclaimed
}

/**
 * Mark a binding removed (TEN-6). Never deletes the row — a re-installation
 * must be able to see who held the server before, and `claimDiscordServerBinding`
 * needs the row to exist to re-claim it.
 *
 * Returns the number of rows changed: `0` when the server is not bound at
 * all, already removed, or bound to a *different* organization — an
 * organization can only remove its own binding.
 */
export function removeDiscordServerBinding(
  organizationId: string,
  serverId: string,
  db: Database
): number {
  const result = db
    .update(discordServerBindings)
    .set({ removedAt: Date.now() })
    .where(
      and(
        eq(discordServerBindings.serverId, serverId),
        eq(discordServerBindings.organizationId, organizationId),
        isNull(discordServerBindings.removedAt)
      )
    )
    .run()
  return result.changes
}

/**
 * The active binding for `serverId`, scoped to `organizationId` —
 * `undefined` both when no such binding exists and when it exists but
 * belongs to a different organization (TEN-5) or has already been removed
 * (TEN-6). Unlike `resolveDiscordServerBinding` above (TEN-2 exception #2,
 * organization-independent by necessity — nothing has determined an
 * organization yet at that point), this is reached only once an
 * organization is already known — `@bloombot/actions`'
 * `discordServers.remove`'s own policy — so it takes one, the convention
 * every other function in this file but that one holds itself to.
 */
export function getActiveDiscordServerBinding(
  organizationId: string,
  serverId: string,
  db: Database
): DiscordServerBinding | undefined {
  return db
    .select()
    .from(discordServerBindings)
    .where(
      and(
        eq(discordServerBindings.serverId, serverId),
        eq(discordServerBindings.organizationId, organizationId),
        isNull(discordServerBindings.removedAt)
      )
    )
    .get()
}

/** Every binding — active or removed — an organization has ever held. */
export function listDiscordServerBindingsForOrganization(
  organizationId: string,
  db: Database
): DiscordServerBinding[] {
  return db
    .select()
    .from(discordServerBindings)
    .where(eq(discordServerBindings.organizationId, organizationId))
    .all()
}

/**
 * The "exactly one binding" reading some callers still legitimately want —
 * kept for anything that is asking about the organization as a whole, not
 * about a particular course. `undefined` when the organization holds no
 * active binding, or (TEN-9) more than one: this function still cannot say
 * which of several bindings is meant, on purpose — callers that used to
 * reach for this to resolve *a course's* server should use
 * `resolveCourseDiscordServer` below instead, which can, because a course
 * carries its own `discordServerId`.
 */
export function getActiveDiscordServerBindingForOrganization(
  organizationId: string,
  db: Database
): DiscordServerBinding | undefined {
  const active = db
    .select()
    .from(discordServerBindings)
    .where(
      and(
        eq(discordServerBindings.organizationId, organizationId),
        isNull(discordServerBindings.removedAt)
      )
    )
    .all()
  return active.length === 1 ? active[0] : undefined
}

/**
 * TEN-9 — pick the server id `discordServerId` (a course's own reference,
 * possibly `null`) resolves to, given the organization's *active* bindings
 * already fetched. Pure and query-free so `resolveCourseDiscordServer`
 * (below) and `repos/courses.ts`'s PROJ-3 collision check — which resolves
 * every collision candidate's server against the same active-bindings list,
 * not one query per candidate — can share it.
 *
 * A non-null `discordServerId` resolves only if it names one of
 * `activeBindings` — a course pointed at a binding that has since been
 * removed (TEN-6) does not fall back to anything, it is simply unresolved.
 * A `null` `discordServerId` resolves only when there is exactly one active
 * binding to fall back to; zero active bindings resolves to `undefined` too
 * (nothing to fall back to, but see `resolveCourseDiscordServer` below for
 * why that is *not* the same as "ambiguous" — the two mean opposite things
 * for a caller deciding whether to refuse), and two-or-more is genuinely
 * ambiguous.
 */
export function pickCourseServerId(
  discordServerId: string | null,
  activeBindings: DiscordServerBinding[]
): string | undefined {
  if (discordServerId !== null) {
    return activeBindings.find(
      (binding) => binding.serverId === discordServerId
    )?.serverId
  }
  return activeBindings.length === 1
    ? activeBindings.at(0)?.serverId
    : undefined
}

/**
 * Why `resolveCourseDiscordServer` refused to proceed — deliberately just
 * these two, not three: an organization with *no* active binding at all is
 * not undecidable, it is simply "nothing to route into yet" (see that
 * function's own comment for why that must not block a save or an enable).
 */
export type CourseServerResolutionRefusal =
  // The column is null and the organization holds two or more active
  // bindings, so nothing picks one.
  | 'ambiguous'
  // The column names a binding that is no longer active (TEN-6: the install
  // was removed after the course was pointed at it).
  | 'removed'

export type CourseServerResolution =
  // `binding` is `undefined` exactly when the organization holds no active
  // binding at all and the column is null — a resolved "no server", not a
  // refusal. A caller that actually needs a guild to act on (scaffolding)
  // treats an `undefined` binding as its own refusal; a caller only using
  // this to decide what a course may enable or collide with (`repos/courses.ts`)
  // does not, matching TEN-9's "an organization with exactly one active
  // binding keeps working unchanged" all the way down to zero.
  | { ok: true; binding: DiscordServerBinding | undefined }
  | { ok: false; reason: CourseServerResolutionRefusal }

/**
 * TEN-9 — resolve *a course's* Discord server: its own `discordServerId`
 * when set, or the organization's single active binding when it is null and
 * unambiguous. Replaces `getActiveDiscordServerBindingForOrganization`'s
 * silent "refuse a two-binding organization" behaviour for every caller
 * that is really asking "which server does this course belong to" —
 * `apps/worker/src/handlers/discord-scaffold.ts` and `repos/courses.ts`'s
 * PROJ-3 collision check and enablement guard.
 *
 * Refuses (`ok: false`) only when it is genuinely undecidable — the column
 * is null with two-or-more active bindings, or the column names a binding
 * that is no longer active — never by picking one of several candidates
 * arbitrarily. Zero active bindings is *not* a refusal: it resolves to
 * `{ ok: true, binding: undefined }`, so a course created (and even one
 * enabled) before an organization has installed the bot anywhere keeps
 * working exactly as it did before this column existed — an instructor
 * routinely defines courses before installing Discord, and TEN-9's own
 * requirement is that this migration edits no existing course's behaviour.
 */
export function resolveCourseDiscordServer(
  organizationId: string,
  discordServerId: string | null,
  db: Executor
): CourseServerResolution {
  const active = db
    .select()
    .from(discordServerBindings)
    .where(
      and(
        eq(discordServerBindings.organizationId, organizationId),
        isNull(discordServerBindings.removedAt)
      )
    )
    .all()

  const resolvedId = pickCourseServerId(discordServerId, active)
  if (resolvedId) {
    // `resolvedId` came from `active` in `pickCourseServerId`, so this find
    // cannot miss.
    return { ok: true, binding: active.find((b) => b.serverId === resolvedId)! }
  }
  if (discordServerId !== null) return { ok: false, reason: 'removed' }
  if (active.length === 0) return { ok: true, binding: undefined }
  return { ok: false, reason: 'ambiguous' }
}
