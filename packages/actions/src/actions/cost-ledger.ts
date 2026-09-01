/**
 * COST-4's instructor read: usage across the caller's own organization,
 * plus which students are approaching their courses' own daily limits.
 *
 * This is the only half of COST-4 that fits `ActionRegistry`/`dispatch.ts`
 * at all — `DispatchContext.organizationId` (`dispatch.ts`'s own doc
 * comment) names the one organization the caller is acting within, which is
 * exactly the shape an instructor's own read takes. COST-4's *other* read —
 * "a platform administrator sees usage per organization" — spans every
 * organization by definition, which this pipeline has no way to express (an
 * administrator is not "acting within" any one tenant); it is
 * `@bloombot/db`'s own `costLedger.listOrganizationTotals`, called directly
 * by whichever surface authorizes the caller as a platform administrator
 * (`@bloombot/auth`'s `isPlatformAdministrator`) — see that function's own
 * module comment, and `docs/DECISIONS.md`.
 */

import { costLedger, organizations, usage } from '@bloombot/db'
import { z } from 'zod'

import type { Action } from '../types.js'

type Organization = ReturnType<typeof organizations.getOrganizationById>

const organizationUsageInputSchema = z.object({
  /** `YYYY-MM-DD` — which day's usage counters `studentsNearLimit` is read against (`@bloombot/db`'s own `usage.ts` module comment: the day boundary is always supplied by the caller, never read from a clock in here). */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'day must be YYYY-MM-DD'),
})
type OrganizationUsageInput = z.infer<typeof organizationUsageInputSchema>

/** What `costLedger.organizationUsage` hands back — `@bloombot/db`'s own summary, plus the day's near-limit students. */
export interface OrganizationUsageReport {
  organizationId: string
  spendingCapMicros: number | null
  totalCostMicros: number
  /** The portion of `totalCostMicros` that came from an estimate rather than a measurement (`@bloombot/db`'s own `costLedger.getOrganizationUsageSummary`, finding 2 of the COST-1 rework) — see its own comment for why an instructor's read needs to say this at all. */
  totalEstimatedCostMicros: number
  courses: costLedger.CourseUsageSummary[]
  studentsNearLimit: usage.UsageNearLimit[]
}

/**
 * COST-4 — "an instructor sees their courses' usage and the students
 * approaching their limits", both in one read: usage cost per course
 * (`@bloombot/db`'s `costLedger.getOrganizationUsageSummary`) and, for the
 * given day, who is close to a course's own daily allowance
 * (`usage.listUsageNearLimit`). Resolves the organization itself, the same
 * "no existing record of its own — the organization is the resource" shape
 * `discordServers.list`/`projects.list` already use, read rather than
 * written.
 */
export const organizationUsageAction: Action<
  'costLedger.organizationUsage',
  OrganizationUsageInput,
  NonNullable<Organization>,
  OrganizationUsageReport
> = {
  name: 'costLedger.organizationUsage',
  description:
    "Read the caller's organization's usage cost per course, and which students are approaching a course's own daily limit.",
  inputSchema: organizationUsageInputSchema,
  policy: {
    descriptor: { resource: 'organization', access: 'read' },
    resolve: (_input, context) =>
      organizations.getOrganizationById(context.organizationId, context.db),
  },
  execute: ({ organizationId, input, db }) => {
    const summary = costLedger.getOrganizationUsageSummary(organizationId, db)
    const studentsNearLimit = usage.listUsageNearLimit(
      organizationId,
      input.day,
      db
    )
    return {
      organizationId: summary.organizationId,
      spendingCapMicros: summary.spendingCapMicros,
      totalCostMicros: summary.totalCostMicros,
      totalEstimatedCostMicros: summary.totalEstimatedCostMicros,
      courses: summary.courses,
      studentsNearLimit,
    }
  },
}
