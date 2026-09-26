/**
 * `components/DangerZone.tsx` (WEB-69/WEB-72/DATA-7): an organization's own
 * delete control, on its own tab since WEB-69 moved it out of
 * `components/Team.tsx` (that file's own module comment on why) —
 * everything below is copied verbatim from what used to be
 * `team.test.tsx`'s own "Team — Danger zone" describe block, unchanged
 * except for rendering `DangerZone` directly rather than `Team`: the typed-
 * name gate, the fallback navigation afterward, and resolving the fresh
 * account are all the same behaviour, still exercised the same way.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import { DangerZone } from '../src/components/DangerZone.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const { softDeleteOrganization } = vi.hoisted(() => ({
  softDeleteOrganization: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    softDeleteOrganization,
  }
})

afterEach(() => {
  vi.resetAllMocks()
})

describe('DangerZone (WEB-69/WEB-72/DATA-7)', () => {
  it('renders the delete control', () => {
    renderWithModal(
      <DangerZone
        organizationId="org-1"
        organizationName="Org One"
        navigate={vi.fn()}
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
      />
    )
    expect(
      screen.getByRole('button', { name: 'Delete organization' })
    ).toBeInTheDocument()
  })

  it('cancelling the confirmation sends nothing', async () => {
    renderWithModal(
      <DangerZone
        organizationId="org-1"
        organizationName="Org One"
        navigate={vi.fn()}
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete organization' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(softDeleteOrganization).not.toHaveBeenCalled()
  })

  it('typing the wrong name keeps the delete button inert and sends nothing; the exact name proceeds and moves the caller to another organization', async () => {
    softDeleteOrganization.mockResolvedValue({ id: 'org-1', name: 'Org One' })
    const navigate = vi.fn()
    // Review finding — `refreshAccount` still names `org-1` (the one this
    // screen is about to delete) alongside `org-2`, the same shape a stale
    // or slow-to-propagate `/auth/me` response could have even though the
    // real route excludes a soft-deleted organization at the query
    // (DATA-9). `DangerZone.tsx#handleDelete`'s own belt-and-braces filter
    // is what this asserts: `org-2` is chosen, `org-1` — the thing just
    // deleted — never is, regardless of what this mock returns.
    const refreshAccount = vi.fn().mockResolvedValue({
      id: 'account-1',
      email: 'owner@example.edu',
      isPlatformAdministrator: false,
      memberships: [
        { organizationId: 'org-1', organizationName: 'Org One', role: 'owner' },
        { organizationId: 'org-2', organizationName: 'Org Two', role: 'owner' },
      ],
      connectedOrganizations: [],
    })

    renderWithModal(
      <DangerZone
        organizationId="org-1"
        organizationName="Org One"
        navigate={navigate}
        refreshAccount={refreshAccount}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete organization' }))
    const dialog = await screen.findByRole('dialog')

    const field = within(dialog).getByLabelText('Organization name')
    const confirmButton = within(dialog).getByRole('button', {
      name: 'Delete organization',
    })
    expect(confirmButton).toBeDisabled()
    fireEvent.change(field, { target: { value: 'the wrong name' } })
    expect(confirmButton).toBeDisabled()
    expect(softDeleteOrganization).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: 'Org One' } })
    expect(confirmButton).not.toBeDisabled()
    fireEvent.click(confirmButton)

    await waitFor(() =>
      expect(softDeleteOrganization).toHaveBeenCalledWith('org-1')
    )
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        kind: 'projects',
        organizationId: 'org-2',
      })
    )
  })

  it('moves the caller to their own account screen when no organization is left', async () => {
    softDeleteOrganization.mockResolvedValue({ id: 'org-1', name: 'Org One' })
    const navigate = vi.fn()
    // Review finding — `refreshAccount` still names `org-1` (the one just
    // deleted), the identical stale-response shape the sibling test above
    // exercises: with nothing else in either list, the belt-and-braces
    // filter must still land on `/account`, not on the organization this
    // screen just deleted.
    const refreshAccount = vi.fn().mockResolvedValue({
      id: 'account-1',
      email: 'owner@example.edu',
      isPlatformAdministrator: false,
      memberships: [
        { organizationId: 'org-1', organizationName: 'Org One', role: 'owner' },
      ],
      connectedOrganizations: [],
    })

    renderWithModal(
      <DangerZone
        organizationId="org-1"
        organizationName="Org One"
        navigate={navigate}
        refreshAccount={refreshAccount}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete organization' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Organization name'), {
      target: { value: 'Org One' },
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Delete organization' })
    )

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ kind: 'account' })
    )
  })

  it('a failed delete is reported and the caller stays put', async () => {
    softDeleteOrganization.mockRejectedValue(
      new ApiError(403, { error: 'not_authorized' })
    )
    const navigate = vi.fn()

    renderWithModal(
      <DangerZone
        organizationId="org-1"
        organizationName="Org One"
        navigate={navigate}
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete organization' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Organization name'), {
      target: { value: 'Org One' },
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Delete organization' })
    )

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })
})
