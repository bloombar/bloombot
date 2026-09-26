/**
 * `hooks/useOrganizationUsage.ts` (WEB-77/WEB-78 rework round 2): the
 * stale-response guard (must-fix 2) and the "an explicit re-fetch always
 * refetches" behaviour (must-fix 11) — both hard to see from `pages/Usage.tsx`'s
 * own tests, which never race two fetches against each other.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OrganizationUsageReport } from '../src/api/types.js'
import { useOrganizationUsageReport } from '../src/hooks/useOrganizationUsage.js'

const { fetchOrganizationUsage } = vi.hoisted(() => ({
  fetchOrganizationUsage: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, fetchOrganizationUsage }
})

function report(
  overrides: Partial<OrganizationUsageReport> = {}
): OrganizationUsageReport {
  return {
    organizationId: 'org-1',
    spendingCapMicros: null,
    totalCostMicros: 0,
    totalEstimatedCostMicros: 0,
    unfilteredTotalCostMicros: 0,
    courses: [],
    studentsNearLimit: [],
    bySurface: [],
    people: [],
    ...overrides,
  }
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('useOrganizationUsageReport — round 2, must-fix 2 (stale-response guard)', () => {
  it('discards an older fetch that resolves after a newer one already has', async () => {
    let resolveFirst: ((value: OrganizationUsageReport) => void) | undefined
    let resolveSecond: ((value: OrganizationUsageReport) => void) | undefined
    fetchOrganizationUsage
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveFirst = resolve))
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveSecond = resolve))
      )

    const { result, rerender } = renderHook(
      ({ filters }) => useOrganizationUsageReport('org-1', filters),
      { initialProps: { filters: {} } }
    )

    // A second, distinct filters object — the hook's own re-fetch trigger
    // (a fresh reference, `hooks/useOrganizationUsage.ts`'s own doc
    // comment).
    rerender({ filters: { surface: 'mcp' as const } })

    await waitFor(() => expect(fetchOrganizationUsage).toHaveBeenCalledTimes(2))

    // The *newer* request (filtered) resolves first; the *older*
    // (unfiltered) resolves after it — landing out of order is exactly
    // what a race between two "Apply" clicks could do.
    await act(async () => {
      resolveSecond?.(report({ totalCostMicros: 200 }))
    })
    await waitFor(() =>
      expect(result.current.report?.totalCostMicros).toBe(200)
    )

    await act(async () => {
      resolveFirst?.(report({ totalCostMicros: 100 }))
    })

    // The stale, older response must never overwrite the newer one.
    expect(result.current.report?.totalCostMicros).toBe(200)
  })
})

describe('useOrganizationUsageReport — round 2, must-fix 11 (Apply always refetches)', () => {
  it('refetches when refresh() is called again with the identical filters content', async () => {
    fetchOrganizationUsage.mockResolvedValue(report())
    // A stable reference, the same shape a real caller's own `useState`
    // holds it in across renders (`hooks/useOrganizationUsage.ts`'s own
    // doc comment on why this hook depends on `filters` by reference) —
    // an object recreated on every call would itself trigger a second
    // fetch through the auto-refetch effect, muddying what this test
    // means to isolate: a caller explicitly calling `refresh()` again.
    const stableFilters = { surface: 'web' as const }

    const { result } = renderHook(() =>
      useOrganizationUsageReport('org-1', stableFilters)
    )

    await waitFor(() => expect(fetchOrganizationUsage).toHaveBeenCalledTimes(1))

    await act(async () => {
      await result.current.refresh()
    })

    // A second, genuine fetch — not skipped because the filters "look the
    // same" as last time.
    expect(fetchOrganizationUsage).toHaveBeenCalledTimes(2)
  })

  it('refetches when a caller passes a new, but content-identical, filters object — an "Apply" click always means fresh data', async () => {
    fetchOrganizationUsage.mockResolvedValue(report())

    const { rerender } = renderHook(
      ({ filters }) => useOrganizationUsageReport('org-1', filters),
      { initialProps: { filters: { surface: 'web' as const } } }
    )
    await waitFor(() => expect(fetchOrganizationUsage).toHaveBeenCalledTimes(1))

    // A fresh object literal, identical content — the same shape a second
    // "Apply filters" click with unchanged fields would create
    // (`components/UsageFilterRow.tsx`'s own `onApply`).
    rerender({ filters: { surface: 'web' as const } })

    await waitFor(() => expect(fetchOrganizationUsage).toHaveBeenCalledTimes(2))
  })
})
