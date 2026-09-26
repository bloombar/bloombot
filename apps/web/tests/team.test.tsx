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
  revokeMembership,
  listMembershipInvitations,
  createMembershipInvitation,
  revokeMembershipInvitation,
} = vi.hoisted(() => ({
  listMemberships: vi.fn(),
  grantMembership: vi.fn(),
  revokeMembership: vi.fn(),
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
    revokeMembership,
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

    renderWithModal(
      <Team organizationId="org-1" isOwner={true} viewerAccountId="viewer-1" />
    )

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

    renderWithModal(
      <Team organizationId="org-1" isOwner={true} viewerAccountId="viewer-1" />
    )

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

    renderWithModal(
      <Team organizationId="org-1" isOwner={true} viewerAccountId="viewer-1" />
    )

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

    renderWithModal(
      <Team organizationId="org-1" isOwner={true} viewerAccountId="viewer-1" />
    )

    const row = await screen.findByText(/Owner Ora — Owner/)
    expect(row.closest('li')).not.toHaveTextContent('@')
  })

  it('withholds the grant form for a caller who is not an owner', async () => {
    listMemberships.mockResolvedValue([entry()])

    renderWithModal(
      <Team organizationId="org-1" isOwner={false} viewerAccountId="viewer-1" />
    )

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

    renderWithModal(
      <Team organizationId="org-1" isOwner={true} viewerAccountId="viewer-1" />
    )
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

    renderWithModal(
      <Team organizationId="org-1" isOwner={true} viewerAccountId="viewer-1" />
    )
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

    renderWithModal(
      <Team organizationId="org-1" isOwner={true} viewerAccountId="viewer-1" />
    )
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

    renderWithModal(
      <Team organizationId="org-1" isOwner={true} viewerAccountId="viewer-1" />
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Try again.'
    )
    expect(screen.queryByText(/Grant a role/)).not.toBeInTheDocument()
  })
})

// ENRL-11: revoking. `entry()`'s own default row is `'owner'`,
// `accountId: 'account-1'` — every case below is explicit about which row
// belongs to the viewer and which does not, since that is exactly the
// distinction this component's own module comment says decides what
// control, if any, a row offers.
describe('Team (ENRL-11)', () => {
  it('offers Revoke on a non-owner row to any owner viewer, and it confirms both halves before sending', async () => {
    listMemberships.mockResolvedValue([
      entry({ accountId: 'a1', displayName: 'TA Tam', role: 'instructor' }),
    ])
    revokeMembership.mockResolvedValue({ revoked: true })

    renderWithModal(
      <Team organizationId="org-1" isOwner={true} viewerAccountId="viewer-1" />
    )
    await screen.findByText(/TA Tam — Instructor/)

    fireEvent.click(
      screen.getByRole('button', {
        name: "Revoke TA Tam's Instructor role",
      })
    )

    const dialog = await screen.findByRole('dialog', {
      name: "Revoke TA Tam's Instructor role?",
    })
    expect(dialog).toHaveTextContent('stops their staff access')
    expect(dialog).toHaveTextContent(
      'deletes no transcript and ends no enrolment'
    )
    expect(revokeMembership).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }))

    await waitFor(() =>
      expect(revokeMembership).toHaveBeenCalledWith('org-1', 'a1')
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      "Revoked TA Tam's role."
    )
  })

  it('withholds every revoke control for a caller who is not an owner', async () => {
    listMemberships.mockResolvedValue([
      entry({ accountId: 'a1', displayName: 'TA Tam', role: 'instructor' }),
    ])

    renderWithModal(
      <Team organizationId="org-1" isOwner={false} viewerAccountId="viewer-1" />
    )

    await screen.findByText(/TA Tam — Instructor/)
    expect(
      screen.queryByRole('button', { name: /Revoke/ })
    ).not.toBeInTheDocument()
  })

  // ENRL-11's own decision: a peer owner's row carries no control at
  // all — the server would refuse every attempt identically, so this
  // component never offers one to begin with (this file's own module
  // comment).
  it("withholds the revoke control on a peer owner's row", async () => {
    listMemberships.mockResolvedValue([
      entry({ accountId: 'viewer-1', displayName: 'Viewer', role: 'owner' }),
      entry({ accountId: 'peer-1', displayName: 'Peer Owner', role: 'owner' }),
    ])

    renderWithModal(
      <Team organizationId="org-1" isOwner={true} viewerAccountId="viewer-1" />
    )

    await screen.findByText(/Peer Owner — Owner/)
    expect(
      screen.queryByRole('button', { name: /Peer Owner/ })
    ).not.toBeInTheDocument()
  })

  it("offers Step down on the viewer's own owner row when another owner exists", async () => {
    listMemberships.mockResolvedValue([
      entry({ accountId: 'viewer-1', displayName: 'Viewer', role: 'owner' }),
      entry({ accountId: 'peer-1', displayName: 'Peer Owner', role: 'owner' }),
    ])
    revokeMembership.mockResolvedValue({ revoked: true })

    renderWithModal(
      <Team organizationId="org-1" isOwner={true} viewerAccountId="viewer-1" />
    )
    await screen.findByText(/Viewer — Owner/)

    const stepDown = screen.getByRole('button', { name: 'Step down as Owner' })
    expect(stepDown).toBeEnabled()
    fireEvent.click(stepDown)

    const dialog = await screen.findByRole('dialog', {
      name: 'Step down as Owner?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Step down' }))

    await waitFor(() =>
      expect(revokeMembership).toHaveBeenCalledWith('org-1', 'viewer-1')
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'You have stepped down.'
    )
  })

  // The last-owner rule is enforced below this screen (`repos/memberships.ts#revokeMembership`,
  // driven directly in that package's own tests) — this only proves the
  // screen explains rather than merely hides, the same "absent or plainly
  // disabled with the reason given" instruction this file's own module
  // comment already states.
  it("disables the viewer's own Step down when they are the organization's only owner, with the reason given", async () => {
    listMemberships.mockResolvedValue([
      entry({ accountId: 'viewer-1', displayName: 'Viewer', role: 'owner' }),
    ])

    renderWithModal(
      <Team organizationId="org-1" isOwner={true} viewerAccountId="viewer-1" />
    )
    await screen.findByText(/Viewer — Owner/)

    const stepDown = screen.getByRole('button', { name: 'Step down as Owner' })
    expect(stepDown).toBeDisabled()
    expect(
      screen.getByText(/You are this organization.s only owner/)
    ).toBeInTheDocument()
  })

  it('cancelling the revoke confirmation calls revokeMembership with nothing', async () => {
    listMemberships.mockResolvedValue([
      entry({ accountId: 'a1', displayName: 'TA Tam', role: 'instructor' }),
    ])

    renderWithModal(
      <Team organizationId="org-1" isOwner={true} viewerAccountId="viewer-1" />
    )
    await screen.findByText(/TA Tam — Instructor/)

    fireEvent.click(
      screen.getByRole('button', { name: "Revoke TA Tam's Instructor role" })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(revokeMembership).not.toHaveBeenCalled()
  })

  it('a refused revoke renders the same ErrorMessage every other refusal in this app uses', async () => {
    listMemberships.mockResolvedValue([
      entry({ accountId: 'a1', displayName: 'TA Tam', role: 'instructor' }),
    ])
    revokeMembership.mockRejectedValue(
      new ApiError(404, { error: 'action_refused' })
    )

    renderWithModal(
      <Team organizationId="org-1" isOwner={true} viewerAccountId="viewer-1" />
    )
    await screen.findByText(/TA Tam — Instructor/)

    fireEvent.click(
      screen.getByRole('button', { name: "Revoke TA Tam's Instructor role" })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })
})

// WEB-69: `pages/OrganizationSettings.tsx`'s own per-tab dirty tracking
// reads this screen's own `onDirtyChange`/`onRegisterActions` — folding in
// the nested `MembershipInvitations`' own identical pair (this file's own
// module comment on why both halves fold into one flag).
describe('Team — per-tab dirty tracking (WEB-69)', () => {
  it('reports dirty once the grant email is non-blank, and clean once it is cleared', async () => {
    listMemberships.mockResolvedValue([])
    const onDirtyChange = vi.fn()

    renderWithModal(
      <Team
        organizationId="org-1"
        isOwner={true}
        viewerAccountId="viewer-1"
        onDirtyChange={onDirtyChange}
      />
    )
    await screen.findByText('Nobody holds a role in this organization yet.')
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'new@example.edu' },
    })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: '' } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('reports dirty when the nested invitation form alone holds a pending, non-blank email', async () => {
    listMemberships.mockResolvedValue([])
    const onDirtyChange = vi.fn()

    renderWithModal(
      <Team
        organizationId="org-1"
        isOwner={true}
        viewerAccountId="viewer-1"
        onDirtyChange={onDirtyChange}
      />
    )
    await screen.findByText('Nobody holds a role in this organization yet.')
    onDirtyChange.mockClear()

    fireEvent.change(screen.getByLabelText('Invite email'), {
      target: { value: 'colleague@example.edu' },
    })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    // The grant form's own email is untouched — dirtiness came from the
    // nested invitation form alone.
    expect(screen.getByLabelText('Email')).toHaveValue('')
  })

  // Rework round 2, must-fix 3: a failed member-list refresh swaps in the
  // `ErrorMessage` branch (below `loadError`), which unmounts the nested
  // `MembershipInvitations` outright. Before the fix, that form's own
  // `onDirtyChange` effect never ran again to say "not dirty" — it only
  // ever fires on a change to its own `isDirty`, never on unmount — so
  // `Team.tsx`'s own `invitationsDirty` flag was stuck `true` for the rest
  // of the session, and a leave-guard kept asking about an edit nobody
  // could reach or discard any more.
  it('clears the invitations dirty flag once a failed refresh unmounts that form', async () => {
    listMemberships
      .mockResolvedValueOnce([entry()])
      .mockRejectedValueOnce(new ApiError(500, { error: 'internal_error' }))
    grantMembership.mockResolvedValue({
      organizationId: 'org-1',
      accountId: 'a1',
      role: 'instructor',
      grantedByAccountId: 'a0',
      grantedAt: Date.now(),
      createdAt: Date.now(),
    })
    const onDirtyChange = vi.fn()

    renderWithModal(
      <Team
        organizationId="org-1"
        isOwner={true}
        viewerAccountId="viewer-1"
        onDirtyChange={onDirtyChange}
      />
    )
    await screen.findByText(/Owner Ora — Owner/)

    // Dirty the nested invitation form, not the grant form.
    fireEvent.change(screen.getByLabelText('Invite email'), {
      target: { value: 'colleague@example.edu' },
    })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)

    // A successful grant triggers this file's own `refresh()`, which
    // rejects this time — the same early return `team.test.tsx`'s own "a
    // failed load renders the same ErrorMessage" case exercises, reached
    // here from a refresh rather than the initial mount.
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'ta@example.edu' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Grant role' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Grant ta@example.edu the Instructor role?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant role' }))

    await screen.findByRole('alert')
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false))
  })

  it("registered actions' discard resets both the grant form and the nested invitation form", async () => {
    listMemberships.mockResolvedValue([])
    let actions:
      import('../src/hooks/tabDirtyActions.js').TabDirtyActions | null = null

    renderWithModal(
      <Team
        organizationId="org-1"
        isOwner={true}
        viewerAccountId="viewer-1"
        onRegisterActions={(registered) => {
          actions = registered
        }}
      />
    )
    await screen.findByText('Nobody holds a role in this organization yet.')

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'new@example.edu' },
    })
    fireEvent.change(screen.getByLabelText('Invite email'), {
      target: { value: 'colleague@example.edu' },
    })

    expect(actions).not.toBeNull()
    actions!.discard()
    await waitFor(() => {
      expect(screen.getByLabelText('Email')).toHaveValue('')
      expect(screen.getByLabelText('Invite email')).toHaveValue('')
    })
  })
})
