/**
 * ADMIN-4/ADMIN-5: `pages/Admin.tsx` — organizations, usage and health, and
 * the confirmed, audited tenant deletion. ADMIN-4's own boundary (never a
 * course, a student or a message) is proven at the HTTP layer
 * (`apps/api/tests/routes/admin.test.ts`) — this file proves the panel's
 * own confirmation is real: a mismatched name refuses, and the deletion is
 * a typed-name prompt, not a plain confirm a stray click could pass
 * (WEB-15).
 *
 * WEB-33 — `Admin` now takes `route`/`navigate` (which of the console's own
 * screens is current), the identical shape `tests/shell.test.tsx`'s own
 * `renderShell` already gives `Shell`: `renderAdmin`, below, mounts `Admin`
 * behind a tiny stateful wrapper standing in for `App.tsx`'s own
 * `useRoute()`, so every existing "click something, assert what renders"
 * test in this file keeps working with a real, in-test `navigate` rather
 * than a route this component can no longer take as a bare prop.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'

import { ApiError } from '../src/api/client.js'
import { Admin } from '../src/pages/Admin.js'
import type { AdminRoute, Route } from '../src/routing/route.js'
import { isAdminRoute } from '../src/routing/route.js'
import { renderWithModal, withModal } from './helpers/render-with-modal.js'

/** Mirrors `tests/shell.test.tsx`'s own `renderShell` — defaults to `'admin-organizations'`, the console's own landing screen once `'platform-admin'` itself resolves and replaces (`Admin.tsx`'s own module comment). */
function renderAdmin({
  route = { kind: 'admin-organizations' },
  onBack = vi.fn(),
}: { route?: AdminRoute; onBack?: () => void } = {}) {
  function Harness() {
    const [currentRoute, setCurrentRoute] = useState<AdminRoute>(route)
    const navigate = (next: Route) => {
      // `Admin` only ever constructs an `AdminRoute` itself — mirrors
      // `App.tsx`'s own guard (`isAdminRoute`) rather than assuming it.
      if (isAdminRoute(next)) setCurrentRoute(next)
    }
    return <Admin route={currentRoute} navigate={navigate} onBack={onBack} />
  }
  return renderWithModal(<Harness />)
}

const {
  fetchAdminOrganizations,
  fetchDeletionPreview,
  fetchTenantDeletions,
  deleteTenant,
  fetchAdminCourses,
  fetchAdminCourse,
  approveAdminCourse,
  unapproveAdminCourse,
} = vi.hoisted(() => ({
  fetchAdminOrganizations: vi.fn(),
  fetchDeletionPreview: vi.fn(),
  fetchTenantDeletions: vi.fn(),
  deleteTenant: vi.fn(),
  fetchAdminCourses: vi.fn(),
  fetchAdminCourse: vi.fn(),
  approveAdminCourse: vi.fn(),
  unapproveAdminCourse: vi.fn(),
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
    fetchAdminCourses,
    fetchAdminCourse,
    approveAdminCourse,
    unapproveAdminCourse,
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
          bySurface: [],
        },
      ],
      platformHealth: PLATFORM_HEALTH,
    })

    renderAdmin()

    expect(await screen.findByText('A Real Tenant')).toBeInTheDocument()
    expect(screen.getByText(/\$1\.50 spent/)).toBeInTheDocument()
  })

  // COST-7 — a per-organization total broken down by surface, with
  // `'unknown'` (a row written before this column existed) rendered as
  // prose rather than the bare enum value.
  it('breaks a per-organization total down by surface, rendering `unknown` as prose', async () => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [
        {
          organizationId: 'org-1',
          organizationName: 'A Real Tenant',
          totalCostMicros: 1_200_000,
          estimatedCostMicros: 0,
          callCount: 4,
          bySurface: [
            {
              surface: 'mcp',
              costMicros: 1_000_000,
              estimatedCostMicros: 0,
              callCount: 3,
            },
            {
              surface: 'unknown',
              costMicros: 200_000,
              estimatedCostMicros: 0,
              callCount: 1,
            },
          ],
        },
      ],
      platformHealth: PLATFORM_HEALTH,
    })

    renderAdmin()

    await screen.findByText('A Real Tenant')
    const bySurfaceLine = screen.getByText(/By surface:/)
    expect(bySurfaceLine).toHaveTextContent('MCP: $1.00 · 3 call(s)')
    expect(bySurfaceLine).toHaveTextContent(
      'recorded before surfaces were tracked: $0.20 · 1 call(s)'
    )
  })

  // WEB-45: row-shaped skeletons while the read is in flight, gone once the
  // real organization rows take their place.
  it('shows row-shaped skeletons while loading, announced to assistive technology, and swaps them for the real list once fetchAdminOrganizations resolves', async () => {
    let resolveOrganizations:
      | ((value: {
          organizations: unknown[]
          platformHealth: typeof PLATFORM_HEALTH
        }) => void)
      | undefined
    fetchAdminOrganizations.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOrganizations = resolve
        })
    )

    const { container } = renderAdmin()

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(
      0
    )
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')

    resolveOrganizations?.({
      organizations: [
        {
          organizationId: 'org-1',
          organizationName: 'A Real Tenant',
          totalCostMicros: 0,
          estimatedCostMicros: 0,
          callCount: 0,
          bySurface: [],
        },
      ],
      platformHealth: PLATFORM_HEALTH,
    })

    expect(await screen.findByText('A Real Tenant')).toBeInTheDocument()
    expect(container.querySelectorAll('.animate-pulse').length).toBe(0)
  })

  // Also-fix of the ADMIN-1..5 rework: this screen's own module comment
  // claimed every read went through `fetchTenantDeletions`, but nothing
  // ever called it — dead code masquerading as a documented one.
  //
  // WEB-33: the deletion history now lives at its own address
  // (`'admin-deletions'`) rather than inline on the organizations list —
  // reached here by clicking through, the same way a real navigation would.
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

    renderAdmin()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Deletion history' })
    )

    expect(await screen.findByText('A Departed Tenant')).toBeInTheDocument()
  })

  it('a non-administrator sees the refusal in words, not a blank screen', async () => {
    fetchAdminOrganizations.mockRejectedValue(
      new ApiError(403, { error: 'not_platform_administrator' })
    )

    const { container } = renderAdmin()

    expect(
      await screen.findByText(/platform-administrator access/i)
    ).toBeInTheDocument()
    // Review finding: the split into three screens dropped the `!error &&`
    // guard around the placeholder, so the refusal was shown *and* a
    // permanent "Loading…" underneath it — a screen claiming to still be
    // fetching something it has already been refused.
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    // WEB-45: the same guard means a refusal never shows a skeleton either
    // — `failed` is what a skeleton call site checks first, same as the
    // old placeholder did.
    expect(container.querySelectorAll('.animate-pulse').length).toBe(0)
  })

  // The same finding on each of the two screens the split created — a
  // failed read must not leave either of them spinning forever.
  it.each([
    [
      'admin-organization',
      { kind: 'admin-organization', organizationId: 'org-1' },
    ],
    ['admin-deletions', { kind: 'admin-deletions' }],
  ] as const)(
    'the %s screen shows the refusal rather than a permanent "Loading…"',
    async (_name, route) => {
      fetchAdminOrganizations.mockRejectedValue(
        new ApiError(403, { error: 'not_platform_administrator' })
      )
      fetchTenantDeletions.mockRejectedValue(
        new ApiError(403, { error: 'not_platform_administrator' })
      )

      renderAdmin({ route })

      expect(
        await screen.findByText(/platform-administrator access/i)
      ).toBeInTheDocument()
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    }
  )
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
          bySurface: [],
        },
      ],
      platformHealth: PLATFORM_HEALTH,
    })
    fetchDeletionPreview.mockResolvedValue(PREVIEW)

    renderAdmin()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    // ADMIN-5: "names exactly what will be deleted before it happens" — the
    // preview's own counts are read into the confirmation itself.
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('2 course(s)')
    expect(dialog).toHaveTextContent('5 student record(s)')

    // WEB-50 rework finding: the confirm button is disabled until the
    // typed value actually validates, not merely checked after a click —
    // starts disabled (nothing typed yet), stays disabled for a wrong
    // name, and only enables for the exact one.
    const field = within(dialog).getByLabelText('Organization name')
    const confirmButton = within(dialog).getByRole('button', {
      name: 'Delete',
    })
    expect(confirmButton).toBeDisabled()

    fireEvent.change(field, { target: { value: 'the wrong name' } })
    expect(confirmButton).toBeDisabled()
    expect(deleteTenant).not.toHaveBeenCalled()

    // The exact name proceeds.
    fireEvent.change(field, { target: { value: 'A Real Tenant' } })
    expect(confirmButton).not.toBeDisabled()
    deleteTenant.mockResolvedValue({ deleted: true })
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [],
      platformHealth: PLATFORM_HEALTH,
    })
    fireEvent.click(confirmButton)

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
          bySurface: [],
        },
      ],
      platformHealth: PLATFORM_HEALTH,
    })
    fetchDeletionPreview.mockResolvedValue(PREVIEW)
    deleteTenant.mockRejectedValue(
      new ApiError(409, { error: 'confirmation_name_mismatch' })
    )

    renderAdmin()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Organization name'), {
      target: { value: 'A Real Tenant' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/did not match/i)
  })
})

describe('Admin — WEB-33’s own screens', () => {
  beforeEach(() => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [
        {
          organizationId: 'org-1',
          organizationName: 'A Real Tenant',
          totalCostMicros: 1_500_000,
          estimatedCostMicros: 0,
          callCount: 3,
          bySurface: [],
        },
      ],
      platformHealth: PLATFORM_HEALTH,
    })
  })

  // Review finding — a delete started from the organization's *own*
  // address left the operator on that address, which the refreshed read no
  // longer matches: a successful deletion rendered "Not found".
  it('a deletion started from an organization’s own screen returns to the list, not a not-found page', async () => {
    fetchDeletionPreview.mockResolvedValue(PREVIEW)
    deleteTenant.mockResolvedValue(undefined)
    fetchTenantDeletions.mockResolvedValue([])

    renderAdmin({
      route: { kind: 'admin-organization', organizationId: 'org-1' },
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Organization name'), {
      target: { value: 'A Real Tenant' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(deleteTenant).toHaveBeenCalledWith('org-1', 'A Real Tenant')
    })
    expect(await screen.findByTestId('admin-organizations')).toBeInTheDocument()
    expect(screen.queryByTestId('not-found-page')).not.toBeInTheDocument()
  })

  // `'platform-admin'` itself is never rendered past its own effect —
  // it resolves to `'admin-organizations'` and replaces, mirroring
  // `App.tsx`'s own `'home'` resolution (`Admin.tsx`'s own module comment).
  it('resolves the console’s own entry point to the organizations list', async () => {
    renderAdmin({ route: { kind: 'platform-admin' } })

    expect(await screen.findByText('A Real Tenant')).toBeInTheDocument()
  })

  it('opens an organization’s own detail screen by name, and back returns to the list', async () => {
    renderAdmin()

    fireEvent.click(
      await screen.findByRole('button', { name: 'A Real Tenant' })
    )

    expect(
      await screen.findByTestId('admin-org-detail-org-1')
    ).toBeInTheDocument()
    expect(screen.getByText(/\$1\.50 spent/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '← Organizations' }))

    expect(await screen.findByTestId('admin-organizations')).toBeInTheDocument()
  })

  // WEB-33: an address naming an organization that does not exist gets the
  // same not-found treatment the rest of the panel gives, not an empty
  // screen — proven here by asking for a screen the fetched list has no
  // matching entry for at all.
  it('an organization id absent from the fetched list renders not-found', async () => {
    renderAdmin({
      route: { kind: 'admin-organization', organizationId: 'no-such-org' },
    })

    expect(await screen.findByTestId('not-found-page')).toBeInTheDocument()
  })
})

describe('Admin — WEB-53’s Courses screen', () => {
  const PENDING_COURSE = {
    courseId: 'course-1',
    courseTitle: 'Web Design',
    projectName: 'Fall 2026',
    organizationId: 'org-1',
    organizationName: 'A Real Tenant',
    ownerEmails: ['owner@example.edu'],
    createdAt: Date.now(),
    aiApprovedAt: null,
    aiApprovedByAccountId: null,
    aiApprovedByEmail: null,
  }
  const APPROVED_COURSE = {
    courseId: 'course-2',
    courseTitle: 'Intro to Bloom',
    projectName: 'Spring 2027',
    organizationId: 'org-2',
    organizationName: 'Another Tenant',
    ownerEmails: ['other-owner@example.edu'],
    createdAt: Date.now(),
    aiApprovedAt: Date.now(),
    aiApprovedByAccountId: 'admin-1',
    aiApprovedByEmail: 'admin@bloombot.example',
  }

  beforeEach(() => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [],
      platformHealth: PLATFORM_HEALTH,
    })
  })

  it('lists pending courses with an Approve button, and approved courses with an Unapprove button', async () => {
    fetchAdminCourses.mockResolvedValue({
      courses: [PENDING_COURSE, APPROVED_COURSE],
    })

    renderAdmin({ route: { kind: 'admin-courses' } })

    const pending = await screen.findByTestId('admin-courses-pending')
    expect(within(pending).getByText('Web Design')).toBeInTheDocument()
    expect(
      within(pending).getByRole('button', { name: 'Approve' })
    ).toBeInTheDocument()

    const approved = screen.getByTestId('admin-courses-approved')
    expect(within(approved).getByText('Intro to Bloom')).toBeInTheDocument()
    expect(
      within(approved).getByRole('button', { name: 'Unapprove' })
    ).toBeInTheDocument()
    // WEB-53: "recorded with who acted and when" — the approver shows on
    // the approved row.
    expect(approved).toHaveTextContent('admin@bloombot.example')
  })

  it('reached from the organizations list’s own Courses button', async () => {
    fetchAdminCourses.mockResolvedValue({ courses: [PENDING_COURSE] })

    renderAdmin()
    fireEvent.click(await screen.findByRole('button', { name: 'Courses' }))

    expect(await screen.findByText('Web Design')).toBeInTheDocument()
  })

  it('approve runs immediately, with no confirmation, and refreshes the list', async () => {
    fetchAdminCourses.mockResolvedValue({ courses: [PENDING_COURSE] })
    approveAdminCourse.mockResolvedValue({ approved: true })

    renderAdmin({ route: { kind: 'admin-courses' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))

    await waitFor(() =>
      expect(approveAdminCourse).toHaveBeenCalledWith('course-1')
    )
    // Not destructive — no dialog opened for this direction.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  // WEB-53's brief: Unapprove is the destructive direction and confirms
  // through this panel's one modal — but needs no typed-name prompt, unlike
  // ADMIN-5's own delete (revoking is reversible; deleting a tenant is not).
  it('unapprove confirms first, with a plain confirm rather than a typed-name prompt', async () => {
    fetchAdminCourses.mockResolvedValue({ courses: [APPROVED_COURSE] })
    unapproveAdminCourse.mockResolvedValue({ approved: false })

    renderAdmin({ route: { kind: 'admin-courses' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Unapprove' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Intro to Bloom')
    // No typed-name field — a plain confirm, unlike ADMIN-5's own prompt.
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument()
    expect(unapproveAdminCourse).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Unapprove' }))

    await waitFor(() =>
      expect(unapproveAdminCourse).toHaveBeenCalledWith('course-2')
    )
  })

  it('backing out of the unapprove confirmation calls nothing', async () => {
    fetchAdminCourses.mockResolvedValue({ courses: [APPROVED_COURSE] })

    renderAdmin({ route: { kind: 'admin-courses' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Unapprove' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(unapproveAdminCourse).not.toHaveBeenCalled()
  })

  // ADMIN-6 — a row's own title is a link into `'admin-course'`.
  it('a row’s title navigates to its own admin-course screen', async () => {
    fetchAdminCourses.mockResolvedValue({ courses: [PENDING_COURSE] })
    fetchAdminCourse.mockResolvedValue({
      ...PENDING_COURSE,
      projectId: 'proj-1',
      adminsRole: null,
      studentsRole: null,
      categories: [],
      conversationScope: 'course',
      model: null,
      promptId: null,
      instructions: null,
      maxRequestsPerDay: null,
      selfEnrolFromDiscord: false,
      answerUnenrolled: true,
      attachments: [],
      webSources: [],
      aiApprovalDecidedAt: null,
    })

    renderAdmin({ route: { kind: 'admin-courses' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Web Design' }))

    await waitFor(() =>
      expect(fetchAdminCourse).toHaveBeenCalledWith('course-1')
    )
  })
})

// WEB-54 — the console's own secondary navigation and the platform-health
// footer, on every one of the console's five screens.
describe('Admin — WEB-54’s console navigation and health footer', () => {
  beforeEach(() => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [],
      platformHealth: PLATFORM_HEALTH,
    })
    fetchAdminCourses.mockResolvedValue({ courses: [] })
    fetchAdminCourse.mockResolvedValue({
      courseId: 'course-1',
      courseTitle: 'Web Design',
      enabled: true,
      projectId: 'proj-1',
      projectName: 'Fall 2026',
      organizationId: 'org-1',
      organizationName: 'A Real Tenant',
      adminsRole: null,
      studentsRole: null,
      categories: [],
      conversationScope: 'course',
      model: null,
      promptId: null,
      instructions: null,
      maxRequestsPerDay: null,
      selfEnrolFromDiscord: false,
      answerUnenrolled: true,
      attachments: [],
      webSources: [],
      aiApprovedAt: null,
      aiApprovedByAccountId: null,
      aiApprovedByEmail: null,
      aiApprovalDecidedAt: null,
    })
  })

  it.each([
    ['admin-organizations', { kind: 'admin-organizations' }, 'Organizations'],
    [
      'admin-organization',
      { kind: 'admin-organization', organizationId: 'org-1' },
      'Organizations',
    ],
    ['admin-courses', { kind: 'admin-courses' }, 'Courses'],
    ['admin-course', { kind: 'admin-course', courseId: 'course-1' }, 'Courses'],
    ['admin-deletions', { kind: 'admin-deletions' }, 'Deletion history'],
  ] as const)(
    'renders the nav and health footer on the %s screen, with %s marked current',
    async (_name, route, currentLabel) => {
      renderAdmin({ route })

      const nav = await screen.findByRole('navigation', { name: 'Console' })
      const current = within(nav).getByText(currentLabel)
      expect(current).toHaveAttribute('aria-current', 'page')

      // The other two destinations are present but not current.
      for (const label of ['Organizations', 'Courses', 'Deletion history']) {
        if (label === currentLabel) continue
        expect(within(nav).getByText(label)).not.toHaveAttribute(
          'aria-current',
          'page'
        )
      }

      // The health footer — a `contentinfo` landmark — renders on every
      // screen, reading the one `fetchAdminOrganizations` response `Admin`
      // already holds.
      const footer = screen.getByRole('contentinfo')
      expect(within(footer).getByText('Bot')).toBeInTheDocument()
      expect(within(footer).getByText('Worker')).toBeInTheDocument()
      expect(within(footer).getByText('API')).toBeInTheDocument()
    }
  )

  it('clicking each nav destination navigates to the right screen', async () => {
    renderAdmin({ route: { kind: 'admin-organizations' } })

    const nav = await screen.findByRole('navigation', { name: 'Console' })
    fireEvent.click(within(nav).getByRole('link', { name: 'Courses' }))
    expect(
      await screen.findByRole('heading', { name: 'Pending approval' })
    ).toBeInTheDocument()

    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Console' })).getByRole(
        'link',
        { name: 'Deletion history' }
      )
    )
    expect(
      await screen.findByRole('heading', { name: 'Deletion history' })
    ).toBeInTheDocument()

    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Console' })).getByRole(
        'link',
        { name: 'Organizations' }
      )
    )
    expect(await screen.findByText('No organizations yet.')).toBeInTheDocument()
  })

  // The footer used to render inline on the organizations screen alone —
  // proven gone from there by checking it appears exactly once (the fixed
  // footer), not a leftover second copy.
  it('the health footer no longer appears inline on the organizations screen — one copy, not two', async () => {
    renderAdmin({ route: { kind: 'admin-organizations' } })

    await screen.findByRole('navigation', { name: 'Console' })
    expect(screen.getAllByText('Bot')).toHaveLength(1)
  })

  // Code review finding: a refusal on one screen's own read used to
  // outlive that screen — `error` was only ever reset by the
  // delete/approve/unapprove handlers, so a failed `fetchAdminCourses` on
  // Courses kept showing its refusal banner on every screen the new nav
  // reached afterward, including one (Organizations) whose own read had
  // succeeded. Navigating away through the nav must leave the next screen
  // clean.
  it('a refusal on one screen does not follow an operator to the next one reached through the nav', async () => {
    fetchAdminCourses.mockRejectedValue(
      new ApiError(500, { error: 'internal_error' })
    )

    renderAdmin({ route: { kind: 'admin-courses' } })

    expect(await screen.findByRole('alert')).toBeInTheDocument()

    const nav = await screen.findByRole('navigation', { name: 'Console' })
    fireEvent.click(within(nav).getByRole('link', { name: 'Organizations' }))

    expect(await screen.findByText('No organizations yet.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // Second review round: `not_platform_administrator` describes the
  // account, not the screen — every route behind `/platform-admin` makes
  // the identical check (`routes/admin.ts`), so navigating away must not
  // clear it the way an ordinary per-screen read failure clears (the test
  // just above). Left showing, it also keeps `'admin-organization'`/
  // `'admin-deletions'` (screens that fire no read of their own on
  // navigation, only at mount) from rendering a permanent loading skeleton
  // with no fetch left in flight to ever resolve it.
  it('a platform-administrator refusal stays on screen across navigation, unlike an ordinary per-screen failure', async () => {
    fetchAdminOrganizations.mockRejectedValue(
      new ApiError(403, { error: 'not_platform_administrator' })
    )
    fetchTenantDeletions.mockRejectedValue(
      new ApiError(403, { error: 'not_platform_administrator' })
    )
    fetchAdminCourses.mockRejectedValue(
      new ApiError(403, { error: 'not_platform_administrator' })
    )

    renderAdmin({ route: { kind: 'admin-organizations' } })

    expect(
      await screen.findByText(/platform-administrator access/i)
    ).toBeInTheDocument()

    const nav = await screen.findByRole('navigation', { name: 'Console' })
    fireEvent.click(within(nav).getByRole('link', { name: 'Deletion history' }))

    // Still refused — `'admin-deletions'` fires no read of its own on
    // navigation, so nothing but the sticky refusal from mount explains
    // this not being a permanent, silent "Loading…" instead.
    expect(
      await screen.findByText(/platform-administrator access/i)
    ).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('Admin — ADMIN-6’s read-only course settings screen', () => {
  const COURSE_DETAIL = {
    courseId: 'course-1',
    courseTitle: 'Web Design',
    enabled: true,
    projectId: 'proj-1',
    projectName: 'Fall 2026',
    organizationId: 'org-1',
    organizationName: 'A Real Tenant',
    adminsRole: 'admins-wd',
    studentsRole: 'students-wd',
    categories: [
      {
        name: 'Web Design',
        channels: [{ name: 'general', adminsOnly: false }],
      },
    ],
    conversationScope: 'course',
    model: 'gpt-5',
    promptId: null,
    instructions: 'Answer only from the syllabus.',
    maxRequestsPerDay: 20,
    selfEnrolFromDiscord: true,
    answerUnenrolled: false,
    attachments: [
      { filename: 'syllabus.pdf', sizeBytes: 4096, status: 'ready' as const },
    ],
    webSources: [{ domain: 'example.edu' }],
    aiApprovedAt: null,
    aiApprovedByAccountId: null,
    aiApprovedByEmail: null,
    aiApprovalDecidedAt: null,
  }

  beforeEach(() => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [],
      platformHealth: PLATFORM_HEALTH,
    })
  })

  it('renders each settings group, read-only — nothing a person can type into', async () => {
    fetchAdminCourse.mockResolvedValue(COURSE_DETAIL)

    renderAdmin({ route: { kind: 'admin-course', courseId: 'course-1' } })

    expect(
      await screen.findByRole('region', { name: 'General' })
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'AI' })).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'Knowledge' })
    ).toBeInTheDocument()

    // General
    expect(screen.getByText('admins-wd')).toBeInTheDocument()
    expect(screen.getByText('students-wd')).toBeInTheDocument()
    // AI
    expect(screen.getByText('gpt-5')).toBeInTheDocument()
    expect(
      screen.getByText('Answer only from the syllabus.')
    ).toBeInTheDocument()
    // Knowledge
    expect(screen.getByText(/syllabus\.pdf/)).toBeInTheDocument()
    expect(screen.getByText('example.edu')).toBeInTheDocument()

    // Nothing editable — no inputs, no selects, no Save.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /save/i })
    ).not.toBeInTheDocument()
  })

  it('back returns to the Courses list', async () => {
    fetchAdminCourse.mockResolvedValue(COURSE_DETAIL)
    fetchAdminCourses.mockResolvedValue({ courses: [] })

    renderAdmin({ route: { kind: 'admin-course', courseId: 'course-1' } })
    await screen.findByRole('region', { name: 'General' })

    fireEvent.click(screen.getByRole('button', { name: '← Courses' }))

    await waitFor(() => expect(fetchAdminCourses).toHaveBeenCalled())
  })

  it('a course id absent from the API (404) renders not-found', async () => {
    fetchAdminCourse.mockRejectedValue(
      new ApiError(404, { error: 'course_not_found' })
    )

    renderAdmin({ route: { kind: 'admin-course', courseId: 'missing' } })

    expect(await screen.findByText(/not found/i)).toBeInTheDocument()
  })

  it('approves from this screen and refreshes it, not only the list', async () => {
    fetchAdminCourse.mockResolvedValue(COURSE_DETAIL)
    approveAdminCourse.mockResolvedValue({ approved: true })

    renderAdmin({ route: { kind: 'admin-course', courseId: 'course-1' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))

    await waitFor(() =>
      expect(approveAdminCourse).toHaveBeenCalledWith('course-1')
    )
    // Refreshed the detail screen itself, not the list — the list was
    // never fetched by this test at all.
    await waitFor(() => expect(fetchAdminCourse).toHaveBeenCalledTimes(2))
    expect(fetchAdminCourses).not.toHaveBeenCalled()
  })

  // Must-fix, second review round: `currentCourseIdRef`'s own doc comment
  // in `Admin.tsx` has the full scenario — course A's read is slow, an
  // operator moves on to course B (fast), and A's response then lands
  // after B's already has. Controls `route` directly across two renders
  // (`rerender`, not `renderAdmin`'s own click-driven navigation) so A's
  // own fetch can be left deliberately unresolved while B's already has —
  // the failure this guards against is a *timing* one, not reachable by
  // driving the UI at whatever speed a click resolves at.
  it('a slow response for a previous course does not overwrite the one now on screen', async () => {
    const courseA = {
      ...COURSE_DETAIL,
      courseId: 'course-a',
      courseTitle: 'Course A',
    }
    const courseB = {
      ...COURSE_DETAIL,
      courseId: 'course-b',
      courseTitle: 'Course B',
    }
    let resolveA: ((value: typeof courseA) => void) | undefined
    fetchAdminCourse.mockImplementation((courseId: string) => {
      if (courseId === 'course-a') {
        return new Promise((resolve) => {
          resolveA = resolve
        })
      }
      if (courseId === 'course-b') return Promise.resolve(courseB)
      throw new Error(`unexpected courseId ${courseId}`)
    })

    const navigate = vi.fn()
    const { rerender } = renderWithModal(
      <Admin
        route={{ kind: 'admin-course', courseId: 'course-a' }}
        navigate={navigate}
        onBack={vi.fn()}
      />
    )
    await waitFor(() =>
      expect(fetchAdminCourse).toHaveBeenCalledWith('course-a')
    )

    // Course B's own address becomes current before A's response has
    // landed — A's own fetch (`resolveA`) is still unsettled here.
    rerender(
      withModal(
        <Admin
          route={{ kind: 'admin-course', courseId: 'course-b' }}
          navigate={navigate}
          onBack={vi.fn()}
        />
      )
    )
    await screen.findByText('Course B')

    // A's late response arrives now — must be ignored, not overwrite B.
    resolveA?.(courseA)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.getByText('Course B')).toBeInTheDocument()
    expect(screen.queryByText('Course A')).not.toBeInTheDocument()
  })

  // The mirrored direction — a stale *404* for the previous course must not
  // mark the current one not-found, and must not leave the current one
  // stuck on a skeleton either (nothing re-fires the effect once its own
  // address is already current).
  it('a stale 404 for a previous course does not mark the current one not-found', async () => {
    const courseB = {
      ...COURSE_DETAIL,
      courseId: 'course-b',
      courseTitle: 'Course B',
    }
    let rejectA: ((reason: unknown) => void) | undefined
    fetchAdminCourse.mockImplementation((courseId: string) => {
      if (courseId === 'course-a') {
        return new Promise((_resolve, reject) => {
          rejectA = reject
        })
      }
      if (courseId === 'course-b') return Promise.resolve(courseB)
      throw new Error(`unexpected courseId ${courseId}`)
    })

    const navigate = vi.fn()
    const { rerender } = renderWithModal(
      <Admin
        route={{ kind: 'admin-course', courseId: 'course-a' }}
        navigate={navigate}
        onBack={vi.fn()}
      />
    )
    await waitFor(() =>
      expect(fetchAdminCourse).toHaveBeenCalledWith('course-a')
    )

    rerender(
      withModal(
        <Admin
          route={{ kind: 'admin-course', courseId: 'course-b' }}
          navigate={navigate}
          onBack={vi.fn()}
        />
      )
    )
    await screen.findByText('Course B')

    // A's stale 404 lands now — must be ignored, not render NotFound over B.
    rejectA?.(new ApiError(404, { error: 'course_not_found' }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.getByText('Course B')).toBeInTheDocument()
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument()
  })
})
