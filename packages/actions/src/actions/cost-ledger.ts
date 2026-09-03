/**
 * COST-4's instructor read: usage across the caller's own organization,
 * plus which students are approaching their courses' own daily limits.
 * COST-3's write: setting (or clearing) that same organization's own
 * spending cap.
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
 *
 * An audit (`docs/ROADMAP.md`'s "Audit — surfaces that were never built")
 * found `organizations.setSpendingCap` (`@bloombot/db`) had zero
 * non-test callers anywhere in the monorepo — the enforcement half of
 * COST-3 (`@bloombot/core`'s `answer.ts`, calling `hasReachedSpendingCap`)
 * was real, but the cap it enforces could never actually be set outside a
 * test. `setSpendingCapAction`, below, is what closes that: see
 * `docs/DECISIONS.md` for the full accounting.
 */

import { costLedger, memberships, organizations, usage } from '@bloombot/db'
import { z } from 'zod'

import { ActionRefusedError } from '../errors.js'
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

const setSpendingCapInputSchema = z.object({
  /**
   * The cap, in the organization's own currency — not micros. This
   * platform's own cost table (`@bloombot/config`'s `MODEL_PRICING_JSON`,
   * `packages/config/src/pricing.ts`) is denominated in USD, so that is
   * what an instructor types here: `12.5` for $12.50, never
   * `12_500_000`. `null` clears the cap entirely, distinct from `0`
   * (`toMicros`/`execute`, below, and `@bloombot/db`'s own
   * `hasReachedSpendingCap`, whose tri-state reads `null` as "no cap at
   * all" and `0` as "a cap that blocks every call").
   */
  capAmount: z.number().nonnegative().nullable(),
})
type SetSpendingCapInput = z.infer<typeof setSpendingCapInputSchema>

/** What `costLedger.setSpendingCap` hands back — enough for a caller to confirm what is now stored, without re-reading the whole organization row. */
export interface SetSpendingCapResult {
  organizationId: string
  spendingCapMicros: number | null
}

/**
 * Dollars to integer micros, rounded once, at the end — the same
 * "`Math.round` once, not on every intermediate step" discipline
 * `@bloombot/core`'s own `pricing.ts#computeCost` already holds itself to
 * (D-2's "money as INTEGER micros"). `capAmount * 1_000_000` alone can drift
 * by a fraction of a cent under floating-point arithmetic (`10.1 * 1_000_000`
 * is `10099999.999999998` in IEEE 754 double precision, not `10100000`) —
 * rounding is what turns that back into the exact integer an instructor's
 * decimal input actually meant, the same way `computeCost`'s own rounding
 * closes the identical gap for a priced token count.
 */
function toMicros(capAmount: number): number {
  return Math.round(capAmount * 1_000_000)
}

/**
 * COST-3 — set (or clear) the caller's organization's own spending cap.
 * This is the action layer `@bloombot/db`'s own `organizations.setSpendingCap`
 * has never had (that function's own doc comment used to say so directly;
 * corrected once this landed) — before this action existed,
 * `hasReachedSpendingCap` (`@bloombot/core#answer.ts`'s own enforcement)
 * could never see a cap in a real deployment, because nothing anywhere
 * could set one outside a test.
 *
 * **Restricted to an owner**, the same shape `memberships.grant`
 * (`actions/memberships.ts`) already takes for the same reason: a spending
 * cap is a write with organization-wide, financial consequences — set too
 * low, it stops the assistant answering for every course in the
 * organization at once, not merely the caller's own. `routes/actions.ts`
 * admits any membership regardless of role (`policy.ts`'s own "a descriptor
 * documents, it does not enforce"), so this check has to live in `execute`,
 * reading `accountId` the same way `memberships.grant`'s own doc comment
 * explains a policy's `resolve` cannot (`PolicyContext` carries no caller
 * identity at all).
 */
export const setSpendingCapAction: Action<
  'costLedger.setSpendingCap',
  SetSpendingCapInput,
  NonNullable<Organization>,
  SetSpendingCapResult
> = {
  name: 'costLedger.setSpendingCap',
  description:
    "Set (or clear) the caller's organization's own spending cap (COST-3): only an existing owner may call this.",
  inputSchema: setSpendingCapInputSchema,
  policy: {
    descriptor: { resource: 'organization', access: 'write' },
    resolve: (_input, context) =>
      organizations.getOrganizationById(context.organizationId, context.db),
  },
  execute: ({ organizationId, input, accountId, db }) => {
    if (!accountId) throw new ActionRefusedError()

    const callerMembership = memberships.getMembership(
      organizationId,
      accountId,
      db
    )
    if (!callerMembership || callerMembership.role !== 'owner') {
      throw new ActionRefusedError()
    }

    const spendingCapMicros =
      input.capAmount === null ? null : toMicros(input.capAmount)
    const updated = organizations.setSpendingCap(
      organizationId,
      spendingCapMicros,
      db
    )
    // `resolve` (above) already proved this organization exists — this
    // would mean it vanished between resolve and execute, the same
    // "shouldn't happen, but do not trust it blindly" discipline every
    // other write in this package already holds itself to.
    if (!updated) throw new ActionRefusedError()

    return {
      organizationId: updated.id,
      spendingCapMicros: updated.spendingCapMicros,
    }
  },
}
