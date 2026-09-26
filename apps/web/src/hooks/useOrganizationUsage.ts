/**
 * COST-4/WEB-63 — the read `pages/Usage.tsx` and the course tab's own
 * `components/CourseUsage.tsx` both need: every course's usage in the
 * caller's organization, for today, refreshable on demand. Extracted so the
 * fetch — and the "today, in the browser's own local timezone" reasoning
 * behind it — exists in one place rather than two screens each keeping
 * their own copy in step by hand.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ApiError,
  fetchOrganizationUsage,
  type OrganizationUsageFilters,
} from '../api/client.js'
import type { OrganizationUsageReport } from '../api/types.js'

/**
 * Today, in the browser's own local timezone — `studentsNearLimit` is
 * scoped to one day (`usage.listUsageNearLimit`'s own `day` argument), and
 * an instructor reading either screen this feeds is thinking in *their*
 * today, not UTC's. Mirrors `apps/bot/src/today.ts`'s own `YYYY-MM-DD`
 * construction (local `getFullYear`/`getMonth`/`getDate`, not
 * `toISOString()`, for the identical reason that file's own comment gives)
 * rather than importing it — this app does not import another app's source
 * at all, workspace package or not.
 */
export function today(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** A stable default: a fresh `{}` each render would refetch forever, since a new filters object always refetches. */
const NO_FILTERS: OrganizationUsageFilters = {}

/**
 * `costLedger.organizationUsage`'s own report, fetched for `organizationId`
 * and today, with a `refresh` a caller can re-run after a change that would
 * move the numbers (`pages/Usage.tsx`'s own cap save/clear, for instance).
 * `refresh` resolves once the fetch lands, so a caller with its own
 * follow-up state (`pages/Usage.tsx`'s `capInput`) can chain off it.
 *
 * `filters` (WEB-77/WEB-78, optional) is passed straight through to
 * `fetchOrganizationUsage`. A caller re-fetches by passing a *new* object
 * reference (`pages/Usage.tsx`/`components/CourseUsage.tsx`'s own "Apply
 * filters" button, via `UsageFilterRow`'s own `onApply`) — deliberately by
 * reference, not by serialized content (round 2, must-fix 11): re-clicking
 * "Apply" with the identical values still creates a fresh object literal,
 * so it still refetches, which is what an explicit "Apply" click should
 * mean (fresh data, not "only if something changed"). An unrelated
 * re-render of the caller passes the *same* `filters` reference (its own
 * `appliedFilters` state is untouched), so this never refetches on its own.
 *
 * Round 2, must-fix 2 — `requestEpochRef` guards against an older fetch
 * landing after a newer one already has: two "Apply" clicks in quick
 * succession (or a cap save's own `refresh()` racing an in-flight filter
 * change) must never let the *first* response overwrite the *second*'s.
 */
export function useOrganizationUsageReport(
  organizationId: string,
  filters: OrganizationUsageFilters = NO_FILTERS
): {
  report: OrganizationUsageReport | undefined
  loadError: ApiError | undefined
  refresh: () => Promise<void>
} {
  const [report, setReport] = useState<OrganizationUsageReport | undefined>(
    undefined
  )
  const [loadError, setLoadError] = useState<ApiError | undefined>(undefined)
  const requestEpochRef = useRef(0)

  const refresh = useCallback(() => {
    const epoch = ++requestEpochRef.current
    return fetchOrganizationUsage(organizationId, today(), filters).then(
      (result) => {
        if (requestEpochRef.current !== epoch) return
        setReport(result)
        setLoadError(undefined)
      },
      (caught: unknown) => {
        if (requestEpochRef.current !== epoch) return
        if (caught instanceof ApiError) setLoadError(caught)
        else throw caught
      }
    )
  }, [organizationId, filters])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { report, loadError, refresh }
}
