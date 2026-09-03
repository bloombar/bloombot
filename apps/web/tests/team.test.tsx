/**
 * `components/Team.tsx` (ENRL-5): an owner's own staff roster, and granting
 * a role to a second instructor or a teaching assistant. Every case below is
 * what that component's own module comment promises: an owner-only grant
 * form, the consequence stated at the moment of granting, and never a
 * holder's email shown in the list.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { OrganizationMembership } from '../src/api/types.js'
import { Team } from '../src/components/Team.js'
import { renderWithModal } from './helpers/render-with-modal.js'

// ENRL-10: `Team` now mounts `MembershipInvitations` (owner-gated,
// alongside the grant form) — that component's own `listMembershipInvitations`
// is mocked here too, defaulted to an empty list in `beforeEach` below, so
// every existing case in this file keeps exercising the grant form alone
// without a stray, unmocked network call from the invitations section
// landing its own "Could not reach Bloombot" alert alongside whatever this
// file's own assertions are actually checking.
const {
  listMemberships,
  grantMembership,
  listMembershipInvitations,
  createMembershipInvitation,
  revokeMembershipInvitation,
} = vi.hoisted(() => ({
  listMemberships: vi.fn(),
  grantMembership: vi.fn(),
  listMembershipInvitations: vi.fn(),
  createMembershipInvitation: vi.fn(),
  revokeMembershipInvitation: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    listMemberships,
    grantMembership,
    listMembershipInvitations,
    createMembershipInvitation,
    revokeMembershipInvitation,
  }
})

function entry(
  overrides: Partial<OrganizationMembership> = {}
): OrganizationMembership {
  return {
    accountId: 'account-1',
    displayName: 'Owner Ora',
    role: 'owner',
    grantedByAccountId: null,
    grantedByDisplayName: null,
    grantedAt: null,
    createdAt: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  listMembershipInvitations.mockResolvedValue([])
})

afterEach(() => {
  vi.resetAllMocks()
})

describe('Team (ENRL-5)', () => {
  it('shows the empty state when nobody holds a role yet', async () => {
    listMemberships.mockResolvedValue([])

    renderWithModal(<Team organizationId="org-1" isOwner={true} />)

    expect(
      await screen.findByText('Nobody holds a role in this organization yet.')
    ).toBeInTheDocument()
  })

  it('lists each holder with their role and who granted it', async () => {
    listMemberships.mockResolvedValue([
      entry({
        accountId: 'a1',
        displayName: 'TA Tam',
        role: 'instructor',
        grantedByAccountId: 'a0',
        grantedByDisplayName: 'Owner Ora',
        grantedAt: Date.UTC(2026, 0, 1),
      }),
    ])

    renderWithModal(<Team organizationId="org-1" isOwner={true} />)

    expect(await screen.findByText(/TA Tam — Instructor/)).toBeInTheDocument()
    expect(screen.getByText(/Granted by Owner Ora/)).toBeInTheDocument()
  })

  // ENRL-5/`schema.ts`'s own comment: the founding owner row records no
  // grantor — this must read distinctly from a row that was actually
  // granted, not print "Granted by null" or similar.
  it('shows "Member since", not a grantor, for the one membership nobody grants', async () => {
    listMemberships.mockResolvedValue([
      entry({ grantedByAccountId: null, grantedByDisplayName: null }),
    ])

    renderWithModal(<Team organizationId="org-1" isOwner={true} />)

    expect(await screen.findByText(/Owner Ora — Owner/)).toBeInTheDocument()
    expect(screen.getByText(/Member since/)).toBeInTheDocument()
    expect(screen.queryByText(/Granted by/)).not.toBeInTheDocument()
  })

  // WEB-22/COST-4's own "no genuine need to disambiguate by it" precedent,
  // applied here: this component's props never even carry an email for a
  // listed row, so there is nothing to leak — proven by asserting the one
  // thing that *is* rendered never includes an `@`.
  it('never shows an email in the list', async () => {
    listMemberships.mockResolvedValue([
      entry({ displayName: 'Owner Ora', role: 'owner' }),
    ])

    renderWithModal(<Team organizationId="org-1" isOwner={true} />)

    const row = await screen.findByText(/Owner Ora — Owner/)
    expect(row.closest('li')).not.toHaveTextContent('@')
  })

  it('withholds the grant form for a caller who is not an owner', async () => {
    listMemberships.mockResolvedValue([entry()])

    renderWithModal(<Team organizationId="org-1" isOwner={false} />)

    await screen.findByText(/Owner Ora — Owner/)
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Grant role' })
    ).not.toBeInTheDocument()
  })

  it('an owner grants a role: the consequence is confirmed before anything is sent', async () => {
    listMemberships.mockResolvedValue([entry()])
    grantMembership.mockResolvedValue({
      organizationId: 'org-1',
      accountId: 'a1',
      role: 'instructor',
      grantedByAccountId: 'a0',
      grantedAt: Date.now(),
      createdAt: Date.now(),
    })

    renderWithModal(<Team organizationId="org-1" isOwner={true} />)
    await screen.findByText(/Owner Ora — Owner/)

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'ta@example.edu' },
    })
    fireEvent.change(screen.getByLabelText('Role'), {
      target: { value: 'instructor' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Grant role' }))

    const dialog = await screen.findByRole('dialog', {
      name: 'Grant ta@example.edu the Instructor role?',
    })
    expect(dialog).toHaveTextContent(
      'can read every course transcript and chat history'
    )
    expect(grantMembership).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant role' }))

    await waitFor(() =>
      expect(grantMembership).toHaveBeenCalledWith(
        'org-1',
        'ta@example.edu',
        'instructor'
      )
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Granted ta@example.edu the Instructor role.'
    )
  })

  it('cancelling the confirmation calls grantMembership with nothing', async () => {
    listMemberships.mockResolvedValue([entry()])

    renderWithModal(<Team organizationId="org-1" isOwner={true} />)
    await screen.findByText(/Owner Ora — Owner/)

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'ta@example.edu' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Grant role' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(grantMembership).not.toHaveBeenCalled()
  })

  it('a refused grant renders the same ErrorMessage every other refusal in this app uses', async () => {
    listMemberships.mockResolvedValue([entry()])
    grantMembership.mockRejectedValue(
      new ApiError(404, { error: 'action_refused' })
    )

    renderWithModal(<Team organizationId="org-1" isOwner={true} />)
    await screen.findByText(/Owner Ora — Owner/)

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'ta@example.edu' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Grant role' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant role' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })

  it('a failed load renders the same ErrorMessage, not the roster', async () => {
    listMemberships.mockRejectedValue(
      new ApiError(500, { error: 'internal_error' })
    )

    renderWithModal(<Team organizationId="org-1" isOwner={true} />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Try again.'
    )
    expect(screen.queryByText(/Grant a role/)).not.toBeInTheDocument()
  })
})
