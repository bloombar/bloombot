/**
 * `pages/Usage.tsx` (COST-3/COST-4): an instructor's own courses' usage,
 * which students are approaching their limits, and (an owner only) setting
 * or clearing the organization's spending cap. Every case below is what
 * that component's own module comment promises: three visually distinct
 * cap states, an owner-only form, a cap cleared distinctly from a cap set
 * to zero, and never a student's email.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { OrganizationUsageReport } from '../src/api/types.js'
import { Usage } from '../src/pages/Usage.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const { fetchOrganizationUsage, setSpendingCap } = vi.hoisted(() => ({
  fetchOrganizationUsage: vi.fn(),
  setSpendingCap: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    fetchOrganizationUsage,
    setSpendingCap,
  }
})

function report(
  overrides: Partial<OrganizationUsageReport> = {}
): OrganizationUsageReport {
  return {
    organizationId: 'org-1',
    spendingCapMicros: null,
    totalCostMicros: 0,
    totalEstimatedCostMicros: 0,
    courses: [],
    studentsNearLimit: [],
    ...overrides,
  }
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('Usage (COST-3/COST-4)', () => {
  it('shows "no cap set" when the organization has never configured one', async () => {
    fetchOrganizationUsage.mockResolvedValue(report())

    renderWithModal(<Usage organizationId="org-1" isOwner={true} />)

    expect(await screen.findByText(/No spending cap set/)).toBeInTheDocument()
  })

  it('shows a cap that is set but not reached, distinctly from "no cap"', async () => {
    fetchOrganizationUsage.mockResolvedValue(
      report({ spendingCapMicros: 20_000_000, totalCostMicros: 5_000_000 })
    )

    renderWithModal(<Usage organizationId="org-1" isOwner={true} />)

    expect(await screen.findByText(/Cap set at \$20\.00/)).toBeInTheDocument()
    expect(screen.queryByText(/No spending cap set/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Cap reached/)).not.toBeInTheDocument()
  })

  // COST-3's own enforcement (`hasReachedSpendingCap`) reads `spent >= cap`
  // — this screen derives the identical comparison from the same two
  // numbers its own read already carries, so "cap reached" must show the
  // instant spend catches up to the cap, not only once it exceeds it.
  it('shows "cap reached" once spend has caught up to the cap, distinctly from a cap with room left', async () => {
    fetchOrganizationUsage.mockResolvedValue(
      report({ spendingCapMicros: 5_000_000, totalCostMicros: 5_000_000 })
    )

    renderWithModal(<Usage organizationId="org-1" isOwner={true} />)

    expect(await screen.findByText(/Cap reached/)).toBeInTheDocument()
    expect(screen.queryByText(/^Cap set at/)).not.toBeInTheDocument()
  })

  it('lists per-course usage, money as money, and marks a total that includes an estimate', async () => {
    fetchOrganizationUsage.mockResolvedValue(
      report({
        courses: [
          {
            courseId: 'course-1',
            courseTitle: 'Web Design',
            costMicros: 1_500_000,
            estimatedCostMicros: 0,
            callCount: 3,
          },
          {
            courseId: 'course-2',
            courseTitle: 'Intro to Testing',
            costMicros: 250_000,
            estimatedCostMicros: 250_000,
            callCount: 1,
          },
        ],
      })
    )

    renderWithModal(<Usage organizationId="org-1" isOwner={true} />)

    expect(await screen.findByText('Web Design')).toBeInTheDocument()
    expect(screen.getByText(/\$1\.50 · 3 calls/)).toBeInTheDocument()
    expect(
      screen.getByText(/\$0\.25 · 1 call · includes an estimate/)
    ).toBeInTheDocument()
  })

  it('lists students approaching their limit, falling back to the person id when displayName is null — never an email', async () => {
    fetchOrganizationUsage.mockResolvedValue(
      report({
        studentsNearLimit: [
          {
            courseId: 'course-1',
            courseTitle: 'Web Design',
            personId: 'person-42',
            personDisplayName: null,
            count: 8,
            maxRequestsPerDay: 10,
          },
        ],
      })
    )

    renderWithModal(<Usage organizationId="org-1" isOwner={true} />)

    expect(await screen.findByText('person-42')).toBeInTheDocument()
    expect(screen.getByText('8 of 10 today')).toBeInTheDocument()
  })

  it('withholds the cap-setting form for a caller who is not an owner', async () => {
    fetchOrganizationUsage.mockResolvedValue(report())

    renderWithModal(<Usage organizationId="org-1" isOwner={false} />)

    await screen.findByText(/No spending cap set/)
    expect(screen.queryByLabelText('Spending cap ($)')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Save cap' })
    ).not.toBeInTheDocument()
  })

  it('an owner sets a cap, sent as a dollar amount — never micros', async () => {
    fetchOrganizationUsage.mockResolvedValue(report())
    setSpendingCap.mockResolvedValue({
      organizationId: 'org-1',
      spendingCapMicros: 12_500_000,
    })

    renderWithModal(<Usage organizationId="org-1" isOwner={true} />)
    await screen.findByText(/No spending cap set/)

    fireEvent.change(screen.getByLabelText('Spending cap ($)'), {
      target: { value: '12.50' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save cap' }))

    await waitFor(() =>
      expect(setSpendingCap).toHaveBeenCalledWith('org-1', 12.5)
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Spending cap set to $12.50.'
    )
  })

  // COST-3's own text: clearing must be possible, and distinguishable from
  // 0 — this is the "Clear cap" control's own proof, distinct from typing
  // 0 into the field and saving (which would call `setSpendingCap` with
  // `0`, not `null`).
  it('clearing the cap calls setSpendingCap with null, not 0', async () => {
    fetchOrganizationUsage.mockResolvedValue(
      report({ spendingCapMicros: 5_000_000 })
    )
    setSpendingCap.mockResolvedValue({
      organizationId: 'org-1',
      spendingCapMicros: null,
    })

    renderWithModal(<Usage organizationId="org-1" isOwner={true} />)
    await screen.findByText(/Cap set at \$5\.00/)

    fireEvent.click(screen.getByRole('button', { name: 'Clear cap' }))

    await waitFor(() =>
      expect(setSpendingCap).toHaveBeenCalledWith('org-1', null)
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Spending cap cleared.'
    )
  })

  // Rework finding — the "Clear cap" test above dispatches `handleClear`,
  // which sends `null` directly and never runs `parseCapAmount` at all;
  // nothing pinned its own blank-field branch. Blanking the field and
  // clicking *Save* is the path that actually calls `parseCapAmount('')` —
  // if that branch ever returned `{ ok: true, value: 0 }` instead of
  // `null`, this is what would still pass with `handleClear`'s own test
  // green, while an owner who meant to remove the cap silently set it to
  // `0` and blocked every student's next question instead.
  it('blanking the field and clicking Save cap clears the cap through parseCapAmount, not by sending 0', async () => {
    fetchOrganizationUsage.mockResolvedValue(
      report({ spendingCapMicros: 5_000_000 })
    )
    setSpendingCap.mockResolvedValue({
      organizationId: 'org-1',
      spendingCapMicros: null,
    })

    renderWithModal(<Usage organizationId="org-1" isOwner={true} />)
    await screen.findByText(/Cap set at \$5\.00/)

    fireEvent.change(screen.getByLabelText('Spending cap ($)'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save cap' }))

    await waitFor(() =>
      expect(setSpendingCap).toHaveBeenCalledWith('org-1', null)
    )
  })

  it('a malformed cap amount is refused client-side, next to the field, without calling setSpendingCap', async () => {
    fetchOrganizationUsage.mockResolvedValue(report())

    renderWithModal(<Usage organizationId="org-1" isOwner={true} />)
    await screen.findByText(/No spending cap set/)

    fireEvent.change(screen.getByLabelText('Spending cap ($)'), {
      target: { value: 'not a number' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save cap' }))

    expect(
      await screen.findByText(/Enter a nonnegative amount/)
    ).toBeInTheDocument()
    expect(setSpendingCap).not.toHaveBeenCalled()
  })

  it('a refused save renders the same ErrorMessage every other refusal in this app uses', async () => {
    fetchOrganizationUsage.mockResolvedValue(report())
    setSpendingCap.mockRejectedValue(
      new ApiError(404, { error: 'action_refused' })
    )

    renderWithModal(<Usage organizationId="org-1" isOwner={true} />)
    await screen.findByText(/No spending cap set/)

    fireEvent.change(screen.getByLabelText('Spending cap ($)'), {
      target: { value: '5' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save cap' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })

  it('a failed load renders the same ErrorMessage, not the usage sections', async () => {
    fetchOrganizationUsage.mockRejectedValue(
      new ApiError(500, { error: 'internal_error' })
    )

    renderWithModal(<Usage organizationId="org-1" isOwner={true} />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Try again.'
    )
    expect(screen.queryByText('Usage by course')).not.toBeInTheDocument()
  })
})
