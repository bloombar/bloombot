/**
 * WEB-57/WEB-58: `components/OrganizationList.tsx`'s own kebab — Rename on
 * a row this account owns, Leave on a row it holds a non-owner membership
 * in, and nothing on a connected-only row. Both `Account.tsx`'s own list
 * and `Organizations.tsx`'s own arrival list draw through this one
 * component (that file's own module comment), so a test here covers both.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import {
  OrganizationList,
  type OrganizationListRow,
} from '../src/components/OrganizationList.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const { renameOrganization, leaveOrganization } = vi.hoisted(() => ({
  renameOrganization: vi.fn(),
  leaveOrganization: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, renameOrganization, leaveOrganization }
})

const ROWS: OrganizationListRow[] = [
  { organizationId: 'org-1', organizationName: 'Owned Org', role: 'owner' },
  {
    organizationId: 'org-2',
    organizationName: 'Member Org',
    role: 'assistant',
  },
  { organizationId: 'org-3', organizationName: 'Connected Org' },
]

/** Opens a row's own kebab, by its own `aria-label` — the same device `tests/courses.test.tsx#openCourseMenu` already uses for `CourseRows.tsx`'s identical kebab. */
function openMenu(organizationName: string) {
  fireEvent.click(
    screen.getByRole('button', { name: `Actions for "${organizationName}"` })
  )
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('OrganizationList kebab (WEB-57/WEB-58)', () => {
  it('offers Rename, not Leave, on a row this account owns', () => {
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        onSelectOrganization={vi.fn()}
        navigate={vi.fn()}
        actionLabel="Switch"
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
      />
    )
    openMenu('Owned Org')
    const menu = screen.getByRole('group', {
      name: 'Actions for "Owned Org"',
    })
    expect(
      within(menu).getByRole('button', { name: 'Rename' })
    ).toBeInTheDocument()
    expect(
      within(menu).queryByRole('button', { name: 'Leave' })
    ).not.toBeInTheDocument()
  })

  it('offers Leave, not Rename, on a row this account holds a non-owner membership in', () => {
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        onSelectOrganization={vi.fn()}
        navigate={vi.fn()}
        actionLabel="Switch"
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
      />
    )
    openMenu('Member Org')
    const menu = screen.getByRole('group', {
      name: 'Actions for "Member Org"',
    })
    expect(
      within(menu).getByRole('button', { name: 'Leave' })
    ).toBeInTheDocument()
    expect(
      within(menu).queryByRole('button', { name: 'Rename' })
    ).not.toBeInTheDocument()
  })

  it('offers no menu at all on a connected-only row', () => {
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        onSelectOrganization={vi.fn()}
        navigate={vi.fn()}
        actionLabel="Switch"
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
      />
    )
    expect(
      screen.queryByRole('button', { name: 'Actions for "Connected Org"' })
    ).not.toBeInTheDocument()
  })

  it('rename dispatches the typed name and re-reads the account afterward', async () => {
    renameOrganization.mockResolvedValue({ id: 'org-1', name: 'New Name' })
    const refreshAccount = vi.fn().mockResolvedValue(undefined)
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        onSelectOrganization={vi.fn()}
        navigate={vi.fn()}
        actionLabel="Switch"
        refreshAccount={refreshAccount}
      />
    )
    openMenu('Owned Org')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Owned Org"' })
      ).getByRole('button', { name: 'Rename' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Organization name'), {
      target: { value: 'New Name' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))

    await waitFor(() =>
      expect(renameOrganization).toHaveBeenCalledWith('org-1', 'New Name')
    )
    await waitFor(() => expect(refreshAccount).toHaveBeenCalledTimes(1))
  })

  it('refuses a blank or whitespace-only name in the dialog, without dispatching', async () => {
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        onSelectOrganization={vi.fn()}
        navigate={vi.fn()}
        actionLabel="Switch"
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
      />
    )
    openMenu('Owned Org')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Owned Org"' })
      ).getByRole('button', { name: 'Rename' })
    )
    const dialog = await screen.findByRole('dialog')
    const field = within(dialog).getByLabelText('Organization name')
    const confirmButton = within(dialog).getByRole('button', {
      name: 'Rename',
    })
    fireEvent.change(field, { target: { value: '   ' } })
    expect(confirmButton).toBeDisabled()
    expect(renameOrganization).not.toHaveBeenCalled()
  })

  it('leave confirms first, naming the organization, and dispatches only once confirmed', async () => {
    leaveOrganization.mockResolvedValue({ left: true })
    const refreshAccount = vi.fn().mockResolvedValue(undefined)
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        onSelectOrganization={vi.fn()}
        navigate={vi.fn()}
        actionLabel="Switch"
        refreshAccount={refreshAccount}
      />
    )
    openMenu('Member Org')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Member Org"' })
      ).getByRole('button', { name: 'Leave' })
    )
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Member Org')

    // Cancelling leaves nothing dispatched.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(leaveOrganization).not.toHaveBeenCalled()

    openMenu('Member Org')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Member Org"' })
      ).getByRole('button', { name: 'Leave' })
    )
    const secondDialog = await screen.findByRole('dialog')
    fireEvent.click(within(secondDialog).getByRole('button', { name: 'Leave' }))

    await waitFor(() => expect(leaveOrganization).toHaveBeenCalledWith('org-2'))
    await waitFor(() => expect(refreshAccount).toHaveBeenCalledTimes(1))
  })

  it('leaving the active organization refreshes, then navigates to another organization this account can still act in', async () => {
    leaveOrganization.mockResolvedValue({ left: true })
    let resolveRefresh: () => void = () => undefined
    const refreshAccount = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve
        })
    )
    const navigate = vi.fn()
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        activeOrganizationId="org-2"
        onSelectOrganization={vi.fn()}
        navigate={navigate}
        actionLabel="Switch"
        refreshAccount={refreshAccount}
      />
    )
    openMenu('Member Org')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Member Org"' })
      ).getByRole('button', { name: 'Leave' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave' }))

    await waitFor(() => expect(leaveOrganization).toHaveBeenCalledWith('org-2'))
    // Navigation waits for the refresh to resolve — not fired the instant
    // the leave itself settles.
    expect(navigate).not.toHaveBeenCalled()
    resolveRefresh()
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        kind: 'projects',
        organizationId: 'org-1',
      })
    )
  })

  it('a failed leave is reported and nothing navigates', async () => {
    leaveOrganization.mockRejectedValue(
      new ApiError(403, { error: 'not_authorized' })
    )
    const navigate = vi.fn()
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        activeOrganizationId="org-2"
        onSelectOrganization={vi.fn()}
        navigate={navigate}
        actionLabel="Switch"
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
      />
    )
    openMenu('Member Org')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Member Org"' })
      ).getByRole('button', { name: 'Leave' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })
})
