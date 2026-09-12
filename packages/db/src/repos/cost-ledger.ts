/**
 * Repository for `cost_ledger_entries` and `organizations.spending_cap_micros`
 * (COST-1..6).
 *
 * Every function that reaches into one organization's own ledger is scoped
 * by `organizationId`, its first parameter — the same TEN-2 discipline every
 * other file in this directory holds itself to. `listOrganizationTotals` is
 * this file's one documented exception: it is the platform administrator's
 * own read (COST-4's "a platform administrator sees usage per organization"),
 * which by definition spans every organization rather than one — the same
 * class of exception `repos/jobs.ts#countQueuedJobs` already is for JOB-5's
 * own "how deep is the queue, platform-wide" operational read.
 */

import { and, eq, sql, sum } from 'drizzle-orm'

import type { Database } from '../client.js'
import {
  COST_LEDGER_SURFACES,
  costLedgerEntries,
  courses,
  organizations,
  people,
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
  const course = db
    .select({ id: courses.id })
    .from(courses)
    .where(
      and(
        eq(courses.id, entry.courseId),
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
        eq(people.id, entry.personId),
        eq(people.organizationId, organizationId)
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
  const organization = db
    .select({ spendingCapMicros: organizations.spendingCapMicros })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
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
  const organization = db
    .select({ spendingCapMicros: organizations.spendingCapMicros })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .get()

  const courseRows = db
    .select({ id: courses.id, title: courses.title })
    .from(courses)
    .where(eq(courses.organizationId, organizationId))
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
  const totalsByCourseId = new Map<
    string,
    {
      costMicros: number
      estimatedCostMicros: number
      callCount: number
      bySurface: CostBySurface[]
    }
  >()
  const organizationBySurface = new Map<CostLedgerSurface, CostBySurface>()
  for (const row of totals) {
    const costMicros = Number(row.costMicros ?? 0)
    const estimatedCostMicros = Number(row.estimatedCostMicros ?? 0)
    const callCount = Number(row.callCount)

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
    totalCostMicros: coursesSummary.reduce(
      (sumSoFar, course) => sumSoFar + course.costMicros,
      0
    ),
    totalEstimatedCostMicros: coursesSummary.reduce(
      (sumSoFar, course) => sumSoFar + course.estimatedCostMicros,
      0
    ),
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

  const organizationRows = db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
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
