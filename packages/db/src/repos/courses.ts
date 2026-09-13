/**
 * Repository for `courses`, `course_categories` and `course_channels`
 * (PROJ-1, PROJ-3).
 *
 * Every function here is scoped by `organizationId`, its first parameter —
 * there is no exception in this file (TEN-2).
 *
 * PROJ-3, the rule this file exists to protect: a course's category names
 * and its two role names must be unique across every *enabled* course **in
 * the same Discord server** (TEN-9 — PROJ-3's own text always said "unique
 * across every enabled course in that server"; the check used to be
 * organization-wide because an organization only ever held one server, but
 * TEN-9 lets it hold several, so two courses that route into different
 * servers may now share names, and two in the same server still may not),
 * regardless of project — a course in an archived project, or a disabled
 * course, is excluded. This cannot be a SQL constraint the way
 * `projects`' name uniqueness is (`schema.ts`): it spans three tables
 * (`courses`, `projects`, `course_categories`), depends on two other rows'
 * state (`courses.enabled`, `projects.archivedAt`), and its refusal has to
 * *name* the conflicting project and course — a `CHECK` constraint can
 * refuse a write, but it cannot explain one. So it is a repo-level check,
 * run before every create or update, following `discord-servers.ts`'s
 * pattern of reporting a routine refusal as a normal return value rather
 * than a thrown error — with one difference: a collision needs to carry
 * *what* it collided with, so the refusal here is a small result object
 * (`{ ok: false, conflict }`) rather than `undefined`.
 */

import { and, eq, inArray, isNull, or } from 'drizzle-orm'

import type { Database, TransactingExecutor } from '../client.js'
import { writeTransaction } from '../client.js'
import {
  pickCourseServerId,
  resolveCourseDiscordServer,
  type CourseServerResolutionRefusal,
} from './discord-servers.js'
import {
  courseCategories,
  courseChannels,
  courses,
  discordServerBindings,
  projects,
  type ConversationScope,
} from '../schema.js'

export type Course = typeof courses.$inferSelect
export type CourseCategory = typeof courseCategories.$inferSelect
export type CourseChannel = typeof courseChannels.$inferSelect
type ProjectRow = typeof projects.$inferSelect

/**
 * The subset of `Database`'s query methods the transaction helpers below
 * need. `db.transaction(...)`'s own callback parameter lacks `$client` (it
 * is not a connection you can close), so it does not satisfy `Database`
 * itself — but it does satisfy this, which is all reading and writing rows
 * inside a transaction actually requires.
 */
type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>

/** A category with its channels attached, in declared order. */
export interface CourseCategoryWithChannels extends CourseCategory {
  channels: CourseChannel[]
}

/** A course with its categories (and their channels) attached, in order. */
export interface CourseWithCategories extends Course {
  categories: CourseCategoryWithChannels[]
}

/** A channel the caller supplies when saving a course's categories (CFG-4). */
export interface NewCourseChannel {
  name: string
  adminsOnly: boolean
}

/** A category the caller supplies when saving a course (CFG-4). */
export interface NewCourseCategory {
  name: string
  channels: NewCourseChannel[]
}

/** Fields the caller supplies when creating or updating a course. */
export interface NewCourse {
  /** Defaults to `crypto.randomUUID()` when omitted, only used on create. */
  id?: string
  projectId: string
  title: string
  enabled: boolean
  // PROJ-7 — `null` means this course names no role at all (not a role
  // literally named ""): the platform then does not attempt role-based
  // identification for it (`schema.ts`'s own comment on the column). Not
  // optional (unlike `promptId`/`model` below) — a caller must always say
  // which of the two, `null` included; `@bloombot/actions`' `courses.save`
  // resolves its own optional input to one or the other before this ever
  // sees it (that action's own `keepOrClear`).
  adminsRole: string | null
  studentsRole: string | null
  promptId?: string | null
  instructions?: string | null
  model?: string | null
  vectorStoreId?: string | null
  maxRequestsPerDay?: number | null
  // CONV-1 — defaults to `'course'` when omitted, matching
  // `courses.conversationScope`'s own database default (`schema.ts`). Read
  // by `repos/conversations.ts#getOrCreateConversation` on every call, not
  // cached anywhere, so a later `updateCourse` changing this takes effect
  // immediately (see `docs/DECISIONS.md` D-13 for what that does — and does
  // not — do to a conversation already on disk).
  conversationScope?: ConversationScope
  // ENRL-13 — defaults to `false` when omitted, matching
  // `courses.selfEnrolFromDiscord`'s own database default (`schema.ts`).
  // Read by `@bloombot/discord`'s `handle-mention.ts` on every routed
  // message, not cached anywhere.
  selfEnrolFromDiscord?: boolean
  // ENRL-14 — defaults to `true` when omitted, matching
  // `courses.answerUnenrolled`'s own database default (`schema.ts`). Read
  // by `@bloombot/discord`'s `handle-mention.ts` before `answerQuestion` is
  // ever called.
  answerUnenrolled?: boolean
  // TEN-9 — which of the organization's Discord servers this course routes
  // in. `undefined`/`null` (both mean "not set" here — `undefined` is what a
  // caller omits, `null` is what a re-save that wants to clear a previously
  // set value sends) resolves through `resolveCourseDiscordServer` below:
  // the organization's own single active binding when it has exactly one,
  // otherwise undecidable. Validated as an *active* binding of this
  // organization by `@bloombot/actions`' `courses.save` (TEN-5) before this
  // ever sees it — this file only resolves, it does not re-check ownership.
  discordServerId?: string | null
  categories: NewCourseCategory[]
}

/**
 * The fields the PROJ-3 checks below (`findCourseNameConflict`,
 * `findSelfConflict`) actually need — just the two role names and the
 * category names, not a full `NewCourseCategory[]` with its channels.
 * `enableCourse` and `findProjectUnarchiveConflict` build this from rows
 * already read from the database, which never carry channels alongside a
 * category's name; `NewCourse`'s own `categories: NewCourseCategory[]` is
 * still assignable here, so `createCourse` and `updateCourse` pass `input`
 * straight through.
 */
interface NameCheckInput {
  adminsRole: string | null
  studentsRole: string | null
  categories: { name: string }[]
}

/**
 * What a save refusal names: the field, the name, and what it collided with.
 * `'projectId'` is TEN-5's guard (below), not PROJ-3's — it has no
 * conflicting course or project to name, only the id that does not belong to
 * this organization, so `conflictingProjectName`/`conflictingCourseTitle` are
 * optional rather than required for every field. `'discordServerId'` is
 * TEN-9's enablement guard: which of the two undecidable cases applied is
 * carried in `message`, not a separate field — there is no conflicting
 * course or project to name, only a Discord server binding this course
 * cannot resolve to.
 */
export interface CourseNameConflict {
  field:
    'category' | 'adminsRole' | 'studentsRole' | 'projectId' | 'discordServerId'
  name: string
  conflictingProjectName?: string
  conflictingCourseTitle?: string
  message: string
}

export type SaveCourseResult =
  | { ok: true; course: CourseWithCategories }
  | { ok: false; conflict: CourseNameConflict }

/** A candidate course (and its project) PROJ-3 checks `input` against. */
interface CollisionCandidate {
  id: string
  title: string
  adminsRole: string | null
  studentsRole: string | null
  projectName: string
  discordServerId: string | null
}

function conflict(
  field: CourseNameConflict['field'],
  name: string,
  candidate: CollisionCandidate,
  // SRV-11 round 2: the candidate's own spelling of the colliding role
  // name, set only when the loop below found a role collision — `name` is
  // the *caller's* own spelling, and the two can differ under Discord's
  // case/whitespace-insensitive matching, which is exactly the collision
  // this check now catches. Without this, an instructor naming "staff" was
  // told it collides with a course that visibly uses "Staff", with no hint
  // the two spellings are the same role to Discord at all — the same defect
  // SRV-10 round 3 fixed for `findSelfConflict`'s own message, reworked here
  // for the cross-course one.
  candidateName?: string
): CourseNameConflict {
  const kind = field === 'category' ? 'Category' : 'Role'
  const sameSpelling = candidateName === undefined || candidateName === name
  const message = sameSpelling
    ? `${kind} name "${name}" is already used by course "${candidate.title}" ` +
      `in project "${candidate.projectName}".`
    : `Role name "${name}" is already used by course "${candidate.title}" ` +
      `in project "${candidate.projectName}" as "${candidateName}"; Discord ` +
      `treats the two as the same role, ignoring case and surrounding whitespace.`
  return {
    field,
    name,
    conflictingProjectName: candidate.projectName,
    conflictingCourseTitle: candidate.title,
    message,
  }
}

/**
 * TEN-9 — the refusal `enableCourse`, `createCourse` and `updateCourse` all
 * return when a course's own Discord server is genuinely undecidable
 * (`resolveCourseDiscordServer`'s two refusal reasons — *not* "no active
 * binding at all", which that function resolves rather than refuses; see its
 * own comment). Reported through the same `CourseNameConflict` channel as a
 * PROJ-3 collision rather than a distinct result type, so every save path
 * already threading `SaveCourseResult`/`EnableCourseResult` through gets this
 * refusal for free.
 */
function serverResolutionConflict(
  reason: CourseServerResolutionRefusal,
  // Cheap-fix 5 (coordinator round 1 rework): required, not optional —
  // `createCourse`/`updateCourse`/`enableCourse` always have the course's
  // own title in hand (`input.title`/`existing.title`) for the course this
  // refusal is about, and `findProjectUnarchiveConflict` — the one caller
  // that loops over more than one course — is exactly the case that used
  // to say "this course does not say which one it routes in" without
  // naming which of a project's twenty enabled courses that was.
  courseTitle: string
): CourseNameConflict {
  const message =
    reason === 'ambiguous'
      ? `Course "${courseTitle}" — this organization has more than one ` +
        'active Discord server, and this course does not say which one it ' +
        'routes in. Choose a server before enabling it.'
      : `Course "${courseTitle}" — its Discord server is no longer active ` +
        '— its install was removed. Choose an active server before ' +
        'enabling it.'
  return {
    field: 'discordServerId',
    name: reason,
    conflictingCourseTitle: courseTitle,
    message,
  }
}

/**
 * PROJ-3's check. Looks across every *other* enabled course, in a
 * non-archived project, in this organization, **routing in the same Discord
 * server as `targetServerId`** (TEN-9 — PROJ-3's own text always said
 * "unique across every enabled course in *that server*"; two courses in
 * different servers may share category and role names, since Discord itself
 * only requires uniqueness within one guild), for a category name or role
 * name `input` would collide with. `excludeCourseId` leaves the course being
 * updated out of its own candidate set — the case a naive implementation
 * misses is a course renamed into a collision that only appears because the
 * check was comparing the course against itself.
 *
 * `includeProjectId`, when set, also treats courses in that project as
 * candidates even though its `projects.archivedAt` may not be `null` yet —
 * `unarchiveProject` (`repos/projects.ts`) uses this to check what a project
 * *would* collide with before it is actually unarchived, since its own
 * courses are otherwise invisible to this check while their project is still
 * archived.
 *
 * `db` accepts `Executor`, not just `Database`: `createCourse` and
 * `updateCourse` call this from inside their own transaction (D-12's
 * "Limits" — this check has no SQL constraint backing it, so running it and
 * the write in the same transaction is the only thing this package can do to
 * narrow the race between two concurrent saves).
 *
 * SRV-11: role names are compared to every candidate's own role names
 * normalized (`normalizeRoleName`, below) rather than by exact string — the
 * same reasoning as `findSelfConflict`'s SRV-10 rework, just applied across
 * courses instead of within one. `checkRoles` (default `true`) mirrors
 * `findSelfConflict`'s own option, for the same reason: `updateCourse` skips
 * this half of the check when the incoming role pair is byte-identical to
 * what is already stored, so a save that leaves an already-colliding pair
 * untouched (grandfathered from before this check existed) still goes
 * through, and only a save that actually changes a role name is checked in
 * full against every other course.
 */
function findCourseNameConflict(
  organizationId: string,
  input: NameCheckInput,
  // `undefined` is itself a resolved target (`resolveCourseDiscordServer`'s
  // "no active binding at all" case) — every candidate whose own server also
  // resolves to `undefined` is still a legitimate collision candidate, which
  // is what keeps this check organization-wide, exactly as it was before
  // TEN-9, for an organization that has not installed the bot anywhere yet.
  targetServerId: string | undefined,
  db: Executor,
  options: {
    excludeCourseId?: string
    includeProjectId?: string
    checkRoles?: boolean
  } = {}
): CourseNameConflict | undefined {
  const { excludeCourseId, includeProjectId } = options
  const checkRoles = options.checkRoles ?? true
  const allCandidates = db
    .select({
      id: courses.id,
      title: courses.title,
      adminsRole: courses.adminsRole,
      studentsRole: courses.studentsRole,
      projectName: projects.name,
      discordServerId: courses.discordServerId,
    })
    .from(courses)
    .innerJoin(projects, eq(courses.projectId, projects.id))
    .where(
      and(
        eq(courses.organizationId, organizationId),
        eq(courses.enabled, true),
        // PROJ-2: a course in an archived project does not route, so it is
        // not a candidate for a collision — unless `includeProjectId` names
        // it explicitly (see above).
        includeProjectId
          ? or(
              isNull(projects.archivedAt),
              eq(courses.projectId, includeProjectId)
            )
          : isNull(projects.archivedAt)
      )
    )
    .all()
    .filter((candidate) => candidate.id !== excludeCourseId)

  // TEN-9 — narrow to candidates that resolve to `targetServerId`. Resolved
  // against the same active-bindings list for every candidate (one query,
  // not one per candidate) via `pickCourseServerId` — a candidate whose own
  // `discordServerId` is null falls back to the organization's single active
  // binding exactly the way `resolveCourseDiscordServer` resolved `input`'s.
  const activeBindings = db
    .select()
    .from(discordServerBindings)
    .where(
      and(
        eq(discordServerBindings.organizationId, organizationId),
        isNull(discordServerBindings.removedAt)
      )
    )
    .all()
  const candidates = allCandidates.filter(
    (candidate) =>
      pickCourseServerId(candidate.discordServerId, activeBindings) ===
      targetServerId
  )

  // Cheap fix (SRV-11 round 2): hoisted above both the role and category
  // checks, not just the category one — with `checkRoles` false this used
  // to sit between the two, reading as if it guarded the role loop when it
  // guards nothing there at all (an empty `candidates` array already finds
  // no `hit`).
  if (candidates.length === 0) return undefined

  // Role names: `input`'s admin and student role must each be absent from
  // every candidate's admin *and* student role — a role name is one shared
  // pool, not two separate ones. Compared normalized (SRV-11), the same way
  // Discord itself would resolve them, so "Staff" and "staff" collide across
  // courses exactly as they already do within one (SRV-10).
  if (checkRoles) {
    for (const [field, roleName] of [
      ['adminsRole', input.adminsRole],
      ['studentsRole', input.studentsRole],
    ] as const) {
      // PROJ-7 — an absent role (`null`) is never a candidate for a
      // collision: it names nothing to collide with, unlike an empty
      // string, which this schema no longer even permits. Without this,
      // `normalizeRoleName(null) === normalizeRoleName(null)` would be
      // `true`, so two courses that both name no role would wrongly
      // collide with each other the moment either one is (re-)saved.
      if (roleName === null) continue
      const normalized = normalizeRoleName(roleName)
      const hit = candidates.find(
        (candidate) =>
          normalizeRoleName(candidate.adminsRole) === normalized ||
          normalizeRoleName(candidate.studentsRole) === normalized
      )
      if (hit) {
        // The candidate's *own* spelling of whichever role matched — not
        // necessarily `hit.adminsRole` — so the message can quote both
        // sides rather than telling an instructor their string collides
        // with a course that visibly uses a different one.
        // Never actually `null`: `hit` only matched because one of its own
        // role names normalized equal to `normalized`, which is itself
        // never `null` here (the `roleName === null` guard above already
        // `continue`d past that case) — the `?? undefined` is only to
        // satisfy `conflict`'s optional `string`, not a real fallback.
        const candidateName =
          (normalizeRoleName(hit.adminsRole) === normalized
            ? hit.adminsRole
            : hit.studentsRole) ?? undefined
        return conflict(field, roleName, hit, candidateName)
      }
    }
  }

  // Category names: every candidate's own categories, looked up in one
  // query rather than one per candidate.
  const categoryRows = db
    .select({
      name: courseCategories.name,
      courseId: courseCategories.courseId,
    })
    .from(courseCategories)
    .where(
      inArray(
        courseCategories.courseId,
        candidates.map((candidate) => candidate.id)
      )
    )
    .all()
  const candidatesById = new Map(
    candidates.map((candidate) => [candidate.id, candidate])
  )

  for (const category of input.categories) {
    const hit = categoryRows.find((row) => row.name === category.name)
    if (hit) {
      // `hit.courseId` is drawn from `candidates`, so this lookup cannot miss.
      const candidate = candidatesById.get(hit.courseId)
      if (candidate) return conflict('category', category.name, candidate)
    }
  }

  return undefined
}

/**
 * SRV-10's own rework: `discordServers.scaffold`/`roster.import`
 * (`apps/worker`) resolve a course's role names against a Discord guild's
 * own roles case- and whitespace-insensitively (each handler's own
 * `resolveRoleId`) — the same normalization Discord's own UI effectively
 * imposes, since two roles differing only by case read as the same thing to
 * anyone administering the server by hand. `findSelfConflict`, below, has to
 * compare `adminsRole`/`studentsRole` the same way, not by exact string:
 * before this, a course naming `adminsRole: "Staff"` and
 * `studentsRole: "staff"` passed this check as two different names, and
 * `apps/worker`'s own SRV-10 role-creation code then resolved both names
 * onto the *same* Discord role — silently granting the admins-only
 * overwrite to every student. See `docs/DECISIONS.md` for the fuller
 * reasoning behind reaching into this repo from what started as a
 * worker-only slice.
 */
// PROJ-7 — `null` in, `null` out: an absent role never normalizes to a
// string another candidate's own normalized name could accidentally equal.
function normalizeRoleName(name: string | null): string | null {
  return name === null ? null : name.trim().toLowerCase()
}

/**
 * PROJ-3 within a single course: an admin and student role that are the same
 * name, or two categories that share a name, break the "unique across every
 * enabled course" invariant inside one course rather than across two — the
 * cross-course check above cannot see this, since it only ever compares
 * `input` against *other* courses. Checked before the cross-course check so
 * a self-conflicting input is refused for the reason that actually applies
 * to it, not misreported as colliding with a candidate it never reached.
 *
 * SRV-10 round 3, must-fix 1: `checkRoles` (default `true`, so `createCourse`
 * calls this exactly as before) lets `updateCourse` skip the role-aliasing
 * half of this check when the incoming pair is byte-identical to what is
 * already stored. Without it, a course saved *before* the normalized
 * comparison above existed — and stored with an aliasing pair — could never
 * be saved again for *any* reason: `courses.save` always sends both role
 * fields (they are required, unlike `promptId`/`vectorStoreId`'s "omitted
 * preserves stored"), so even a save that only renames the course or edits
 * a category re-submitted the same aliasing pair and was refused on a field
 * nothing about that save touched. The category-duplicate half of this
 * check always runs regardless — an update can introduce a duplicate
 * category name on its own, independent of whether the roles changed.
 */
function findSelfConflict(
  input: NameCheckInput,
  options: { checkRoles?: boolean } = {}
): CourseNameConflict | undefined {
  const checkRoles = options.checkRoles ?? true
  // PROJ-7 — both roles have to be *set* for this to mean anything: two
  // absent roles are not "the same role name" (`normalizeRoleName(null) ===
  // normalizeRoleName(null)` would otherwise say they are), and a course
  // naming only one role has nothing here to alias with the other.
  if (
    checkRoles &&
    input.adminsRole !== null &&
    input.studentsRole !== null &&
    normalizeRoleName(input.adminsRole) ===
      normalizeRoleName(input.studentsRole)
  ) {
    // SRV-10 round 3, must-fix 2: quotes *both* values (not only
    // `studentsRole`, which used to read as a mystery to an instructor
    // looking at two visibly different strings) and, when they are not the
    // same literal string, says plainly that Discord ignores the
    // difference — case and surrounding whitespace only. Names the Discord
    // tab explicitly: this message is the whole story for an MCP caller
    // (no `body.issues` accompanies an `action_conflict` the way one does
    // an `action_input_invalid`, so nothing else tells a caller where to
    // look — see `docs/DECISIONS.md`), and for the panel, which does not
    // switch tabs for a conflict either.
    const sameLiteralString = input.adminsRole === input.studentsRole
    return {
      field: 'studentsRole',
      name: input.studentsRole,
      message: sameLiteralString
        ? `Role name "${input.studentsRole}" is used for both the admins role and the students role of this course (Discord tab); they must be different.`
        : `Admins role "${input.adminsRole}" and students role "${input.studentsRole}" differ only in capitalization or surrounding whitespace, so Discord would treat them as the same role; rename one on the Discord tab so they are clearly different.`,
    }
  }

  const seenCategoryNames = new Set<string>()
  for (const category of input.categories) {
    if (seenCategoryNames.has(category.name)) {
      return {
        field: 'category',
        name: category.name,
        message: `Category name "${category.name}" is used more than once in this course.`,
      }
    }
    seenCategoryNames.add(category.name)
  }

  return undefined
}

/**
 * TEN-5: the foreign key on `courses.project_id` only proves `projectId`
 * refers to *some* project, not that it belongs to `organizationId` — the
 * same gap `claimDiscordServerBinding` (`repos/discord-servers.ts`) closes
 * for `installedByAccountId`. Left unchecked, a course could be saved
 * against another organization's project: its refusals would then quote
 * that project's name across the tenant boundary (TEN-5), and archiving the
 * foreign project would silently drop this organization's course out of the
 * PROJ-3 candidate set.
 *
 * Refused through the same `{ ok: false, conflict }` channel as a name
 * collision, not a thrown foreign-key error, so `createCourse` and
 * `updateCourse` can return it directly.
 *
 * `db` accepts `Executor`, not just `Database`: `createCourse` (below) now
 * takes `TransactingExecutor` (finding 1 of the PROJ-4/5/TEN-7/8 rework),
 * so this internal helper has to accept whatever `createCourse` is handed,
 * including another transaction's own `tx`.
 */
function loadOwnedProject(
  organizationId: string,
  projectId: string,
  db: Executor
):
  | { ok: true; project: ProjectRow }
  | { ok: false; conflict: CourseNameConflict } {
  const project = db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId)
      )
    )
    .get()

  if (!project) {
    return {
      ok: false,
      conflict: {
        field: 'projectId',
        name: projectId,
        message: `Project "${projectId}" does not belong to this organization.`,
      },
    }
  }

  return { ok: true, project }
}

/**
 * Insert `categories` (and their channels) for `courseId`, preserving
 * declared order in the `ordering` column. Not exported — only called from
 * inside this file's own transactions, where the id-scoping convention TEN-2
 * checks against exported functions does not apply.
 */
function insertCourseCategories(
  tx: Executor,
  organizationId: string,
  courseId: string,
  categories: NewCourseCategory[]
): CourseCategoryWithChannels[] {
  const now = Date.now()
  return categories.map((category, categoryIndex) => {
    const categoryId = crypto.randomUUID()
    const categoryRow: CourseCategory = {
      id: categoryId,
      organizationId,
      courseId,
      name: category.name,
      ordering: categoryIndex,
      createdAt: now,
    }
    tx.insert(courseCategories).values(categoryRow).run()

    const channels = category.channels.map((channel, channelIndex) => {
      const channelRow: CourseChannel = {
        id: crypto.randomUUID(),
        organizationId,
        categoryId,
        name: channel.name,
        adminsOnly: channel.adminsOnly,
        ordering: channelIndex,
        createdAt: now,
      }
      tx.insert(courseChannels).values(channelRow).run()
      return channelRow
    })

    return { ...categoryRow, channels }
  })
}

/**
 * Delete every category (and, through it, every channel) currently attached
 * to `courseId` — the first half of "replace a course's categories
 * coherently rather than leaving orphans" on update. Channels are deleted
 * first: nothing here relies on `ON DELETE CASCADE` (not part of D-2's
 * portable subset as used elsewhere in this package), so the child rows
 * have to go before their parent explicitly.
 */
function deleteCourseCategories(tx: Executor, courseId: string): void {
  const existingCategoryIds = tx
    .select({ id: courseCategories.id })
    .from(courseCategories)
    .where(eq(courseCategories.courseId, courseId))
    .all()
    .map((row) => row.id)

  if (existingCategoryIds.length === 0) return

  tx.delete(courseChannels)
    .where(inArray(courseChannels.categoryId, existingCategoryIds))
    .run()
  tx.delete(courseCategories)
    .where(eq(courseCategories.courseId, courseId))
    .run()
}

/**
 * Create a course with its categories and channels.
 *
 * Refused (TEN-5) when `input.projectId` does not belong to `organizationId`
 * — `loadOwnedProject`'s guard, above. Refused (PROJ-3) when a category name
 * or either role name collides with another enabled course's, in a
 * non-archived project, in this organization, or with itself (the same
 * admin and student role, or a repeated category name) — the refusal names
 * what it collided with rather than just failing. The PROJ-3 cross-course
 * check only applies when this save would actually route — `input.enabled`
 * and a non-archived project — since a disabled course, or one in an
 * archived project, introduces no collision (`schema.ts`'s `courses.enabled`
 * comment; disabling is PROJ-3's escape hatch and must stay usable even
 * while its names are currently taken elsewhere).
 *
 * `db` accepts `TransactingExecutor`, not just `Database` (finding 1 of the
 * PROJ-4/5/TEN-7/8 rework, matching `accounts.ts#createAccount`'s own
 * widening): called with a top-level connection, `db.transaction(...)`
 * below opens a real transaction exactly as before; called with another
 * transaction's own `tx` (`actions/projects.ts#duplicateProjectAction`,
 * composing a whole duplicate — the new project and every copied course —
 * atomically) it opens a nested savepoint instead, so a later failure
 * anywhere in that outer transaction rolls this course's insert back too.
 */
export function createCourse(
  organizationId: string,
  input: NewCourse,
  db: TransactingExecutor
): SaveCourseResult {
  const projectResult = loadOwnedProject(organizationId, input.projectId, db)
  if (!projectResult.ok) return projectResult

  const selfConflict = findSelfConflict(input)
  if (selfConflict) return { ok: false, conflict: selfConflict }

  return writeTransaction(db, (tx) => {
    // Run inside the write transaction, not before it (D-12's "Limits"):
    // with no SQL constraint backing this check, running it and the write
    // in the same transaction is what narrows the race between two
    // concurrent saves, rather than eliminating it.
    if (input.enabled && projectResult.project.archivedAt === null) {
      // TEN-9 — a course may not be enabled while its own server is
      // undecidable (`resolveCourseDiscordServer`'s two refusal reasons).
      // Resolved before the PROJ-3 check so that check can scope its
      // candidates to the same server rather than the whole organization.
      const serverResolution = resolveCourseDiscordServer(
        organizationId,
        input.discordServerId ?? null,
        tx
      )
      if (!serverResolution.ok) {
        return {
          ok: false,
          conflict: serverResolutionConflict(
            serverResolution.reason,
            input.title
          ),
        }
      }
      const conflictFound = findCourseNameConflict(
        organizationId,
        input,
        serverResolution.binding?.serverId,
        tx
      )
      if (conflictFound) return { ok: false, conflict: conflictFound }
    }

    const courseId = input.id ?? crypto.randomUUID()
    const courseRow = tx
      .insert(courses)
      .values({
        id: courseId,
        organizationId,
        projectId: input.projectId,
        title: input.title,
        enabled: input.enabled,
        adminsRole: input.adminsRole,
        studentsRole: input.studentsRole,
        promptId: input.promptId ?? null,
        instructions: input.instructions ?? null,
        model: input.model ?? null,
        vectorStoreId: input.vectorStoreId ?? null,
        maxRequestsPerDay: input.maxRequestsPerDay ?? null,
        conversationScope: input.conversationScope ?? 'course',
        selfEnrolFromDiscord: input.selfEnrolFromDiscord ?? false,
        answerUnenrolled: input.answerUnenrolled ?? true,
        discordServerId: input.discordServerId ?? null,
        createdAt: Date.now(),
      })
      .returning()
      .get()

    const categories = insertCourseCategories(
      tx,
      organizationId,
      courseId,
      input.categories
    )

    return { ok: true, course: { ...courseRow, categories } }
  })
}

/**
 * Look up a course by id, scoped to `organizationId`, with its categories
 * and channels in order.
 *
 * `db` accepts `Executor`, not just `Database`: `actions/projects.ts#duplicateProjectAction`
 * (finding 1 of the PROJ-4/5/TEN-7/8 rework) calls this from inside its own
 * transaction, re-reading each source course inside the same atomic unit
 * that then copies it.
 */
export function getCourse(
  organizationId: string,
  courseId: string,
  db: Executor
): CourseWithCategories | undefined {
  const courseRow = db
    .select()
    .from(courses)
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .get()
  if (!courseRow) return undefined

  const categories = loadCourseCategories(organizationId, courseId, db)
  return { ...courseRow, categories }
}

/**
 * `courseId`'s categories, with their channels, in declared order —
 * `getCourse`'s own middle two selects, factored out so `updateCourseSettings`
 * (ACT-7) below can read a course's *current* categories back onto its
 * result without touching them, the same shape `getCourse` already returns.
 */
function loadCourseCategories(
  organizationId: string,
  courseId: string,
  db: Executor
): CourseCategoryWithChannels[] {
  const categoryRows = db
    .select()
    .from(courseCategories)
    .where(
      and(
        eq(courseCategories.courseId, courseId),
        eq(courseCategories.organizationId, organizationId)
      )
    )
    .orderBy(courseCategories.ordering)
    .all()

  return categoryRows.map((category) => ({
    ...category,
    channels: db
      .select()
      .from(courseChannels)
      .where(
        and(
          eq(courseChannels.categoryId, category.id),
          eq(courseChannels.organizationId, organizationId)
        )
      )
      .orderBy(courseChannels.ordering)
      .all(),
  }))
}

/**
 * List an organization's courses (base rows only — use `getCourse` for
 * categories and channels).
 *
 * `db` accepts `Executor`, not just `Database`: `actions/projects.ts#duplicateProjectAction`
 * (finding 1 of the PROJ-4/5/TEN-7/8 rework) calls this from inside its own
 * transaction, listing the source project's courses inside the same atomic
 * unit that then copies them.
 */
export function listCourses(
  organizationId: string,
  db: Executor,
  options?: { projectId?: string }
): Course[] {
  const conditions = [eq(courses.organizationId, organizationId)]
  if (options?.projectId) {
    conditions.push(eq(courses.projectId, options.projectId))
  }
  return db
    .select()
    .from(courses)
    .where(and(...conditions))
    .all()
}

/**
 * PORT-5: the title an imported course should actually be given in
 * `projectId` — `title` itself when nothing there is using it, otherwise
 * `title` with the lowest free numeric suffix appended (`Intro to CS` →
 * `Intro to CS 2` → `Intro to CS 3`).
 *
 * Importing a course into a project that already holds one of that name is
 * the ordinary case, not an error: it is how an instructor keeps a copy
 * beside the original. Nothing in the schema forbids two courses sharing a
 * title (PROJ-3 constrains role and category names, never titles), so this is
 * not a constraint being satisfied — it is a list of courses staying legible
 * to the person reading it.
 *
 * Two details are deliberate. The comparison is case- and
 * whitespace-insensitive, so `intro to cs` counts as the same title already
 * taken rather than producing two rows a reader cannot tell apart. And the
 * search takes the *lowest* free suffix rather than one past the highest, so
 * deleting `Intro to CS 2` and importing again refills that gap instead of
 * jumping to `4` — the numbers describe what is in the project now, not how
 * many imports have ever run.
 */
export function nextAvailableCourseTitle(
  organizationId: string,
  projectId: string,
  title: string,
  db: Executor
): string {
  const normalize = (value: string): string =>
    value.trim().replace(/\s+/g, ' ').toLowerCase()
  const taken = new Set(
    listCourses(organizationId, db, { projectId }).map((course) =>
      normalize(course.title)
    )
  )
  const base = title.trim()
  if (!taken.has(normalize(base))) return base
  // Bounded by the number of courses already in the project plus one: with
  // `n` titles taken, at most `n` of the candidates below can be, so a free
  // one is always found before the loop runs out.
  for (let suffix = 2; suffix <= taken.size + 2; suffix += 1) {
    const candidate = `${base} ${suffix}`
    if (!taken.has(normalize(candidate))) return candidate
  }
  // Unreachable by the bound above, guarded rather than assumed.
  return `${base} ${taken.size + 2}`
}

/**
 * The projection `routeMessage` (`@bloombot/core`'s `routing.ts`) actually
 * reads for one course — everything `RoutableCourse` needs, plus `title` for
 * the one place a title is needed after routing decides a course.
 * `discordServerId` is TEN-9's own addition, not something `routeMessage`
 * reads (`routeMessage` still knows nothing about servers — TEN-3/out of
 * scope for this slice): it is what the caller (`@bloombot/discord`'s
 * `handle-mention.ts`) filters this list down by *before* calling
 * `routeMessage`, so a message arriving in one server can never match a
 * course that belongs to a different server in the same organization.
 */
export interface RoutableCourseRow {
  id: string
  title: string
  categoryNames: string[]
  // PROJ-7 — `null` means this course names no role at all; `RoutableCourse`
  // (`@bloombot/core`'s `routing.ts`) carries the same nullability through.
  adminsRole: string | null
  studentsRole: string | null
  enabled: boolean
  discordServerId: string | null
}

/**
 * Finding 14 of the SURF-1 rework: `@bloombot/discord`'s `handleMention` used
 * to call `getCourse` once per course to build this same projection —
 * `getCourse` also loads every channel row routing never reads, so a
 * forty-course tenant paid roughly 161 queries (`listCourses` plus
 * `getCourse`'s three selects each) on the hot path for every mention. This
 * is two queries regardless of course count: one for the course rows
 * (join `projects` so PROJ-2 can be applied here, not by a caller that would
 * otherwise have to know about it), one for their category names, joined in
 * memory rather than per-course.
 *
 * PROJ-2/finding 2: a course in an archived project does not route — filtered
 * here by `isNull(projects.archivedAt)`, the same guard `findCourseNameConflict`
 * uses for PROJ-3's own candidate set, so an old course from a reused-name
 * archived term can neither answer nor make the live course `ambiguous` by
 * colliding with it.
 */
export function listRoutableCourses(
  organizationId: string,
  db: Database
): RoutableCourseRow[] {
  const courseRows = db
    .select({
      id: courses.id,
      title: courses.title,
      adminsRole: courses.adminsRole,
      studentsRole: courses.studentsRole,
      enabled: courses.enabled,
      discordServerId: courses.discordServerId,
    })
    .from(courses)
    .innerJoin(projects, eq(courses.projectId, projects.id))
    .where(
      and(
        eq(courses.organizationId, organizationId),
        isNull(projects.archivedAt)
      )
    )
    .all()

  if (courseRows.length === 0) return []

  const categoryRows = db
    .select({
      courseId: courseCategories.courseId,
      name: courseCategories.name,
    })
    .from(courseCategories)
    .where(
      inArray(
        courseCategories.courseId,
        courseRows.map((row) => row.id)
      )
    )
    .all()

  const categoryNamesByCourseId = new Map<string, string[]>()
  for (const row of categoryRows) {
    const names = categoryNamesByCourseId.get(row.courseId) ?? []
    names.push(row.name)
    categoryNamesByCourseId.set(row.courseId, names)
  }

  return courseRows.map((row) => ({
    ...row,
    categoryNames: categoryNamesByCourseId.get(row.id) ?? [],
  }))
}

/**
 * Update a course and replace its categories and channels.
 *
 * `undefined` when `courseId` does not exist or does not belong to
 * `organizationId` (TEN-2/TEN-5) — checked before the project-ownership and
 * PROJ-3 collision checks, so a caller cannot learn anything about another
 * organization's course, or another organization's project, by way of a
 * conflict message. Refused (TEN-5) when `input.projectId` does not belong
 * to `organizationId`, and refused (PROJ-3) the same way `createCourse` is,
 * with `excludeCourseId` set to `courseId` so a no-op re-save (or a rename
 * that keeps every name distinct) is never refused for colliding with
 * itself — see `createCourse` for when the PROJ-3 check applies.
 */
export function updateCourse(
  organizationId: string,
  courseId: string,
  input: NewCourse,
  db: Database
): SaveCourseResult | undefined {
  const existing = db
    .select()
    .from(courses)
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .get()
  if (!existing) return undefined

  const projectResult = loadOwnedProject(organizationId, input.projectId, db)
  if (!projectResult.ok) return projectResult

  // SRV-10 round 3, must-fix 1: the role-aliasing half of `findSelfConflict`
  // only runs when this save actually changes one (or both) role names —
  // `existing` is what is already stored, and `courses.save` always sends
  // both fields, so a save that leaves an already-aliasing pair exactly as
  // it was must go through untouched (an instructor renaming the course, or
  // editing anything else, is not the moment to refuse on a field nothing
  // about this save touched). A save that changes either name is checked in
  // full, including onto a *new* aliasing pair. The stored pair is still
  // caught loudly at scaffold time by `discord-scaffold.ts`'s own defense
  // in depth — this repo layer is not the only place it is refused, just
  // not the place that blocks unrelated work.
  const rolesChanged =
    input.adminsRole !== existing.adminsRole ||
    input.studentsRole !== existing.studentsRole
  const selfConflict = findSelfConflict(input, { checkRoles: rolesChanged })
  if (selfConflict) return { ok: false, conflict: selfConflict }

  return writeTransaction(db, (tx) => {
    if (input.enabled && projectResult.project.archivedAt === null) {
      const serverResolution = resolveCourseDiscordServer(
        organizationId,
        input.discordServerId ?? null,
        tx
      )
      if (!serverResolution.ok) {
        return {
          ok: false,
          conflict: serverResolutionConflict(
            serverResolution.reason,
            input.title
          ),
        }
      }
      // SRV-11 round 2: `rolesChanged` alone is *not* a sound gate here, the
      // way it is for `findSelfConflict` above. `findSelfConflict` only ever
      // reads `input`, so "the role names did not change" is the whole
      // question. `findCourseNameConflict`'s candidate set also depends on
      // `input.enabled`, `input.discordServerId` and `input.projectId` — all
      // three are on `courses.save`'s own schema, reachable from the panel
      // and MCP — so a save can move this course into a *different*
      // candidate set (a different server, a different project, or from
      // disabled into routing) without touching either role name at all,
      // and `rolesChanged` alone would then skip the role check entirely
      // while a save changing nothing else still ran it. Named separately
      // from `rolesChanged` on purpose: the two flags answer different
      // questions, and folding them into one flag is what let this gap in.
      const couldIntroduceCrossCourseCollision =
        rolesChanged ||
        input.enabled !== existing.enabled ||
        (input.discordServerId ?? null) !== existing.discordServerId ||
        input.projectId !== existing.projectId
      const conflictFound = findCourseNameConflict(
        organizationId,
        input,
        serverResolution.binding?.serverId,
        tx,
        {
          excludeCourseId: courseId,
          checkRoles: couldIntroduceCrossCourseCollision,
        }
      )
      if (conflictFound) return { ok: false, conflict: conflictFound }
    }

    const courseRow = tx
      .update(courses)
      .set({
        projectId: input.projectId,
        title: input.title,
        enabled: input.enabled,
        adminsRole: input.adminsRole,
        studentsRole: input.studentsRole,
        promptId: input.promptId ?? null,
        instructions: input.instructions ?? null,
        model: input.model ?? null,
        vectorStoreId: input.vectorStoreId ?? null,
        maxRequestsPerDay: input.maxRequestsPerDay ?? null,
        conversationScope: input.conversationScope ?? 'course',
        selfEnrolFromDiscord: input.selfEnrolFromDiscord ?? false,
        answerUnenrolled: input.answerUnenrolled ?? true,
        discordServerId: input.discordServerId ?? null,
      })
      .where(
        and(
          eq(courses.id, courseId),
          eq(courses.organizationId, organizationId)
        )
      )
      .returning()
      .get()

    // Replace categories and channels coherently: delete the old set, then
    // insert the new one, rather than diffing row by row — a course's
    // categories are always saved as a whole (CFG-4's list), so there is no
    // partial-update case that needs anything finer.
    deleteCourseCategories(tx, courseId)
    const categories = insertCourseCategories(
      tx,
      organizationId,
      courseId,
      input.categories
    )

    return { ok: true, course: { ...courseRow, categories } }
  })
}

/**
 * ACT-7: the fields `courses.updateSettings` may change on an existing
 * course, without moving it to another project and without touching its
 * categories or channels — unlike `NewCourse` above, there is no `projectId`
 * or `categories` here at all, and no `instructions`/`promptId` either
 * (WEB-19/D-54, MDL-8 — the same two fields `courses.save`'s own
 * `saveInputSchema` already keeps off its schema, for the same reasons).
 * Every field is required here, not optional the way `courses.updateSettings`'s
 * own zod input is: `@bloombot/actions`' `updateSettingsCourseAction` resolves
 * its optional input against what is already stored (its own `keepOrClear`)
 * before this ever sees it, exactly the way `courses.save`'s `execute`
 * resolves `NewCourse` today — this file only ever writes fully-resolved
 * values.
 */
export interface CourseSettingsUpdate {
  title: string
  enabled: boolean
  adminsRole: string | null
  studentsRole: string | null
  model: string | null
  vectorStoreId: string | null
  maxRequestsPerDay: number | null
  conversationScope: ConversationScope
  selfEnrolFromDiscord: boolean
  answerUnenrolled: boolean
  discordServerId: string | null
}

/**
 * Update a course's settings, leaving its project, categories and channels
 * exactly as they are — `updateCourse`'s narrower sibling, for callers that
 * never touch CFG-4's category list at all (ACT-7). Runs the same PROJ-3/TEN-9
 * checks `updateCourse` runs, scoped against the course's *existing*
 * category names (`loadCourseCategories`, above) since this can never change
 * them, rather than against an `input.categories` that does not exist here.
 *
 * `undefined` when `courseId` does not exist or does not belong to
 * `organizationId` (TEN-2), matching `updateCourse`. There is no `projectId`
 * for a caller to supply (TEN-5's own foreign-`projectId` refusal does not
 * apply — this never moves a course to another project), but it still calls
 * `loadOwnedProject` with the course's own, already-stored `projectId`
 * (rework round 1, cheap-fix 4) rather than reading the `projects` row
 * directly: a project row that failed to resolve used to be silently read as
 * "not archived," skipping the PROJ-3/TEN-9 block below instead of refusing
 * the way `updateCourse` does for the equivalent case.
 */
export function updateCourseSettings(
  organizationId: string,
  courseId: string,
  input: CourseSettingsUpdate,
  db: Database
): SaveCourseResult | undefined {
  const existing = db
    .select()
    .from(courses)
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .get()
  if (!existing) return undefined

  // The project this course already belongs to — read, never written, since
  // `CourseSettingsUpdate` has no `projectId` for a caller to move it with.
  // Rework round 1, cheap-fix 4: `loadOwnedProject`, the same call
  // `updateCourse` makes (above), not a raw, unscoped select — that used to
  // read `existing.projectId` with no `organizationId` predicate at all, and
  // treated a missing row as "not archived" (`project?.archivedAt === null`
  // is `false` when `project` is `undefined`, silently *skipping* the
  // PROJ-3/TEN-9 block below rather than refusing), where `updateCourse`
  // refuses outright. Unreachable through the schema's own foreign key
  // today — `courses.project_id` cannot name a project this course's own
  // `organizationId` does not own, the same guarantee `loadOwnedProject`'s
  // own doc comment already establishes for every other caller — but this
  // makes that guarantee load-bearing here too, rather than merely
  // narrower than its sibling.
  const projectResult = loadOwnedProject(organizationId, existing.projectId, db)
  if (!projectResult.ok) return projectResult

  // This course's own categories, unaffected by this save — the candidate
  // set `findSelfConflict`/`findCourseNameConflict` check `input` against,
  // in place of the `input.categories` `updateCourse` would otherwise read.
  const existingCategoryNames = loadCourseCategories(
    organizationId,
    courseId,
    db
  ).map((category) => ({ name: category.name }))
  const nameCheckInput: NameCheckInput = {
    adminsRole: input.adminsRole,
    studentsRole: input.studentsRole,
    categories: existingCategoryNames,
  }

  // SRV-10 round 3, must-fix 1's same gate as `updateCourse`, above: only
  // check the role-aliasing half of `findSelfConflict` when this save
  // actually changes a role name.
  const rolesChanged =
    input.adminsRole !== existing.adminsRole ||
    input.studentsRole !== existing.studentsRole
  const selfConflict = findSelfConflict(nameCheckInput, {
    checkRoles: rolesChanged,
  })
  if (selfConflict) return { ok: false, conflict: selfConflict }

  return writeTransaction(db, (tx) => {
    if (input.enabled && projectResult.project.archivedAt === null) {
      const serverResolution = resolveCourseDiscordServer(
        organizationId,
        input.discordServerId ?? null,
        tx
      )
      if (!serverResolution.ok) {
        return {
          ok: false,
          conflict: serverResolutionConflict(
            serverResolution.reason,
            input.title
          ),
        }
      }
      // `couldIntroduceCrossCourseCollision` mirrors `updateCourse`'s own,
      // minus `input.projectId !== existing.projectId` — this action never
      // changes a course's project, so that half of the condition can never
      // be true here.
      const couldIntroduceCrossCourseCollision =
        rolesChanged ||
        input.enabled !== existing.enabled ||
        (input.discordServerId ?? null) !== existing.discordServerId
      const conflictFound = findCourseNameConflict(
        organizationId,
        nameCheckInput,
        serverResolution.binding?.serverId,
        tx,
        {
          excludeCourseId: courseId,
          checkRoles: couldIntroduceCrossCourseCollision,
        }
      )
      if (conflictFound) return { ok: false, conflict: conflictFound }
    }

    const courseRow = tx
      .update(courses)
      .set({
        title: input.title,
        enabled: input.enabled,
        adminsRole: input.adminsRole,
        studentsRole: input.studentsRole,
        model: input.model,
        vectorStoreId: input.vectorStoreId,
        maxRequestsPerDay: input.maxRequestsPerDay,
        conversationScope: input.conversationScope,
        selfEnrolFromDiscord: input.selfEnrolFromDiscord,
        answerUnenrolled: input.answerUnenrolled,
        discordServerId: input.discordServerId,
      })
      .where(
        and(
          eq(courses.id, courseId),
          eq(courses.organizationId, organizationId)
        )
      )
      .returning()
      .get()

    // ACT-7, the whole point of this function: `projectId`, `categories` and
    // `channels` are never written here at all — `loadCourseCategories` reads
    // them back unchanged, rather than `updateCourse`'s
    // `deleteCourseCategories`/`insertCourseCategories` replace path, which
    // would give every category and channel a new id even when their
    // contents end up identical.
    const categories = loadCourseCategories(organizationId, courseId, tx)
    return { ok: true, course: { ...courseRow, categories } }
  })
}

// SRV-12 — a course's categories and channels, edited one at a time rather
// than through `updateCourse`'s whole-list replace. Every function below
// only ever touches the one category or channel it names, leaving every
// sibling category, channel and every other course field exactly as it was.
//
// Nothing here touches Discord itself: these functions edit the declaration
// only, the same rows `updateCourse` already writes. SRV-6's scaffold
// remains the one thing that creates, renames or deletes anything in a live
// server, and SRV-8's "scaffolding never deletes" is unchanged — a channel
// removed here is simply absent the next time a scaffold reads this course's
// declaration, never removed from the server it already reached.
//
// PROJ-3 only ever constrains *category* names (and the two role names,
// untouched by anything in this section) — `findSelfConflict` and
// `findCourseNameConflict`, above, never compare a channel's own name
// against anything, and neither does any database constraint
// (`schema.ts`'s own `course_channels` table has none). So `addCourseChannel`
// and `updateCourseChannel`, below, run no conflict check at all — there is
// no invariant `courses.save` enforces over channel names for a narrower
// write to preserve. `addCourseCategory` and `renameCourseCategory` are the
// two writes here that can introduce a category-name collision, so they are
// the two that run it.

/** `getCourseCategory`'s own shape: a category, scoped to `organizationId`, alongside the course it belongs to (also scoped, TEN-2) — what every category-level policy below resolves. */
export interface ResolvedCourseCategory {
  category: CourseCategoryWithChannels
  course: Course
}

/**
 * Resolve a category by id, scoped to `organizationId` at both hops — the
 * category itself and the course it declares to belong to. A category
 * belonging to another organization, or naming a course that does not
 * (TEN-2's usual guarantee, checked explicitly rather than assumed), resolves
 * to `undefined` the same way a missing id does, so `@bloombot/actions`'
 * policies below refuse both identically (ACT-3).
 */
export function getCourseCategory(
  organizationId: string,
  categoryId: string,
  db: Executor
): ResolvedCourseCategory | undefined {
  const categoryRow = db
    .select()
    .from(courseCategories)
    .where(
      and(
        eq(courseCategories.id, categoryId),
        eq(courseCategories.organizationId, organizationId)
      )
    )
    .get()
  if (!categoryRow) return undefined

  const course = db
    .select()
    .from(courses)
    .where(
      and(
        eq(courses.id, categoryRow.courseId),
        eq(courses.organizationId, organizationId)
      )
    )
    .get()
  if (!course) return undefined

  const channels = db
    .select()
    .from(courseChannels)
    .where(
      and(
        eq(courseChannels.categoryId, categoryId),
        eq(courseChannels.organizationId, organizationId)
      )
    )
    .orderBy(courseChannels.ordering)
    .all()

  return { category: { ...categoryRow, channels }, course }
}

/** `getCourseChannel`'s own shape: a channel, scoped to `organizationId` at every hop up to the course it belongs to — what every channel-level policy below resolves. */
export interface ResolvedCourseChannel {
  channel: CourseChannel
  category: CourseCategory
  course: Course
}

/**
 * Resolve a channel by id, scoped to `organizationId` at every hop: the
 * channel itself, the category it declares to belong to, and that category's
 * own course — three lookups, each of which must resolve within this
 * organization, since a channel names only its immediate category, not the
 * course two hops up. A channel belonging to another organization, or naming
 * a category (or a course) that does not, resolves to `undefined` the same
 * "not found" way at any of the three hops, never a distinct error a caller
 * could use to tell which hop actually failed.
 */
export function getCourseChannel(
  organizationId: string,
  channelId: string,
  db: Executor
): ResolvedCourseChannel | undefined {
  const channel = db
    .select()
    .from(courseChannels)
    .where(
      and(
        eq(courseChannels.id, channelId),
        eq(courseChannels.organizationId, organizationId)
      )
    )
    .get()
  if (!channel) return undefined

  const category = db
    .select()
    .from(courseCategories)
    .where(
      and(
        eq(courseCategories.id, channel.categoryId),
        eq(courseCategories.organizationId, organizationId)
      )
    )
    .get()
  if (!category) return undefined

  const course = db
    .select()
    .from(courses)
    .where(
      and(
        eq(courses.id, category.courseId),
        eq(courses.organizationId, organizationId)
      )
    )
    .get()
  if (!course) return undefined

  return { channel, category, course }
}

/**
 * The PROJ-3/TEN-9 checks `updateCourse`/`updateCourseSettings` already run
 * before writing, run here against a *hypothetical* category-name list — the
 * course's own current categories with one name added or renamed — so
 * `addCourseCategory`/`renameCourseCategory` (below) refuse exactly the
 * state a `courses.save` carrying that same category list would have
 * refused, without requiring a caller to resubmit the rest of the course to
 * find out. `checkRoles` is always `false` in both checks this runs — an
 * addition or a rename never touches either role name, so there is nothing
 * for the role half of either check to have changed.
 *
 * Rework round 1, must-fix 1: the project row is read through
 * `loadOwnedProject` (below), not a raw, unscoped `select` — a raw select
 * used to read `course.projectId` with no `organizationId` predicate at
 * all, and treated a missing row as "not archived" (a falsy `project`
 * makes `project?.archivedAt === null` false, silently *skipping* the
 * PROJ-3/TEN-9 block below rather than refusing), exactly the cheap-fix 4
 * defect `updateCourseSettings`'s own doc comment already records fixing
 * last slice — reintroduced here as new code until this rework caught it
 * again.
 */
function checkCategoryNameAgainstCourse(
  organizationId: string,
  course: Course,
  candidateCategoryNames: { name: string }[],
  db: Executor
): CourseNameConflict | undefined {
  const nameCheckInput: NameCheckInput = {
    adminsRole: course.adminsRole,
    studentsRole: course.studentsRole,
    categories: candidateCategoryNames,
  }

  const selfConflict = findSelfConflict(nameCheckInput, { checkRoles: false })
  if (selfConflict) return selfConflict

  // The cross-course half only ever applies to a course that actually
  // routes — an enabled course in a non-archived project — the same gate
  // `createCourse`/`updateCourse` apply (`courses.enabled`'s own comment,
  // `schema.ts`). `loadOwnedProject` refuses outright (rather than silently
  // skipping this block) when the project row cannot be read at all — this
  // function's own doc comment above, on why a raw select is wrong here.
  const projectResult = loadOwnedProject(organizationId, course.projectId, db)
  if (!projectResult.ok) return projectResult.conflict
  if (!course.enabled || projectResult.project.archivedAt !== null) {
    return undefined
  }

  const serverResolution = resolveCourseDiscordServer(
    organizationId,
    course.discordServerId,
    db
  )
  if (!serverResolution.ok) {
    return serverResolutionConflict(serverResolution.reason, course.title)
  }

  return findCourseNameConflict(
    organizationId,
    nameCheckInput,
    serverResolution.binding?.serverId,
    db,
    { excludeCourseId: course.id, checkRoles: false }
  )
}

/** What `addCourseCategory` and `renameCourseCategory` report — the same `{ ok: false, conflict }` channel every other PROJ-3 check in this file uses. */
export type CourseCategoryResult =
  | { ok: true; category: CourseCategoryWithChannels }
  | { ok: false; conflict: CourseNameConflict }

/**
 * SRV-12: append a new category to `courseId`, after its existing
 * categories (`ordering` = current max + 1, or `0` for the first). Refused
 * (PROJ-3) exactly the way `updateCourse` refuses a category name that
 * collides with another one already declared inside this course, or with
 * another enabled course routing in the same Discord server
 * (`checkCategoryNameAgainstCourse`, above).
 *
 * `undefined` when `courseId` does not exist or does not belong to
 * `organizationId` (TEN-2), matching every other course lookup in this file.
 */
export function addCourseCategory(
  organizationId: string,
  courseId: string,
  name: string,
  db: Database
): CourseCategoryResult | undefined {
  const course = db
    .select()
    .from(courses)
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .get()
  if (!course) return undefined

  return writeTransaction(db, (tx) => {
    const existingCategories = loadCourseCategories(
      organizationId,
      courseId,
      tx
    )
    const conflict = checkCategoryNameAgainstCourse(
      organizationId,
      course,
      [
        ...existingCategories.map((category) => ({ name: category.name })),
        { name },
      ],
      tx
    )
    if (conflict) return { ok: false, conflict }

    const ordering =
      existingCategories.length === 0
        ? 0
        : Math.max(...existingCategories.map((category) => category.ordering)) +
          1
    const categoryRow: CourseCategory = {
      id: crypto.randomUUID(),
      organizationId,
      courseId,
      name,
      ordering,
      createdAt: Date.now(),
    }
    tx.insert(courseCategories).values(categoryRow).run()

    return { ok: true, category: { ...categoryRow, channels: [] } }
  })
}

/**
 * SRV-12: rename an existing category, leaving its channels and every
 * sibling category untouched. Refused (PROJ-3) the same way
 * `addCourseCategory` is — `name` is checked against every *other* category
 * this course already declares (this category's own current name is
 * excluded from the candidate list, the same `excludeCourseId` reasoning
 * `updateCourse` applies to itself, one level down).
 *
 * `undefined` when `categoryId` does not exist or does not belong to
 * `organizationId` (TEN-2) — `getCourseCategory`'s own guarantee.
 *
 * Rework round 1, must-fix 4: the initial resolve (category, course and its
 * current channels) now happens *inside* `writeTransaction`, against `tx`,
 * not before it against `db` — `writeTransaction` opens with `BEGIN
 * IMMEDIATE` (`client.ts`'s own doc comment), which takes the write lock at
 * the very first statement, so a resolve run against `tx` cannot be
 * invalidated by a concurrent write between it and this function's own
 * write, the way a resolve against `db` (before the transaction even opened)
 * could. The returned `channels` is exactly what this same resolve read,
 * moments earlier, inside the same lock — never a snapshot taken before the
 * lock was acquired.
 */
export function renameCourseCategory(
  organizationId: string,
  categoryId: string,
  name: string,
  db: Database
): CourseCategoryResult | undefined {
  return writeTransaction(db, (tx) => {
    const resolved = getCourseCategory(organizationId, categoryId, tx)
    if (!resolved) return undefined
    const { course } = resolved

    const existingCategories = loadCourseCategories(
      organizationId,
      course.id,
      tx
    )
    const candidateNames = existingCategories
      .filter((category) => category.id !== categoryId)
      .map((category) => ({ name: category.name }))
    candidateNames.push({ name })

    const conflict = checkCategoryNameAgainstCourse(
      organizationId,
      course,
      candidateNames,
      tx
    )
    if (conflict) return { ok: false, conflict }

    const updated = tx
      .update(courseCategories)
      .set({ name })
      .where(
        and(
          eq(courseCategories.id, categoryId),
          eq(courseCategories.organizationId, organizationId)
        )
      )
      .returning()
      .get()
    if (!updated) {
      // Same TEN-2 race `updateCourse`'s own `execute` guards against —
      // `getCourseCategory` already proved this row existed, moments
      // earlier, in this same organization, inside this same transaction.
      throw new Error(
        'renameCourseCategory: category vanished mid-transaction — should be unreachable'
      )
    }

    return {
      ok: true,
      category: { ...updated, channels: resolved.category.channels },
    }
  })
}

/** What `removeCourseCategory` reports: how many channels were removed alongside the category — SPEC-required (SRV-12), so a caller that meant to remove one channel is told when it removed six instead. */
export interface RemoveCourseCategoryResult {
  removedChannelCount: number
}

/**
 * SRV-12: remove a category and every channel declared inside it. Nothing
 * here reaches Discord — SRV-8's "scaffolding never deletes" means the
 * channels this category named stay in the live server until an
 * administrator removes them there directly; the next scaffold simply stops
 * reporting them as declared.
 *
 * `undefined` when `categoryId` does not exist or does not belong to
 * `organizationId` (TEN-2) — `getCourseCategory`'s own guarantee.
 *
 * Rework round 1, must-fix 4: `removedChannelCount` is the deleting
 * statement's own `.run().changes`, read *inside* the transaction that
 * performs the delete, not a channel count resolved before
 * `writeTransaction` even opened (`BEGIN IMMEDIATE` takes the write lock at
 * the first statement — a count taken earlier could under-report if a
 * channel were added in the window between that read and the lock). A
 * category with no channels reports `0`, not `1` — the delete's own
 * `changes` is exact either way, never a placeholder that treats "no
 * channels" as if it were "one channel."
 */
export function removeCourseCategory(
  organizationId: string,
  categoryId: string,
  db: Database
): RemoveCourseCategoryResult | undefined {
  return writeTransaction(db, (tx) => {
    const resolved = getCourseCategory(organizationId, categoryId, tx)
    if (!resolved) return undefined

    // Channels first, same as `deleteCourseCategories` above: nothing here
    // relies on `ON DELETE CASCADE`, so the child rows have to go before
    // their parent explicitly.
    const deletedChannels = tx
      .delete(courseChannels)
      .where(eq(courseChannels.categoryId, categoryId))
      .run()
    tx.delete(courseCategories)
      .where(
        and(
          eq(courseCategories.id, categoryId),
          eq(courseCategories.organizationId, organizationId)
        )
      )
      .run()
    return { removedChannelCount: deletedChannels.changes }
  })
}

/**
 * SRV-12: append a new channel to `categoryId`, after its existing channels
 * (`ordering` = current max + 1, or `0` for the first). No PROJ-3 check —
 * this file's own module comment above on why channel names carry no
 * uniqueness invariant to preserve.
 *
 * `undefined` when `categoryId` does not exist or does not belong to
 * `organizationId` (TEN-2) — `getCourseCategory`'s own guarantee.
 *
 * Rework round 1, must-fix 2: wrapped in `writeTransaction`, unlike the
 * first version of this function, which read `getCourseCategory` and then
 * inserted with no transaction around either — `apps/api` and `apps/mcp`
 * are separate processes sharing one SQLite file, so two concurrent calls
 * against the same category could read the same "existing channels" list
 * and insert two channels with identical `ordering`, and the same window
 * let an insert here race `removeCourseCategory`'s own delete into a raw
 * foreign-key error (a 500) instead of a clean refusal. `BEGIN IMMEDIATE`
 * (`writeTransaction`, `client.ts`) serializes the two against each other
 * the same way it already serializes every other write in this file.
 */
export function addCourseChannel(
  organizationId: string,
  categoryId: string,
  channel: NewCourseChannel,
  db: Database
): CourseChannel | undefined {
  return writeTransaction(db, (tx) => {
    const resolved = getCourseCategory(organizationId, categoryId, tx)
    if (!resolved) return undefined

    const ordering =
      resolved.category.channels.length === 0
        ? 0
        : Math.max(
            ...resolved.category.channels.map((existing) => existing.ordering)
          ) + 1
    const channelRow: CourseChannel = {
      id: crypto.randomUUID(),
      organizationId,
      categoryId,
      name: channel.name,
      adminsOnly: channel.adminsOnly,
      ordering,
      createdAt: Date.now(),
    }
    tx.insert(courseChannels).values(channelRow).run()
    return channelRow
  })
}

/** What `updateCourseChannel` may change — an omitted key keeps whatever is already stored, the same `courses.updateSettings` rule (ACT-7); neither field is nullable, so there is no "clear" state for either to carry. */
export interface CourseChannelUpdate {
  name?: string
  adminsOnly?: boolean
}

/**
 * SRV-12: change a channel's name and/or its admins-only flag, leaving
 * everything else about it (and every other category or channel in the
 * course) untouched. No PROJ-3 check — this file's own module comment above.
 *
 * `undefined` when `channelId` does not exist or does not belong to
 * `organizationId` (TEN-2) — the `.where` below already scopes both, so a
 * foreign or missing `channelId` updates (or reads) nothing and this
 * returns `undefined` the same way `.get()` does for any other miss.
 *
 * Rework round 1, must-fix 3: `.set(...)` is built from only the keys
 * `update` actually carries, and the write goes straight through with no
 * prior read of the stored row — the first version of this function read
 * the current row, then wrote *both* columns back (the omitted one from
 * that read), which is exactly the race "an omitted key keeps whatever is
 * already stored" promises not to have: a concurrent name-only update and
 * adminsOnly-only update, interleaved, could each overwrite the other's
 * change with its own stale read of the field it never touched. A caller
 * that omits both keys — nothing to change — reads the row back instead of
 * issuing an empty `UPDATE ... SET`, which is invalid SQL.
 */
export function updateCourseChannel(
  organizationId: string,
  channelId: string,
  update: CourseChannelUpdate,
  db: Database
): CourseChannel | undefined {
  const patch: Partial<Pick<CourseChannel, 'name' | 'adminsOnly'>> = {
    ...(update.name !== undefined ? { name: update.name } : {}),
    ...(update.adminsOnly !== undefined
      ? { adminsOnly: update.adminsOnly }
      : {}),
  }

  if (Object.keys(patch).length === 0) {
    return db
      .select()
      .from(courseChannels)
      .where(
        and(
          eq(courseChannels.id, channelId),
          eq(courseChannels.organizationId, organizationId)
        )
      )
      .get()
  }

  return db
    .update(courseChannels)
    .set(patch)
    .where(
      and(
        eq(courseChannels.id, channelId),
        eq(courseChannels.organizationId, organizationId)
      )
    )
    .returning()
    .get()
}

/**
 * SRV-12: remove a single channel, leaving its category and every sibling
 * channel untouched. Nothing here reaches Discord — this file's own module
 * comment above.
 *
 * `false` when `channelId` does not exist or does not belong to
 * `organizationId` (TEN-2), the same "rows changed, not a distinct not-found
 * error" shape `disableCourse` (below) already uses.
 */
export function removeCourseChannel(
  organizationId: string,
  channelId: string,
  db: Database
): boolean {
  const result = db
    .delete(courseChannels)
    .where(
      and(
        eq(courseChannels.id, channelId),
        eq(courseChannels.organizationId, organizationId)
      )
    )
    .run()
  return result.changes > 0
}

/** What `enableCourse` reports: `undefined` for TEN-2/TEN-5, matching `updateCourse`. */
export type EnableCourseResult =
  { ok: true; changed: boolean } | { ok: false; conflict: CourseNameConflict }

/**
 * Enable a disabled course.
 *
 * Re-runs the PROJ-3 check (`createCourse` and `updateCourse` are not the
 * only places a collision can appear: a course disabled while another course
 * took its names, then re-enabled, produces exactly the state PROJ-3
 * forbids — two enabled courses sharing a category or role name — unless
 * enabling is checked too). Refused the same way a save is, through
 * `{ ok: false, conflict }`.
 *
 * `undefined` when `courseId` does not exist or does not belong to
 * `organizationId` (TEN-2), matching `updateCourse`. Enabling an
 * already-enabled course is a no-op: `{ ok: true, changed: false }`, so a
 * caller that treats `changed` as "this actually happened" — to emit an
 * audit event, say — is not told something happened when nothing did.
 */
export function enableCourse(
  organizationId: string,
  courseId: string,
  db: Database
): EnableCourseResult | undefined {
  const existing = db
    .select()
    .from(courses)
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .get()
  if (!existing) return undefined
  if (existing.enabled) return { ok: true, changed: false }

  return writeTransaction(db, (tx) => {
    // `existing.projectId` was validated against `organizationId` when it
    // was last saved (`loadOwnedProject`, above) — projects are never
    // reassigned outside a save, so it does not need re-checking here.
    const project = tx
      .select({ archivedAt: projects.archivedAt })
      .from(projects)
      .where(eq(projects.id, existing.projectId))
      .get()

    if (project && project.archivedAt === null) {
      // TEN-9 — the same "may not enable while undecidable" guard
      // `createCourse`/`updateCourse` apply at save time, re-run here for
      // the same reason the PROJ-3 check just below is re-run: a course
      // disabled while its binding was still resolvable, then re-enabled
      // after the organization gained (or lost) bindings, must not slip
      // through with a server nothing can resolve.
      const serverResolution = resolveCourseDiscordServer(
        organizationId,
        existing.discordServerId,
        tx
      )
      if (!serverResolution.ok) {
        return {
          ok: false,
          conflict: serverResolutionConflict(
            serverResolution.reason,
            existing.title
          ),
        }
      }

      const categories = tx
        .select({ name: courseCategories.name })
        .from(courseCategories)
        .where(eq(courseCategories.courseId, courseId))
        .all()
      const conflictFound = findCourseNameConflict(
        organizationId,
        {
          adminsRole: existing.adminsRole,
          studentsRole: existing.studentsRole,
          categories,
        },
        serverResolution.binding?.serverId,
        tx,
        { excludeCourseId: courseId }
      )
      if (conflictFound) return { ok: false, conflict: conflictFound }
    }

    tx.update(courses)
      .set({ enabled: true })
      .where(
        and(
          eq(courses.id, courseId),
          eq(courses.organizationId, organizationId)
        )
      )
      .run()
    return { ok: true, changed: true }
  })
}

/**
 * Disable a course (PROJ-3's other escape hatch alongside archiving its
 * project): a disabled course stops routing and is excluded from the
 * name-collision check, freeing its names for another course to use.
 *
 * Returns the number of rows changed — `0` rather than a different
 * organization's course when `organizationId` does not match, and `0` for a
 * course that is already disabled (the `enabled` predicate below, the same
 * shape `archiveProject`'s `isNull(archivedAt)` uses), so a caller cannot
 * mistake "already disabled" for "just disabled".
 */
export function disableCourse(
  organizationId: string,
  courseId: string,
  db: Database
): number {
  const result = db
    .update(courses)
    .set({ enabled: false })
    .where(
      and(
        eq(courses.id, courseId),
        eq(courses.organizationId, organizationId),
        eq(courses.enabled, true)
      )
    )
    .run()
  return result.changes
}

/**
 * FILE-4 — write a course's *current* instructions, and only that column:
 * unlike `updateCourse`, this never touches categories, channels or any
 * other field, so `@bloombot/actions`' `courseInstructions.save` action can
 * call it without first reading (and re-supplying) the rest of the course.
 * `course_instruction_revisions` is the caller's own concern
 * (`repos/course-instruction-revisions.ts`) — this file only ever knows
 * about `courses.instructions` itself, the same division
 * `course-attachments.ts`'s own module comment draws between a row's
 * lifecycle and the bytes or provider state a different file owns.
 *
 * `db` accepts `Executor`, not just `Database`: `courseInstructions.save`/
 * `.restore` (`@bloombot/actions`) call this from inside their own
 * `db.transaction(...)`, alongside `course-instruction-revisions.ts#createRevision`
 * — the same "one transaction, or the comment claiming atomicity is a lie"
 * fix that entry's own module comment now spells out.
 *
 * Returns the updated course, or `undefined` when `courseId` does not exist
 * or does not belong to `organizationId` (TEN-2/TEN-5).
 */
export function setCourseInstructions(
  organizationId: string,
  courseId: string,
  instructions: string,
  db: Executor
): Course | undefined {
  return db
    .update(courses)
    .set({ instructions })
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .returning()
    .get()
}

/**
 * FILE-1 — the course a `courseAttachments.attach`/`.detach` job's own
 * `vectorStoreId` writes into. Set once, the first time a course's files are
 * attached this way (`apps/worker`'s own handler) — an instructor's
 * hand-typed `vectorStoreId` (D-3's escape hatch, still settable through
 * `courses.save`) is left untouched if the course already has one: this
 * never overwrites a value already there, only fills a `null`. Returns the
 * updated course, or `undefined` for the usual TEN-2/TEN-5 reasons.
 */
export function setCourseVectorStoreIdIfUnset(
  organizationId: string,
  courseId: string,
  vectorStoreId: string,
  db: Database
): Course | undefined {
  db.update(courses)
    .set({ vectorStoreId })
    .where(
      and(
        eq(courses.id, courseId),
        eq(courses.organizationId, organizationId),
        isNull(courses.vectorStoreId)
      )
    )
    .run()
  // Read back regardless of whether the `UPDATE` above actually matched a
  // row (TEN-2's usual "the caller already knows why" contract) — a course
  // that already had a `vectorStoreId` (hand-typed or set by an earlier
  // attachment) is returned unchanged, not as `undefined`, since the id this
  // caller wanted is already the one in place.
  return db
    .select()
    .from(courses)
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .get()
}

/**
 * The conflict unarchiving `projectId` would produce, if any: a course in an
 * archived project is excluded from the PROJ-3 candidate set
 * (`findCourseNameConflict`), so a name freed by archiving and reused by
 * another enabled course would silently collide once this project's courses
 * route again — the same hole `enableCourse` closes for a single course, one
 * level up, for every enabled course a project brings back at once.
 *
 * Checks each of `projectId`'s own enabled courses against every other
 * enabled course in a non-archived project *and* against each other
 * (`includeProjectId`) — two of this project's own courses could have taken
 * the same name while both were archived, since neither was a PROJ-3
 * candidate at the time. Called by `unarchiveProject` (`repos/projects.ts`)
 * before the project's `archived_at` is cleared.
 */
export function findProjectUnarchiveConflict(
  organizationId: string,
  projectId: string,
  db: Database
): CourseNameConflict | undefined {
  const projectCourses = db
    .select({
      id: courses.id,
      title: courses.title,
      adminsRole: courses.adminsRole,
      studentsRole: courses.studentsRole,
      discordServerId: courses.discordServerId,
    })
    .from(courses)
    .where(
      and(
        eq(courses.organizationId, organizationId),
        eq(courses.projectId, projectId),
        eq(courses.enabled, true)
      )
    )
    .all()

  for (const course of projectCourses) {
    // TEN-9 — unarchiving brings this course back into the PROJ-3 candidate
    // set (it is about to route again), so the same "may not route while
    // undecidable" guard `enableCourse` applies at re-enable time applies
    // here too.
    const serverResolution = resolveCourseDiscordServer(
      organizationId,
      course.discordServerId,
      db
    )
    if (!serverResolution.ok) {
      return serverResolutionConflict(serverResolution.reason, course.title)
    }

    const categories = db
      .select({ name: courseCategories.name })
      .from(courseCategories)
      .where(eq(courseCategories.courseId, course.id))
      .all()
    const conflictFound = findCourseNameConflict(
      organizationId,
      {
        adminsRole: course.adminsRole,
        studentsRole: course.studentsRole,
        categories,
      },
      serverResolution.binding?.serverId,
      db,
      { excludeCourseId: course.id, includeProjectId: projectId }
    )
    if (conflictFound) return conflictFound
  }

  return undefined
}
