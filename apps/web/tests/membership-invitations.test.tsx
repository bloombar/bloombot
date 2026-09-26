/**
 * `components/MembershipInvitations.tsx` (ENRL-10): the screen an owner uses
 * to invite a colleague who is not yet in the organization. Every case
 * below is what that component's own module comment promises: a created
 * secret shown exactly once with a copy control, a list that never repeats
 * it, and a revoke that confirms first — the same shape
 * `join-links.test.tsx` already proves for `JoinLinks.tsx`, this
 * component's own precedent.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { MembershipInvitation } from '../src/api/types.js'
import { MembershipInvitations } from '../src/components/MembershipInvitations.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const {
  createMembershipInvitation,
  listMembershipInvitations,
  revokeMembershipInvitation,
} = vi.hoisted(() => ({
  createMembershipInvitation: vi.fn(),
  listMembershipInvitations: vi.fn(),
  revokeMembershipInvitation: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    createMembershipInvitation,
    listMembershipInvitations,
    revokeMembershipInvitation,
  }
})

function invitation(
  overrides: Partial<MembershipInvitation> = {}
): MembershipInvitation {
  return {
    id: 'invitation-1',
    email: 'colleague@example.edu',
    role: 'instructor',
    expiresAt: null,
    revokedAt: null,
    redeemedAt: null,
    createdByAccountId: 'account-1',
    createdAt: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  // jsdom carries no `navigator.clipboard` by default — stubbed here so
  // `handleCopy` has something real to call, the same
  // `join-links.test.tsx`'s own `beforeEach` device.
  Object.assign(navigator, { clipboard: { writeText: vi.fn() } })
})

afterEach(() => {
  vi.resetAllMocks()
})

describe('MembershipInvitations (ENRL-10)', () => {
  it('shows the empty state when no invitations have been issued', async () => {
    listMembershipInvitations.mockResolvedValue([])

    renderWithModal(<MembershipInvitations organizationId="org-1" />)

    expect(
      await screen.findByText('No invitations issued yet.')
    ).toBeInTheDocument()
  })

  it('lists each invitation with its email, role and status', async () => {
    listMembershipInvitations.mockResolvedValue([
      invitation({ id: 'i1', email: 'a@example.edu', role: 'instructor' }),
      invitation({ id: 'i2', email: 'b@example.edu', role: 'assistant' }),
    ])

    renderWithModal(<MembershipInvitations organizationId="org-1" />)

    expect(
      await screen.findByText(/a@example.edu — Instructor/)
    ).toBeInTheDocument()
    expect(screen.getByText(/b@example.edu — Assistant/)).toBeInTheDocument()
  })

  // ENRL-10's own single-use property, read on this screen: a redeemed
  // invitation shows as redeemed regardless of what `revokedAt`/`expiresAt`
  // happen to hold — the same "check status in priority order" discipline
  // `JoinLinks.tsx#formatExpiry`/D-63 already hold for revoked-over-expired.
  it('a redeemed invitation reads as redeemed, and offers no revoke control', async () => {
    listMembershipInvitations.mockResolvedValue([
      invitation({ redeemedAt: Date.now() }),
    ])

    renderWithModal(<MembershipInvitations organizationId="org-1" />)

    expect(await screen.findByText(/^Redeemed /)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^Revoke invitation/ })
    ).not.toBeInTheDocument()
  })

  it('creating shows the secret exactly once, with a control that copies it — the list never repeats it', async () => {
    listMembershipInvitations
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([invitation({ id: 'i1' })])
    createMembershipInvitation.mockResolvedValue({
      invitationId: 'i1',
      secret: 'the-secret-value',
      expiresAt: null,
    })

    renderWithModal(<MembershipInvitations organizationId="org-1" />)
    await screen.findByText('No invitations issued yet.')

    fireEvent.change(screen.getByLabelText('Invite email'), {
      target: { value: 'colleague@example.edu' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))

    const dialog = await screen.findByRole('dialog', {
      name: 'Invite colleague@example.edu to the Instructor role?',
    })
    expect(createMembershipInvitation).not.toHaveBeenCalled()
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Send invitation' })
    )

    await waitFor(() =>
      expect(createMembershipInvitation).toHaveBeenCalledWith(
        'org-1',
        'colleague@example.edu',
        'instructor'
      )
    )
    const urlNode = await screen.findByTestId('created-invitation-url')
    expect(urlNode).toHaveTextContent('/invitations/the-secret-value')
    expect(screen.getByText(/shown only this once/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('/invitations/the-secret-value')
      )
    )

    const list = await screen.findByRole('list')
    expect(within(list).queryByText(/the-secret-value/)).not.toBeInTheDocument()
  })

  it('a fresh mount never shows a secret, even for an invitation this session already created', async () => {
    listMembershipInvitations.mockResolvedValue([invitation({ id: 'i1' })])

    renderWithModal(<MembershipInvitations organizationId="org-1" />)

    await screen.findByText(/colleague@example.edu — Instructor/)
    expect(
      screen.queryByTestId('created-invitation-url')
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/shown only this once/)).not.toBeInTheDocument()
  })

  it('revoking confirms first — cancelling calls nothing', async () => {
    listMembershipInvitations.mockResolvedValue([invitation({ id: 'i1' })])

    renderWithModal(<MembershipInvitations organizationId="org-1" />)
    await screen.findByText(/colleague@example.edu — Instructor/)

    fireEvent.click(screen.getByRole('button', { name: /^Revoke invitation/ }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Revoke this invitation?',
    })
    expect(dialog).toHaveTextContent('stops it admitting anyone, ever again')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(revokeMembershipInvitation).not.toHaveBeenCalled()
  })

  it('revoking, confirmed, dispatches the action and the invitation reads as revoked', async () => {
    listMembershipInvitations
      .mockResolvedValueOnce([invitation({ id: 'i1', revokedAt: null })])
      .mockResolvedValue([invitation({ id: 'i1', revokedAt: Date.now() })])
    revokeMembershipInvitation.mockResolvedValue({ revoked: true })

    renderWithModal(<MembershipInvitations organizationId="org-1" />)
    await screen.findByText(/colleague@example.edu — Instructor/)

    fireEvent.click(screen.getByRole('button', { name: /^Revoke invitation/ }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Revoke this invitation?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }))

    await waitFor(() =>
      expect(revokeMembershipInvitation).toHaveBeenCalledWith('org-1', 'i1')
    )
    expect(await screen.findByText(/^Revoked /)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^Revoke invitation/ })
    ).not.toBeInTheDocument()
  })

  it('a clipboard that cannot be reached is reported, and the URL stays visible to copy by hand', async () => {
    listMembershipInvitations.mockResolvedValue([])
    createMembershipInvitation.mockResolvedValue({
      invitationId: 'i1',
      secret: 'the-secret-value',
      expiresAt: null,
    })
    Object.assign(navigator, { clipboard: undefined })

    renderWithModal(<MembershipInvitations organizationId="org-1" />)
    await screen.findByText('No invitations issued yet.')

    fireEvent.change(screen.getByLabelText('Invite email'), {
      target: { value: 'colleague@example.edu' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Send invitation' })
    )
    await screen.findByTestId('created-invitation-url')

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not copy the link — copy it from the text above by hand.'
    )
    expect(screen.getByTestId('created-invitation-url')).toHaveTextContent(
      '/invitations/the-secret-value'
    )
  })

  it('a refused invite renders the same ErrorMessage every other refusal in this app uses', async () => {
    listMembershipInvitations.mockResolvedValue([])
    createMembershipInvitation.mockRejectedValue(
      new ApiError(404, { error: 'action_refused' })
    )

    renderWithModal(<MembershipInvitations organizationId="org-1" />)
    await screen.findByText('No invitations issued yet.')

    fireEvent.change(screen.getByLabelText('Invite email'), {
      target: { value: 'colleague@example.edu' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Send invitation' })
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })
})

// WEB-69: `components/Team.tsx`'s own per-tab dirty tracking folds this
// form's `onDirtyChange`/`onRegisterActions` into its one flag — this file
// proves the pair this component itself exposes, the same shape
// `pages/Usage.tsx`'s own tests already prove for that screen.
describe('MembershipInvitations — per-tab dirty tracking (WEB-69)', () => {
  it('reports dirty once the invite email is non-blank, and clean once it is cleared', async () => {
    listMembershipInvitations.mockResolvedValue([])
    const onDirtyChange = vi.fn()

    renderWithModal(
      <MembershipInvitations
        organizationId="org-1"
        onDirtyChange={onDirtyChange}
      />
    )
    await screen.findByText('No invitations issued yet.')
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)

    fireEvent.change(screen.getByLabelText('Invite email'), {
      target: { value: 'colleague@example.edu' },
    })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)

    fireEvent.change(screen.getByLabelText('Invite email'), {
      target: { value: '' },
    })
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('registered actions save the pending invite (its own confirmation included) and discard clears the field', async () => {
    listMembershipInvitations.mockResolvedValue([])
    createMembershipInvitation.mockResolvedValue({
      id: 'invitation-1',
      secret: 'secret-abc',
    })
    let actions:
      import('../src/hooks/tabDirtyActions.js').TabDirtyActions | null = null

    renderWithModal(
      <MembershipInvitations
        organizationId="org-1"
        onRegisterActions={(registered) => {
          actions = registered
        }}
      />
    )
    await screen.findByText('No invitations issued yet.')

    fireEvent.change(screen.getByLabelText('Invite email'), {
      target: { value: 'colleague@example.edu' },
    })
    expect(actions).not.toBeNull()

    const savePromise = actions!.save()
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Send invitation' })
    )
    await expect(savePromise).resolves.toBe(true)
    expect(createMembershipInvitation).toHaveBeenCalledWith(
      'org-1',
      'colleague@example.edu',
      'instructor'
    )

    fireEvent.change(screen.getByLabelText('Invite email'), {
      target: { value: 'someone-else@example.edu' },
    })
    actions!.discard()
    await waitFor(() =>
      expect(screen.getByLabelText('Invite email')).toHaveValue('')
    )
  })
})
