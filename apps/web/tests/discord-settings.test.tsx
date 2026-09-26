/**
 * `components/DiscordSettings.tsx` (TEN-8/WEB-4/TEN-9, WEB-69 rework
 * round 2): the Organization settings screen's own Discord tab, moved out
 * of `pages/Shell.tsx` — everything below is carried over from what used
 * to be `shell.test.tsx`'s own "reading the organization's actual Discord
 * binding," "multiple active Discord server bindings" and "TEN-8 rework:
 * coordinator review findings" describe blocks, rendering this component
 * directly rather than through the whole shell, the same move
 * `danger-zone.test.tsx` already made for `components/DangerZone.tsx` in
 * this slice's first round.
 *
 * Before this slice, `installedServerId` came from `justInstalled` alone —
 * set only once, by `App.tsx`, when a Discord OAuth callback completes in
 * *this* browser session. A reload, a second device, or an install from an
 * earlier session all left `justInstalled` `undefined`, so this tab
 * offered "Install" for a server that was already bound, and
 * `handleRemove`'s `if (!installedServerId) return` made Remove
 * unreachable for exactly the accounts who most need it. Every test below
 * renders with no `justInstalled` prop at all, unless stated otherwise —
 * the reload/second-device shape this gap actually broke.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { DiscordServerBindingSummary } from '../src/api/types.js'
import { DiscordSettings } from '../src/components/DiscordSettings.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const { dispatchAction, listDiscordServers } = vi.hoisted(() => ({
  dispatchAction: vi.fn(),
  listDiscordServers: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    dispatchAction,
    listDiscordServers,
  }
})

afterEach(() => {
  vi.resetAllMocks()
})

describe("reading the organization's actual Discord binding (TEN-8)", () => {
  const EXISTING_BINDING: DiscordServerBindingSummary = {
    serverId: 'guild-99',
    organizationId: 'org-1',
    // A different account than the one signed in — standing in for an
    // install from an earlier session, or a colleague's device, which is
    // exactly what `justInstalled` (this browser's own one-time signal)
    // cannot know about.
    installedByAccountId: 'account-other',
    installedAt: Date.now() - 86_400_000,
    removedAt: null,
    serverName: null,
  }

  it('a reload with an existing binding shows it as installed, with Remove offered — this is the defect', async () => {
    dispatchAction.mockResolvedValue({ result: undefined })
    listDiscordServers.mockResolvedValue([EXISTING_BINDING])

    renderWithModal(<DiscordSettings organizationId="org-1" />)

    // A fetched binding this session never created still renders as
    // installed. TEN-9 — installing another is offered too, now, alongside
    // an existing binding: an organization can bind more than one server,
    // so this is "install another," not a state this screen used to treat
    // as mutually exclusive with "already installed." WEB-68 — and it says
    // so: the label reads "Install to another Discord server" once one
    // already exists.
    expect(await screen.findByText(/guild-99/)).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Install to another Discord server',
      })
    ).toBeInTheDocument()

    // Remove is reachable for a binding this session did not create.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(dispatchAction).toHaveBeenCalledWith(
        'org-1',
        'discordServers.remove',
        { serverId: 'guild-99' }
      )
    )
    expect(
      await screen.findByRole('button', { name: 'Install to Discord' })
    ).toBeInTheDocument()
  })

  // WEB-68 — the name this file's own `listDiscordServers` mock returns
  // reaches the rendered row, not just the id.
  it('WEB-68: a binding carrying a stored name shows it in the row', async () => {
    listDiscordServers.mockResolvedValue([
      { ...EXISTING_BINDING, serverName: 'Study Hall' },
    ])

    renderWithModal(<DiscordSettings organizationId="org-1" />)

    expect(await screen.findByText('Study Hall')).toBeInTheDocument()
    expect(screen.getByText('guild-99')).toBeInTheDocument()
  })

  it('a lookup in flight does not render "Install"', async () => {
    // An unresolved promise — `listDiscordServers` never settles for the
    // life of this test — standing in for the round trip genuinely being
    // in flight.
    let settle: ((bindings: DiscordServerBindingSummary[]) => void) | undefined
    listDiscordServers.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )

    renderWithModal(<DiscordSettings organizationId="org-1" />)

    // An owner seeing "Install" for a server that is already bound is the
    // exact bug this fetch exists to fix — a momentary version of it,
    // while the lookup is still in flight, is still it.
    expect(
      screen.queryByRole('button', { name: 'Install to Discord' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')

    // Let the promise settle before this test ends, so cleanup does not
    // unmount a component with a still-pending state update.
    settle?.([])
    await screen.findByRole('button', { name: 'Install to Discord' })
  })

  it('a failed lookup reports the failure rather than rendering "not installed"', async () => {
    listDiscordServers.mockRejectedValue(
      new ApiError(500, { error: 'internal_error' })
    )

    renderWithModal(<DiscordSettings organizationId="org-1" />)

    // Rendering "Install" here would be the exact same bug this component
    // fixes, reached by a different path (a failed round trip standing in
    // for a stale one) — so a failure must say so, through the same
    // `ErrorMessage` path every other refusal in this app already uses,
    // not fall back to "not installed."
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Try again.'
    )
    expect(
      screen.queryByRole('button', { name: 'Install to Discord' })
    ).not.toBeInTheDocument()
  })

  it('the justInstalled fallback answers only for the organization it actually names', async () => {
    // Never resolves — standing in for the lookup still being in flight,
    // the one window `justInstalled` is ever consulted.
    listDiscordServers.mockImplementation(() => new Promise(() => {}))

    renderWithModal(
      <DiscordSettings
        organizationId="org-2"
        justInstalled={{ organizationId: 'org-1', serverId: 'guild-42' }}
      />
    )

    // `justInstalled` names a different organization — must not answer for
    // this one, which stays showing the loading state rather than a
    // fallback row for a server this organization was never told it has.
    expect(screen.queryByText(/guild-42/)).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')
  })
})

describe('multiple active Discord server bindings (TEN-9)', () => {
  const BINDING_A: DiscordServerBindingSummary = {
    serverId: 'guild-a',
    organizationId: 'org-1',
    installedByAccountId: 'account-other',
    installedAt: Date.now() - 86_400_000,
    removedAt: null,
    serverName: null,
  }
  const BINDING_B: DiscordServerBindingSummary = {
    serverId: 'guild-b',
    organizationId: 'org-1',
    installedByAccountId: 'account-other',
    installedAt: Date.now() - 43_200_000,
    removedAt: null,
    serverName: null,
  }

  it('lists every active binding with its own Remove, and still offers installing another', async () => {
    listDiscordServers.mockResolvedValue([BINDING_A, BINDING_B])

    renderWithModal(<DiscordSettings organizationId="org-1" />)

    expect(await screen.findByText(/guild-a/)).toBeInTheDocument()
    expect(screen.getByText(/guild-b/)).toBeInTheDocument()
    // One Remove per binding — never one Install/Remove pair for the whole
    // organization the way this screen used to be. WEB-68 — and with two
    // active bindings already, the install button still reads "another,"
    // not the bare "Install to Discord" this screen shows with none.
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2)
    expect(
      screen.getByRole('button', {
        name: 'Install to another Discord server',
      })
    ).toBeInTheDocument()
  })

  it('removing one binding leaves the other listed, still active', async () => {
    dispatchAction.mockResolvedValue({ result: undefined })
    listDiscordServers.mockResolvedValue([BINDING_A, BINDING_B])

    renderWithModal(<DiscordSettings organizationId="org-1" />)
    await screen.findByText(/guild-a/)

    // Two rows, each with its own Remove — click the first one's.
    const [firstRemove] = screen.getAllByRole('button', { name: 'Remove' })
    if (!firstRemove) throw new Error('expected a Remove button')
    fireEvent.click(firstRemove)
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(dispatchAction).toHaveBeenCalledWith(
        'org-1',
        'discordServers.remove',
        { serverId: 'guild-a' }
      )
    )
    // `guild-a`'s own row is gone; `guild-b` is untouched and still offers
    // its own Remove — the identity of which binding was removed, not
    // merely that a removal happened.
    await waitFor(() =>
      expect(screen.queryByText(/guild-a/)).not.toBeInTheDocument()
    )
    expect(screen.getByText(/guild-b/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1)
  })
})

describe('TEN-8 rework: coordinator review findings, carried over', () => {
  it('cheap-fix: shows the active binding, not merely the first one in the list, when a removed binding is also present', async () => {
    // Order deliberately puts the removed binding first —
    // `bindings[0]` would pick it; only `.filter(isActiveDiscordBinding)`
    // picks the active one that actually belongs here.
    listDiscordServers.mockResolvedValue([
      {
        serverId: 'guild-removed',
        organizationId: 'org-1',
        installedByAccountId: 'account-1',
        installedAt: Date.now() - 200_000,
        removedAt: Date.now() - 100_000,
      },
      {
        serverId: 'guild-active',
        organizationId: 'org-1',
        installedByAccountId: 'account-1',
        installedAt: Date.now() - 50_000,
        removedAt: null,
      },
    ])

    renderWithModal(<DiscordSettings organizationId="org-1" />)

    expect(await screen.findByText(/guild-active/)).toBeInTheDocument()
    expect(screen.queryByText(/guild-removed/)).not.toBeInTheDocument()
  })

  it('cheap-fix: a slow lookup that resolves after Remove does not resurrect the binding', async () => {
    dispatchAction.mockResolvedValue({ result: undefined })

    // The mount fetch never settles on its own — this test settles it by
    // hand, after Remove has already completed, standing in for a
    // response that started before the removal and only arrived after.
    let settleMountFetch:
      ((bindings: DiscordServerBindingSummary[]) => void) | undefined
    listDiscordServers.mockImplementation(
      () =>
        new Promise((resolve) => {
          settleMountFetch = resolve
        })
    )

    renderWithModal(
      <DiscordSettings
        organizationId="org-1"
        justInstalled={{ organizationId: 'org-1', serverId: 'guild-42' }}
      />
    )
    // `justInstalled` is the immediate signal while the mount fetch above
    // is still in flight.
    expect(await screen.findByText(/guild-42/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await screen.findByRole('button', { name: 'Install to Discord' })

    // The original mount fetch — begun before Remove ran, still unsettled
    // — finally resolves now, reporting the binding as still active,
    // because that response was generated before the removal happened.
    // `discordFetchId`'s own increment in `handleRemove` is what must make
    // this land as a no-op.
    settleMountFetch?.([
      {
        serverId: 'guild-42',
        organizationId: 'org-1',
        installedByAccountId: 'account-1',
        installedAt: Date.now(),
        removedAt: null,
        serverName: null,
      },
    ])
    // Flush the microtask queue so the stale response's `.then` — the one
    // that must be ignored — has a chance to run before this asserts, the
    // same idiom `tests/projects.test.tsx`/`tests/courses.test.tsx` use for
    // the identical class of race.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(
      screen.getByRole('button', { name: 'Install to Discord' })
    ).toBeInTheDocument()
    expect(screen.queryByText(/guild-42/)).not.toBeInTheDocument()
  })

  // WEB-69 rework round 2 — this component now unmounts outright on an
  // organization switch (`pages/OrganizationSettings.tsx`'s own
  // `key={activeOrganizationId}` remount at `pages/Shell.tsx`), rather than
  // staying mounted and refetching in place the way `pages/Shell.tsx`'s own
  // former implementation did — so "switching organization mid-fetch
  // ignores the stale response" is now this: an in-flight fetch that
  // resolves *after* this component has already unmounted must not throw
  // or warn, because nothing is listening for it any more.
  it('an in-flight fetch resolving after unmount is a silent no-op, not a crash', async () => {
    let settle: ((bindings: DiscordServerBindingSummary[]) => void) | undefined
    listDiscordServers.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )

    const { unmount } = renderWithModal(
      <DiscordSettings organizationId="org-1" />
    )
    unmount()
    settle?.([])
    // Nothing to assert beyond "this did not throw" — a `stale` guard that
    // failed to hold would call `setState` on an unmounted component,
    // which React reports as an error `render`'s own error boundary (none
    // configured here) would surface as a rejected test.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
