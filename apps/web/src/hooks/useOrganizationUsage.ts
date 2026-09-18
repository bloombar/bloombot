/**
 * COST-4/WEB-63 — the read `pages/Usage.tsx` and the course tab's own
 * `components/CourseUsage.tsx` both need: every course's usage in the
 * caller's organization, for today, refreshable on demand. Extracted so the
 * fetch — and the "today, in the browser's own local timezone" reasoning
 * behind it — exists in one place rather than two screens each keeping
 * their own copy in step by hand.
 */

import { useCallback, useEffect, useState } from 'react'

import { ApiError, fetchOrganizationUsage } from '../api/client.js'
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

/**
 * `costLedger.organizationUsage`'s own report, fetched for `organizationId`
 * and today, with a `refresh` a caller can re-run after a change that would
 * move the numbers (`pages/Usage.tsx`'s own cap save/clear, for instance).
 * `refresh` resolves once the fetch lands, so a caller with its own
 * follow-up state (`pages/Usage.tsx`'s `capInput`) can chain off it.
 */
export function useOrganizationUsageReport(organizationId: string): {
  report: OrganizationUsageReport | undefined
  loadError: ApiError | undefined
  refresh: () => Promise<void>
} {
  const [report, setReport] = useState<OrganizationUsageReport | undefined>(
    undefined
  )
  const [loadError, setLoadError] = useState<ApiError | undefined>(undefined)

  const refresh = useCallback(
    () =>
      fetchOrganizationUsage(organizationId, today()).then(
        (result) => {
          setReport(result)
          setLoadError(undefined)
        },
        (caught: unknown) => {
          if (caught instanceof ApiError) setLoadError(caught)
          else throw caught
        }
      ),
    [organizationId]
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { report, loadError, refresh }
}
