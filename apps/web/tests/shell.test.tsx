/**
 * `pages/Shell.tsx` (WEB-3, WEB-4): which organization the panel is acting
 * in, and that the actively selected organization — not merely whichever one
 * the component happened to mount with — is what every subsequent request
 * carries. Before this file existed there was no test at all for `Shell.tsx`
 * (finding 2 of the WEB-1..6 rework): WEB-3's central claim went untested,
 * and `tests/organization-switcher.test.tsx` explicitly defers "what active
 * means" to this component.
 */

import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { AccountSummary, Project } from '../src/api/types.js'
import { Shell } from '../src/pages/Shell.js'
import { renderWithModal } from './helpers/render-with-modal.js'

// `listProjects`/`listCourses` are mocked here too, not just
// `dispatchAction` — finding 10 of the WEB-7 rework changed `activeTab`'s
// default to 'projects' (this module's own comment, `docs/DECISIONS.md`
// D-25), so `ProjectsPanel` (and, once a project is opened, `Courses`) now
// mounts on every one of this file's tests, not only the ones that opt into
// the Projects tab.
const {
  beginDiscordInstall,
  dispatchAction,
  signOut,
  listProjects,
  listCourses,
} = vi.hoisted(() => ({
  beginDiscordInstall: vi.fn(),
  dispatchAction: vi.fn(),
  signOut: vi.fn(),
  listProjects: vi.fn(),
  listCourses: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    beginDiscordInstall,
    dispatchAction,
    signOut,
    listProjects,
    listCourses,
  }
})

const MULTI_MEMBERSHIP_ACCOUNT: AccountSummary = {
  id: 'account-1',
  memberships: [
    { organizationId: 'org-1', organizationName: 'Org One', role: 'owner' },
    {
      organizationId: 'org-2',
      organizationName: 'Org Two',
      role: 'assistant',
    },
  ],
}

beforeEach(() => {
  // The default `ProjectsPanel` mount on every test (finding 10's new
  // 'projects' default) needs *some* resolved value, or `Projects.tsx`'s
  // own `.then` on an unmocked `vi.fn()`'s `undefined` return throws.
  // Individual tests override this where the response matters.
  listProjects.mockResolvedValue([])
  listCourses.mockResolvedValue([])
})

afterEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
})

describe('Shell (WEB-3, WEB-4)', () => {
  it('with no install just completed, defaults to the first membership', () => {
    renderWithModal(
      <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />
    )
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue(
      'org-1'
    )
  })

  it('an install that just completed for a *different* organization than the first membership opens the panel on that organization, not the first one (finding 2 of the WEB-1..6 rework)', () => {
    renderWithModal(
      <Shell
        account={MULTI_MEMBERSHIP_ACCOUNT}
        justInstalled={{ organizationId: 'org-2', serverId: 'guild-42' }}
        onSignedOut={vi.fn()}
      />
    )
    // The switcher shows the organization the install actually bound —
    // before this fix it stayed on org-1 (memberships[0]) while the API had
    // bound the server to org-2.
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue(
      'org-2'
    )
    // And the installed banner is visible on first render of the Discord
    // tab, not only after a manual switch — `installedServerId` only
    // matches when `activeOrganizationId` equals
    // `justInstalled.organizationId`. (The Discord tab itself is not the
    // default one anymore — finding 10 — so this test opens it explicitly.)
    fireEvent.click(screen.getByRole('button', { name: 'Discord' }))
    expect(screen.getByText(/guild-42/)).toBeInTheDocument()
  })

  it('a justInstalled organization the account is not actually a member of is ignored, defensively, in favour of the first membership', () => {
    renderWithModal(
      <Shell
        account={MULTI_MEMBERSHIP_ACCOUNT}
        justInstalled={{ organizationId: 'org-9', serverId: 'guild-42' }}
        onSignedOut={vi.fn()}
      />
    )
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue(
      'org-1'
    )
  })

  it('carries the actively selected organization into every request, not the one Shell mounted with (WEB-3)', async () => {
    beginDiscordInstall.mockResolvedValue({
      authorizationUrl: 'https://discord.test/oauth2/authorize?state=abc',
      expiresAt: Date.now() + 60_000,
    })
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign },
      writable: true,
    })

    renderWithModal(
      <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Discord' }))

    // Switch away from the organization this mounted with...
    fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
      target: { value: 'org-2' },
    })
    // ...and begin an install. If Shell carried the *initial* organization
    // into this request instead of the actively selected one, this would
    // call beginDiscordInstall with 'org-1' — exactly the class of bug
    // WEB-3 exists to rule out ("cannot act in one while believing they are
    // in the other").
    fireEvent.click(screen.getByRole('button', { name: 'Install to Discord' }))

    await vi.waitFor(() =>
      expect(beginDiscordInstall).toHaveBeenCalledWith('org-2')
    )
  })

  it('removing an installed server dispatches against the actively selected organization', async () => {
    dispatchAction.mockResolvedValue({ result: undefined })

    renderWithModal(
      <Shell
        account={MULTI_MEMBERSHIP_ACCOUNT}
        justInstalled={{ organizationId: 'org-2', serverId: 'guild-42' }}
        onSignedOut={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Discord' }))

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    // WEB-15: destructive, so it confirms first (`components/modal/`).
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await vi.waitFor(() =>
      expect(dispatchAction).toHaveBeenCalledWith(
        'org-2',
        'discordServers.remove',
        { serverId: 'guild-42' }
      )
    )
    // The banner clears once the remove succeeds.
    expect(
      await screen.findByRole('button', { name: 'Install to Discord' })
    ).toBeInTheDocument()
  })

  it('a sign-out that fails to round-trip still signs the caller out of this screen, without an unhandled rejection', async () => {
    signOut.mockRejectedValue(new ApiError(0, { error: 'network_error' }))
    const onSignedOut = vi.fn()

    renderWithModal(
      <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={onSignedOut} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    // If `handleSignOut`'s `try/finally` had no `catch` (finding 3 of the
    // WEB-1..6 rework), the rejection from `signOut()` would propagate past
    // `finally` with nowhere to land — Vitest reports that as a test
    // failure in its own right, on top of this assertion.
    await vi.waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1))
  })

  it('switching organizations resets the projects panel rather than stranding it on a refusal from the previous organization (finding 5)', async () => {
    const projectOrg1: Project = {
      id: 'project-1',
      organizationId: 'org-1',
      name: 'Fall 2026',
      archivedAt: null,
      createdAt: 0,
    }
    listProjects.mockImplementation((organizationId: string) =>
      Promise.resolve(organizationId === 'org-1' ? [projectOrg1] : [])
    )
    // `courses.list` refuses — the same shape a cross-tenant project id gets
    // (TEN-2/TEN-5) — standing in for what happens if a project selected in
    // org-1 were still selected once org-2 became active.
    listCourses.mockRejectedValue(
      new ApiError(404, { error: 'action_refused' })
    )

    renderWithModal(
      <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />
    )

    await screen.findByText('Fall 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Fall 2026' }))
    await screen.findByRole('alert')

    // Switch organizations. Without `key={activeOrganizationId}` on
    // `ProjectsPanel` (`pages/Shell.tsx`), this refusal — and the project it
    // belonged to — would still be showing, unclearable short of a reload.
    fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
      target: { value: 'org-2' },
    })

    await waitFor(() =>
      expect(listProjects).toHaveBeenCalledWith('org-2', false)
    )
    // Back on the projects list for the newly active organization, not
    // stuck on the previous organization's stranded refusal.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText('New project name')).toBeInTheDocument()
  })
})
