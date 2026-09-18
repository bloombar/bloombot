/**
 * Repository for `cost_ledger_entries` and `organizations.spending_cap_micros`
 * (COST-1..6).
 *
 * Every function that reaches into one organization's own ledger is scoped
 * by `organizationId`, its first parameter — the same TEN-2 discipline every
 * other file in this directory holds itself to. `listOrganizationTotals` is
 * this file's first documented exception: it is the platform administrator's
 * own read (COST-4's "a platform administrator sees usage per organization"),
 * which by definition spans every organization rather than one — the same
 * class of exception `repos/jobs.ts#countQueuedJobs` already is for JOB-5's
 * own "how deep is the queue, platform-wide" operational read.
 * `listAccountTotals` and `getAccountUsageSummary` (ADMIN-10/ADMIN-11) are
 * the same class one level up again: a platform administrator's own read of
 * one *account's* usage, resolved through `person_identities` rather than
 * `organizationId`, since an account is not itself scoped to one
 * organization (`people.ts`'s own module comment on that mapping).
 */

import { and, eq, inArray, isNull, sql, sum } from 'drizzle-orm'

import type { Database } from '../client.js'
import {
  COST_LEDGER_SURFACES,
  costLedgerEntries,
  courses,
  organizations,
  people,
  personIdentities,
  type CostLedgerSurface,
  type CostMeasurement,
  type Surface,
} from '../schema.js'

export type CostLedgerEntry = typeof costLedgerEntries.$inferSelect

/**
 * What a caller supplies to record one model call's cost. `inputTokens`/
 * `outputTokens` stay typed `number | null` for a caller with truly nothing
 * to report — `undefined` would be indistinguishable from "forgot to pass
 * it" once this crosses a JSON boundary, the same reasoning
 * `actions/jobs.ts#JobStatus.result`'s own comment already gives for the
 * same choice — but `@bloombot/core`'s own `computeCost` (COST-6, finding 2
 * of the COST-1 rework) no longer passes `null` when the provider reported
 * no usage: the request and answer text are still in hand even then, so it
 * estimates token counts from their own length rather than leaving the
 * count blank while `costMicros` is priced from it anyway. `measurement`
 * (below) is what tells a reader whether a call's `inputTokens`/
 * `outputTokens` came from the provider or from that estimate — not
 * whether the column itself is `null`.
 */
export interface NewCostLedgerEntry {
  courseId: string
  personId: string
  model: string
  inputTokens: number | null
  outputTokens: number | null
  costMicros: number
  measurement: CostMeasurement
  // COST-7 — typed `Surface` (the three-value type every real caller has in
  // scope), deliberately narrower than the column's own `CostLedgerSurface`.
  // That mismatch is the point: `'unknown'` is not a value any caller of
  // this function can assert, so "nothing writes `'unknown'` after this
  // migration" (`COST_LEDGER_SURFACES`'s own comment, `schema.ts`) is a
  // compile-time fact about this interface, not a convention a future caller
  // could quietly break.
  surface: Surface
}

/**
 * Record one model call's cost (COST-1), attributed to the organization,
 * course and person it was made for (COST-2).
 *
 * `undefined` when `courseId` or `personId` does not exist, or does not
 * belong to `organizationId` — the same TEN-2/TEN-5 refusal
 * `usage.ts#reserveUsageSlot` already gives for a foreign id, checked before
 * the insert runs so a foreign id is refused rather than written through.
 * Combined with `cost_ledger_entries`'s own `NOT NULL` foreign keys
 * (`schema.ts`), this is what makes COST-2's "a call that cannot be
 * attributed is a defect, not a row with a null" true structurally, not by
 * convention: there is no argument shape that reaches this function without
 * all three ids, and no id this function accepts that is not first proven
 * to belong to `organizationId`.
 */
export function recordCostLedgerEntry(
  organizationId: string,
  entry: NewCostLedgerEntry,
  db: Database
): CostLedgerEntry | undefined {
  // DATA-9 — a soft-deleted course or person cannot be billed against
  // either, the same "cannot be attributed" refusal a foreign id already
  // gets.
  const course = db
    .select({ id: courses.id })
    .from(courses)
    .where(
      and(
        eq(courses.id, entry.courseId),
        eq(courses.organizationId, organizationId),
        isNull(courses.deletedAt)
      )
    )
    .get()
  if (!course) return undefined

  const person = db
    .select({ id: people.id })
    .from(people)
    .where(
      and(
        eq(people.id, entry.personId),
        eq(people.organizationId, organizationId),
        isNull(people.deletedAt)
      )
    )
    .get()
  if (!person) return undefined

  return db
    .insert(costLedgerEntries)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      courseId: entry.courseId,
      personId: entry.personId,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costMicros: entry.costMicros,
      measurement: entry.measurement,
      surface: entry.surface,
      createdAt: Date.now(),
    })
    .returning()
    .get()
}

/**
 * The organization's total spend to date, in integer micros — every ledger
 * row ever recorded for it, summed. COST-3's cap is cumulative, not a daily
 * allowance the way `usage_counters` is (`repos/usage.ts`'s own module
 * comment): there is no reset here, on purpose — see `docs/DECISIONS.md`.
 * `0` when the organization has recorded nothing yet, the same "no rows
 * summed" reading `sum()` already gives back as `null` from SQL, coerced
 * here to a plain number a caller can compare without a null check of its
 * own.
 */
export function getOrganizationSpentMicros(
  organizationId: string,
  db: Database
): number {
  const row = db
    .select({ total: sum(costLedgerEntries.costMicros) })
    .from(costLedgerEntries)
    .where(eq(costLedgerEntries.organizationId, organizationId))
    .get()
  return Number(row?.total ?? 0)
}

/**
 * Has this organization reached (or passed) its own spending cap (COST-3)?
 * Tri-state, the same shape `usage.ts#hasExhaustedDailyLimit` already uses
 * for the daily allowance, and for the same reason:
 *
 * - `undefined` when `organizationId` does not exist — "I cannot tell you"
 *   is not the same answer as "no", the same TEN-2 reasoning
 *   `hasExhaustedDailyLimit`'s own comment gives.
 * - `false` when the organization has not set a cap at all
 *   (`spendingCapMicros` is `null`) — this package does not invent a
 *   platform-wide default here, the same "no default value is invented"
 *   discipline `hasExhaustedDailyLimit` already holds `maxRequestsPerDay`
 *   to.
 * - `true`/`false` otherwise, comparing the organization's own cumulative
 *   spend (`getOrganizationSpentMicros`) against its configured cap.
 */
export function hasReachedSpendingCap(
  organizationId: string,
  db: Database
): boolean | undefined {
  // DATA-9 — a soft-deleted organization "cannot tell you" the same as one
  // that does not exist.
  const organization = db
    .select({ spendingCapMicros: organizations.spendingCapMicros })
    .from(organizations)
    .where(
      and(eq(organizations.id, organizationId), isNull(organizations.deletedAt))
    )
    .get()
  if (!organization) return undefined
  if (organization.spendingCapMicros === null) return false

  const spent = getOrganizationSpentMicros(organizationId, db)
  return spent >= organization.spendingCapMicros
}

/**
 * One surface's own slice of a `CourseUsageSummary`/`OrganizationUsageSummary`/
 * `OrganizationTotal`'s totals (COST-7). Reuses the same three fields those
 * summaries already report — `costMicros`, `estimatedCostMicros`,
 * `callCount` — rather than a second vocabulary a reader would have to learn
 * just for the per-surface view. A summary carries an entry here only for a
 * surface it actually has rows for: a course never asked through MCP does
 * not carry a zero `mcp` entry, the same way a course with genuinely no
 * ledger rows at all still appears in its parent summary at zero
 * (`getOrganizationUsageSummary`'s own comment) — that is a statement about
 * the course, not about every surface it has never been asked through.
 */
export interface CostBySurface {
  surface: CostLedgerSurface
  costMicros: number
  estimatedCostMicros: number
  callCount: number
}

/**
 * COST-7 rework — a fixed, deterministic order for a `bySurface` array:
 * `COST_LEDGER_SURFACES`'s own declaration order (`SURFACES` first, then
 * `'unknown'` last). Both grouped queries below build these arrays from a
 * SQL `GROUP BY`, whose own row order SQLite makes no guarantee about — two
 * reads of the same, unchanged data could otherwise render the "By
 * surface: ..." line in a different order each time. `'unknown'` last
 * reads better than a plain alphabetical sort (which would put it between
 * `mcp` and `web`) — it is the historical bucket, and a reader expects the
 * real surfaces grouped together ahead of it.
 */
function sortBySurface(entries: CostBySurface[]): CostBySurface[] {
  return [...entries].sort(
    (a, b) =>
      COST_LEDGER_SURFACES.indexOf(a.surface) -
      COST_LEDGER_SURFACES.indexOf(b.surface)
  )
}

/**
 * One course's usage, as `getOrganizationUsageSummary` reports it.
 *
 * `estimatedCostMicros` — the portion of `costMicros` that came from a row
 * flagged `measurement: 'estimated'` rather than `'measured'` (finding 2 of
 * the COST-1 rework) — is what keeps this read honest to COST-6's own
 * "never presented as a measurement": without it, a course whose total is
 * entirely a guess (a run of provider outages, say, or a model this
 * platform has no rate for) looks identical to one whose total was priced
 * against real token counts. `estimatedCostMicros === costMicros` is "take
 * this number with a grain of salt"; `0` is "every micro of this was
 * priced against a real measurement."
 *
 * `bySurface` (COST-7) breaks that same total down by which surface the
 * call was asked through, without changing or removing `costMicros`/
 * `estimatedCostMicros`/`callCount` above — those stay the course's whole
 * total, `bySurface`'s own entries reconcile to them rather than replacing
 * them.
 */
export interface CourseUsageSummary {
  courseId: string
  courseTitle: string
  costMicros: number
  estimatedCostMicros: number
  callCount: number
  bySurface: CostBySurface[]
}

/** COST-4's instructor read: usage across every course in the caller's own organization, plus what its cap looks like. */
export interface OrganizationUsageSummary {
  organizationId: string
  spendingCapMicros: number | null
  totalCostMicros: number
  /** The sum of every course's own `estimatedCostMicros` — see `CourseUsageSummary`'s own comment for why this exists at all. */
  totalEstimatedCostMicros: number
  courses: CourseUsageSummary[]
  /** COST-7 — the organization's own totals above, broken down by surface across every course rather than per course. */
  bySurface: CostBySurface[]
}

/**
 * COST-4 — "an instructor sees their courses' usage": every course in
 * `organizationId`, its own cost total and call count, alongside the
 * organization's cap (if any) and its running total. A course with no
 * ledger rows yet still appears, at zero — an instructor should see every
 * course they have, not only the ones that have already cost something.
 */
export function getOrganizationUsageSummary(
  organizationId: string,
  db: Database
): OrganizationUsageSummary {
  // DATA-9 — a soft-deleted organization or course does not appear in its
  // own usage summary.
  const organization = db
    .select({ spendingCapMicros: organizations.spendingCapMicros })
    .from(organizations)
    .where(
      and(eq(organizations.id, organizationId), isNull(organizations.deletedAt))
    )
    .get()

  const courseRows = db
    .select({ id: courses.id, title: courses.title })
    .from(courses)
    .where(
      and(eq(courses.organizationId, organizationId), isNull(courses.deletedAt))
    )
    .all()

  // COST-7 — grouped by course *and* surface in the one query, the same
  // "a CASE inside the aggregate, not a second SELECT" style the existing
  // `estimatedCostMicros` column already uses (finding 2 of the COST-1
  // rework): one row per (course, surface) that actually has ledger rows,
  // rather than a second pass over `cost_ledger_entries` to get the
  // per-surface breakdown this row set already carries.
  const totals = db
    .select({
      courseId: costLedgerEntries.courseId,
      surface: costLedgerEntries.surface,
      costMicros: sum(costLedgerEntries.costMicros),
      estimatedCostMicros: sql<number>`sum(case when ${costLedgerEntries.measurement} = 'estimated' then ${costLedgerEntries.costMicros} else 0 end)`,
      callCount: sql<number>`count(*)`,
    })
    .from(costLedgerEntries)
    .where(eq(costLedgerEntries.organizationId, organizationId))
    .groupBy(costLedgerEntries.courseId, costLedgerEntries.surface)
    .all()

  // One entry per course (summed across its own surfaces) plus that
  // course's own `bySurface` breakdown, and — separately — the
  // organization's `bySurface` breakdown across every course. All three
  // come from the single `totals` row set above; none of this re-reads
  // `cost_ledger_entries`.
  // PROJ-8 — `costLedgerEntries.courseId` is nullable now: a course's own
  // deletion nulls it rather than deleting the row it charged (`schema.ts`'s
  // own comment on why). `totalsByCourseId`'s key type widens to admit that;
  // `coursesSummary` below only ever looks this map up by a *real*
  // `courseRows` id, so a `null`-keyed entry simply never joins a course
  // again — exactly PROJ-8's own "survives the course it was charged to".
  // `totalCostMicros`/`totalEstimatedCostMicros` are accumulated in this same
  // loop instead of by summing `coursesSummary` afterward, precisely so a
  // deleted course's own spend is not silently dropped from the
  // organization's own total the way it is from its per-course breakdown —
  // this is COST-4's own read, but it must stay consistent with COST-3's cap
  // (`getOrganizationSpentMicros`, unaffected by this column since it sums
  // by `organizationId` alone), which the "spend-cap sums must be unchanged
  // after a delete" requirement (PROJ-8) means for this summary too.
  const totalsByCourseId = new Map<
    string | null,
    {
      costMicros: number
      estimatedCostMicros: number
      callCount: number
      bySurface: CostBySurface[]
    }
  >()
  const organizationBySurface = new Map<CostLedgerSurface, CostBySurface>()
  let totalCostMicros = 0
  let totalEstimatedCostMicros = 0
  for (const row of totals) {
    const costMicros = Number(row.costMicros ?? 0)
    const estimatedCostMicros = Number(row.estimatedCostMicros ?? 0)
    const callCount = Number(row.callCount)
    totalCostMicros += costMicros
    totalEstimatedCostMicros += estimatedCostMicros

    const courseTotals = totalsByCourseId.get(row.courseId) ?? {
      costMicros: 0,
      estimatedCostMicros: 0,
      callCount: 0,
      bySurface: [],
    }
    courseTotals.costMicros += costMicros
    courseTotals.estimatedCostMicros += estimatedCostMicros
    courseTotals.callCount += callCount
    courseTotals.bySurface.push({
      surface: row.surface,
      costMicros,
      estimatedCostMicros,
      callCount,
    })
    totalsByCourseId.set(row.courseId, courseTotals)

    const surfaceTotals = organizationBySurface.get(row.surface) ?? {
      surface: row.surface,
      costMicros: 0,
      estimatedCostMicros: 0,
      callCount: 0,
    }
    surfaceTotals.costMicros += costMicros
    surfaceTotals.estimatedCostMicros += estimatedCostMicros
    surfaceTotals.callCount += callCount
    organizationBySurface.set(row.surface, surfaceTotals)
  }

  const coursesSummary: CourseUsageSummary[] = courseRows.map((row) => {
    const totalsForCourse = totalsByCourseId.get(row.id)
    return {
      courseId: row.id,
      courseTitle: row.title,
      costMicros: totalsForCourse?.costMicros ?? 0,
      estimatedCostMicros: totalsForCourse?.estimatedCostMicros ?? 0,
      callCount: totalsForCourse?.callCount ?? 0,
      bySurface: sortBySurface(totalsForCourse?.bySurface ?? []),
    }
  })

  return {
    organizationId,
    spendingCapMicros: organization?.spendingCapMicros ?? null,
    totalCostMicros,
    totalEstimatedCostMicros,
    courses: coursesSummary,
    bySurface: sortBySurface([...organizationBySurface.values()]),
  }
}

/**
 * COST-4 — "a platform administrator sees usage per organization": every
 * organization's own total spend, call count and how much of that spend is
 * an estimate rather than a measurement (finding 2 of the COST-1 rework,
 * `estimatedCostMicros`), and nothing else. No course, no person, no
 * message content reaches this — it reads only `cost_ledger_entries.
 * cost_micros`/`measurement`/`organization_id` and `organizations.name`, so
 * there is no column here for a conversation to leak through even by
 * accident (ADMIN-4's "sees tenants, not conversations", applied one slice
 * early).
 *
 * Deliberately not scoped by `organizationId` (this file's own module
 * comment) — a platform administrator's own read spans every tenant by
 * definition; authorizing the *caller* as a platform administrator
 * (`@bloombot/auth`'s `isPlatformAdministrator`) is the responsibility of
 * whichever surface calls this, the same way it already is for every other
 * use of that check.
 */
export interface OrganizationTotal {
  organizationId: string
  organizationName: string
  totalCostMicros: number
  /** The portion of `totalCostMicros` that came from an `estimated` row rather than a `measured` one — see `CourseUsageSummary`'s own comment (`getOrganizationUsageSummary`, above) for why this exists at all. */
  estimatedCostMicros: number
  callCount: number
  /** COST-7 — the organization's own totals above, broken down by surface. */
  bySurface: CostBySurface[]
}

export function listOrganizationTotals(db: Database): OrganizationTotal[] {
  // COST-7 — grouped by organization *and* surface in the one query, the
  // same style `getOrganizationUsageSummary` above extends.
  const totals = db
    .select({
      organizationId: costLedgerEntries.organizationId,
      surface: costLedgerEntries.surface,
      costMicros: sum(costLedgerEntries.costMicros),
      estimatedCostMicros: sql<number>`sum(case when ${costLedgerEntries.measurement} = 'estimated' then ${costLedgerEntries.costMicros} else 0 end)`,
      callCount: sql<number>`count(*)`,
    })
    .from(costLedgerEntries)
    .groupBy(costLedgerEntries.organizationId, costLedgerEntries.surface)
    .all()

  const totalsByOrganizationId = new Map<
    string,
    {
      costMicros: number
      estimatedCostMicros: number
      callCount: number
      bySurface: CostBySurface[]
    }
  >()
  for (const row of totals) {
    const costMicros = Number(row.costMicros ?? 0)
    const estimatedCostMicros = Number(row.estimatedCostMicros ?? 0)
    const callCount = Number(row.callCount)

    const organizationTotals = totalsByOrganizationId.get(
      row.organizationId
    ) ?? { costMicros: 0, estimatedCostMicros: 0, callCount: 0, bySurface: [] }
    organizationTotals.costMicros += costMicros
    organizationTotals.estimatedCostMicros += estimatedCostMicros
    organizationTotals.callCount += callCount
    organizationTotals.bySurface.push({
      surface: row.surface,
      costMicros,
      estimatedCostMicros,
      callCount,
    })
    totalsByOrganizationId.set(row.organizationId, organizationTotals)
  }

  // DATA-9 — a soft-deleted organization does not appear in the
  // platform-wide totals either.
  const organizationRows = db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(isNull(organizations.deletedAt))
    .all()

  return organizationRows.map((row) => {
    const totalsForOrganization = totalsByOrganizationId.get(row.id)
    return {
      organizationId: row.id,
      organizationName: row.name,
      totalCostMicros: totalsForOrganization?.costMicros ?? 0,
      estimatedCostMicros: totalsForOrganization?.estimatedCostMicros ?? 0,
      callCount: totalsForOrganization?.callCount ?? 0,
      bySurface: sortBySurface(totalsForOrganization?.bySurface ?? []),
    }
  })
}

/**
 * ADMIN-9 — one course's own usage, broken down by surface, computed
 * directly for the single course rather than by reading it out of
 * `getOrganizationUsageSummary`'s own whole-organization scan (which the
 * course's own console screen has no reason to pay for just to render one
 * row of it).
 */
export interface CourseUsage {
  totalCostMicros: number
  callCount: number
  bySurface: CostBySurface[]
}

export function getCourseUsageSummary(
  organizationId: string,
  courseId: string,
  db: Database
): CourseUsage {
  const rows = db
    .select({
      surface: costLedgerEntries.surface,
      costMicros: sum(costLedgerEntries.costMicros),
      estimatedCostMicros: sql<number>`sum(case when ${costLedgerEntries.measurement} = 'estimated' then ${costLedgerEntries.costMicros} else 0 end)`,
      callCount: sql<number>`count(*)`,
    })
    .from(costLedgerEntries)
    .where(
      and(
        eq(costLedgerEntries.organizationId, organizationId),
        eq(costLedgerEntries.courseId, courseId)
      )
    )
    .groupBy(costLedgerEntries.surface)
    .all()

  let totalCostMicros = 0
  let callCount = 0
  const bySurface: CostBySurface[] = []
  for (const row of rows) {
    const rowCostMicros = Number(row.costMicros ?? 0)
    const rowEstimatedCostMicros = Number(row.estimatedCostMicros ?? 0)
    const rowCallCount = Number(row.callCount)
    totalCostMicros += rowCostMicros
    callCount += rowCallCount
    bySurface.push({
      surface: row.surface,
      costMicros: rowCostMicros,
      estimatedCostMicros: rowEstimatedCostMicros,
      callCount: rowCallCount,
    })
  }

  return { totalCostMicros, callCount, bySurface: sortBySurface(bySurface) }
}

/**
 * ADMIN-9 — one course's cost, broken down by the person it was charged to,
 * in a single grouped query rather than one read per enrolled person — the
 * same "batch the fan-out" style `getOrganizationUsageSummary` already uses
 * for its own per-course breakdown. `routes/admin.ts` looks this up by
 * `personId` for every person the course's people list already has to
 * render, from `enrolments.listEnrolmentsForCourse`.
 */
export interface PersonCourseUsage {
  personId: string
  costMicros: number
  callCount: number
}

export function getCoursePersonUsage(
  organizationId: string,
  courseId: string,
  db: Database
): PersonCourseUsage[] {
  const rows = db
    .select({
      personId: costLedgerEntries.personId,
      costMicros: sum(costLedgerEntries.costMicros),
      callCount: sql<number>`count(*)`,
    })
    .from(costLedgerEntries)
    .where(
      and(
        eq(costLedgerEntries.organizationId, organizationId),
        eq(costLedgerEntries.courseId, courseId)
      )
    )
    .groupBy(costLedgerEntries.personId)
    .all()

  return rows.map((row) => ({
    personId: row.personId,
    costMicros: Number(row.costMicros ?? 0),
    callCount: Number(row.callCount),
  }))
}

/**
 * ADMIN-10 — every account's own total spend and call count, across every
 * organization it has ever been charged in, for the console's Users list.
 * An account is reached from `cost_ledger_entries.personId` through
 * `person_identities` (`surface = 'web'`, `externalId = accountId` —
 * `people.ts`'s own module comment on that mapping): joined here rather
 * than in `routes/admin.ts`, the same "the cost-ledger reasoning stays in
 * this file" discipline `listOrganizationTotals` already holds itself to.
 *
 * TEN-2 exception, the same class `listOrganizationTotals` already is: a
 * platform administrator's own read, spanning every organization (and every
 * account) by definition, allowlisted in
 * `tests/tenant-scoping-convention.test.ts` accordingly.
 */
export interface AccountTotal {
  accountId: string
  totalCostMicros: number
  callCount: number
}

export function listAccountTotals(db: Database): AccountTotal[] {
  const rows = db
    .select({
      accountId: personIdentities.externalId,
      costMicros: sum(costLedgerEntries.costMicros),
      callCount: sql<number>`count(*)`,
    })
    .from(costLedgerEntries)
    .innerJoin(
      personIdentities,
      and(
        eq(personIdentities.personId, costLedgerEntries.personId),
        eq(personIdentities.surface, 'web')
      )
    )
    .groupBy(personIdentities.externalId)
    .all()

  return rows.map((row) => ({
    accountId: row.accountId,
    totalCostMicros: Number(row.costMicros ?? 0),
    callCount: Number(row.callCount),
  }))
}

/**
 * ADMIN-11 — one account's own usage, across every organization it has ever
 * been charged in: its total, broken down by surface (COST-7) and by course
 * (naming the course and the organization it belongs to, for the console
 * to link each one), and when it was last active. `hasEstimated` (COST-6's
 * "never presented as a measurement") is `true` when any part of the total
 * came from an estimated row rather than a measured one — the account
 * screen has no per-course estimate breakdown to show, unlike
 * `CourseUsageSummary`'s own `estimatedCostMicros`, so this collapses to a
 * single boolean rather than carrying the full amount through.
 *
 * The account's own people are found the same way `listAccountTotals`
 * above resolves one account's cost — through `person_identities`
 * (`surface = 'web'`, `externalId = accountId`) — across every organization,
 * since an account can hold a distinct `web` person in each one it is
 * connected to (`people.ts#listConnectedOrganizationsForAccount`'s own
 * comment on that shape). A course whose own row has since been deleted
 * (PROJ-8 nulls `cost_ledger_entries.course_id`) still counts toward the
 * total and `bySurface`, but is excluded from `byCourse` — there is no
 * course left to name.
 *
 * TEN-2 exception, the same class `listAccountTotals` above and
 * `people.ts#listConnectedOrganizationsForAccount` already are: an
 * account's own usage is not scoped to one organization until this call
 * resolves it, allowlisted in `tests/tenant-scoping-convention.test.ts`
 * accordingly.
 */
export interface AccountCourseUsage {
  courseId: string
  courseTitle: string
  organizationId: string
  totalCostMicros: number
  callCount: number
}

export interface AccountUsageSummary {
  totalCostMicros: number
  callCount: number
  hasEstimated: boolean
  bySurface: CostBySurface[]
  byCourse: AccountCourseUsage[]
  lastActiveAt: number | null
}

export function getAccountUsageSummary(
  accountId: string,
  db: Database
): AccountUsageSummary {
  const personRows = db
    .select({ personId: personIdentities.personId })
    .from(personIdentities)
    .where(
      and(
        eq(personIdentities.surface, 'web'),
        eq(personIdentities.externalId, accountId)
      )
    )
    .all()
  const personIds = personRows.map((row) => row.personId)
  if (personIds.length === 0) {
    return {
      totalCostMicros: 0,
      callCount: 0,
      hasEstimated: false,
      bySurface: [],
      byCourse: [],
      lastActiveAt: null,
    }
  }

  const rows = db
    .select({
      courseId: costLedgerEntries.courseId,
      organizationId: costLedgerEntries.organizationId,
      surface: costLedgerEntries.surface,
      costMicros: sum(costLedgerEntries.costMicros),
      estimatedCostMicros: sql<number>`sum(case when ${costLedgerEntries.measurement} = 'estimated' then ${costLedgerEntries.costMicros} else 0 end)`,
      callCount: sql<number>`count(*)`,
    })
    .from(costLedgerEntries)
    .where(inArray(costLedgerEntries.personId, personIds))
    .groupBy(
      costLedgerEntries.courseId,
      costLedgerEntries.organizationId,
      costLedgerEntries.surface
    )
    .all()

  const lastActiveRow = db
    .select({
      lastCreatedAt: sql<number | null>`max(${costLedgerEntries.createdAt})`,
    })
    .from(costLedgerEntries)
    .where(inArray(costLedgerEntries.personId, personIds))
    .get()

  let totalCostMicros = 0
  let totalEstimatedCostMicros = 0
  let callCount = 0
  const bySurfaceMap = new Map<CostLedgerSurface, CostBySurface>()
  const byCourseMap = new Map<
    string,
    { organizationId: string; costMicros: number; callCount: number }
  >()
  for (const row of rows) {
    const rowCostMicros = Number(row.costMicros ?? 0)
    const rowEstimatedCostMicros = Number(row.estimatedCostMicros ?? 0)
    const rowCallCount = Number(row.callCount)
    totalCostMicros += rowCostMicros
    totalEstimatedCostMicros += rowEstimatedCostMicros
    callCount += rowCallCount

    const surfaceTotals = bySurfaceMap.get(row.surface) ?? {
      surface: row.surface,
      costMicros: 0,
      estimatedCostMicros: 0,
      callCount: 0,
    }
    surfaceTotals.costMicros += rowCostMicros
    surfaceTotals.estimatedCostMicros += rowEstimatedCostMicros
    surfaceTotals.callCount += rowCallCount
    bySurfaceMap.set(row.surface, surfaceTotals)

    if (row.courseId !== null) {
      const courseTotals = byCourseMap.get(row.courseId) ?? {
        organizationId: row.organizationId,
        costMicros: 0,
        callCount: 0,
      }
      courseTotals.costMicros += rowCostMicros
      courseTotals.callCount += rowCallCount
      byCourseMap.set(row.courseId, courseTotals)
    }
  }

  const courseIds = [...byCourseMap.keys()]
  const courseTitleById = new Map<string, string>()
  if (courseIds.length > 0) {
    const courseRows = db
      .select({ id: courses.id, title: courses.title })
      .from(courses)
      .where(inArray(courses.id, courseIds))
      .all()
    for (const course of courseRows) {
      courseTitleById.set(course.id, course.title)
    }
  }

  return {
    totalCostMicros,
    callCount,
    hasEstimated: totalEstimatedCostMicros > 0,
    bySurface: sortBySurface([...bySurfaceMap.values()]),
    byCourse: [...byCourseMap.entries()].map(([courseId, totals]) => ({
      courseId,
      courseTitle: courseTitleById.get(courseId) ?? '',
      organizationId: totals.organizationId,
      totalCostMicros: totals.costMicros,
      callCount: totals.callCount,
    })),
    lastActiveAt: lastActiveRow?.lastCreatedAt ?? null,
  }
}
