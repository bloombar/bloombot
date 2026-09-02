/**
 * ADMIN-4/ADMIN-5: `pages/Admin.tsx` — organizations, usage and health, and
 * the confirmed, audited tenant deletion. ADMIN-4's own boundary (never a
 * course, a student or a message) is proven at the HTTP layer
 * (`apps/api/tests/routes/admin.test.ts`) — this file proves the panel's
 * own confirmation is real: a mismatched name refuses, and the deletion is
 * a typed-name prompt, not a plain confirm a stray click could pass
 * (WEB-15).
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import { Admin } from '../src/pages/Admin.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const {
  fetchAdminOrganizations,
  fetchDeletionPreview,
  fetchTenantDeletions,
  deleteTenant,
} = vi.hoisted(() => ({
  fetchAdminOrganizations: vi.fn(),
  fetchDeletionPreview: vi.fn(),
  fetchTenantDeletions: vi.fn(),
  deleteTenant: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    fetchAdminOrganizations,
    fetchDeletionPreview,
    fetchTenantDeletions,
    deleteTenant,
  }
})

afterEach(() => {
  vi.resetAllMocks()
})

// Every test in this file exercises `fetchAdminOrganizations`; ADMIN-5's own
// audit trail (`fetchTenantDeletions`) is a second, independent read the
// same screen also fires on mount — defaulted to an empty list here so a
// test that does not care about deletion history does not have to mock it
// itself, the same "a test overrides only the one field its own scenario
// needs" convention `build-test-app.ts`'s own module comment states for a
// different helper.
beforeEach(() => {
  fetchTenantDeletions.mockResolvedValue([])
})

const PLATFORM_HEALTH = {
  bot: { reachable: true },
  worker: { reachable: true },
  api: { reachable: true },
}

const PREVIEW = {
  organizationId: 'org-1',
  organizationName: 'A Real Tenant',
  courses: 2,
  people: 5,
  conversations: 3,
  messages: 10,
  enrolments: 5,
  discordServerBindings: 1,
  courseAttachments: 0,
  queuedJobs: 0,
}

describe('Admin (ADMIN-4)', () => {
  it('lists organizations with their usage', async () => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [
        {
          organizationId: 'org-1',
          organizationName: 'A Real Tenant',
          totalCostMicros: 1_500_000,
          estimatedCostMicros: 0,
          callCount: 3,
        },
      ],
      platformHealth: PLATFORM_HEALTH,
    })

    renderWithModal(<Admin onBack={vi.fn()} />)

    expect(await screen.findByText('A Real Tenant')).toBeInTheDocument()
    expect(screen.getByText(/\$1\.50 spent/)).toBeInTheDocument()
  })

  // Also-fix of the ADMIN-1..5 rework: this screen's own module comment
  // claimed every read went through `fetchTenantDeletions`, but nothing
  // ever called it — dead code masquerading as a documented one.
  it('shows ADMIN-5’s own deletion history, once fetched', async () => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [],
      platformHealth: PLATFORM_HEALTH,
    })
    fetchTenantDeletions.mockResolvedValue([
      {
        id: 'deletion-1',
        organizationId: 'org-1',
        organizationName: 'A Departed Tenant',
        deletedByAccountId: 'account-1',
        summary: '{}',
        deletedAt: Date.now(),
      },
    ])

    renderWithModal(<Admin onBack={vi.fn()} />)

    expect(await screen.findByText('A Departed Tenant')).toBeInTheDocument()
  })

  it('a non-administrator sees the refusal in words, not a blank screen', async () => {
    fetchAdminOrganizations.mockRejectedValue(
      new ApiError(403, { error: 'not_platform_administrator' })
    )

    renderWithModal(<Admin onBack={vi.fn()} />)

    expect(
      await screen.findByText(/platform-administrator access/i)
    ).toBeInTheDocument()
  })
})

describe('Admin — ADMIN-5’s confirmed, audited deletion', () => {
  it('previews what will be deleted, then requires the organization’s own name typed exactly', async () => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [
        {
          organizationId: 'org-1',
          organizationName: 'A Real Tenant',
          totalCostMicros: 0,
          estimatedCostMicros: 0,
          callCount: 0,
        },
      ],
      platformHealth: PLATFORM_HEALTH,
    })
    fetchDeletionPreview.mockResolvedValue(PREVIEW)

    renderWithModal(<Admin onBack={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    // ADMIN-5: "names exactly what will be deleted before it happens" — the
    // preview's own counts are read into the confirmation itself.
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('2 course(s)')
    expect(dialog).toHaveTextContent('5 student record(s)')

    // Typing the wrong name keeps the dialog open and never calls through.
    const field = within(dialog).getByLabelText('Organization name')
    fireEvent.change(field, { target: { value: 'the wrong name' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(
      await screen.findByText('Type the name exactly to confirm.')
    ).toBeInTheDocument()
    expect(deleteTenant).not.toHaveBeenCalled()

    // The exact name proceeds.
    fireEvent.change(field, { target: { value: 'A Real Tenant' } })
    deleteTenant.mockResolvedValue({ deleted: true })
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [],
      platformHealth: PLATFORM_HEALTH,
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() =>
      expect(deleteTenant).toHaveBeenCalledWith('org-1', 'A Real Tenant')
    )
  })

  it('a mismatched name server-side (e.g. a race with a rename) surfaces as a refusal, not a silent no-op', async () => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [
        {
          organizationId: 'org-1',
          organizationName: 'A Real Tenant',
          totalCostMicros: 0,
          estimatedCostMicros: 0,
          callCount: 0,
        },
      ],
      platformHealth: PLATFORM_HEALTH,
    })
    fetchDeletionPreview.mockResolvedValue(PREVIEW)
    deleteTenant.mockRejectedValue(
      new ApiError(409, { error: 'confirmation_name_mismatch' })
    )

    renderWithModal(<Admin onBack={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Organization name'), {
      target: { value: 'A Real Tenant' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/did not match/i)
  })
})
