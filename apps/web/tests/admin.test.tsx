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
  fetchAdminOrganization,
  fetchAdminProject,
  fetchAdminAccounts,
  fetchAdminAccount,
} = vi.hoisted(() => ({
  fetchAdminOrganizations: vi.fn(),
  fetchDeletionPreview: vi.fn(),
  fetchTenantDeletions: vi.fn(),
  deleteTenant: vi.fn(),
  fetchAdminCourses: vi.fn(),
  fetchAdminCourse: vi.fn(),
  approveAdminCourse: vi.fn(),
  unapproveAdminCourse: vi.fn(),
  // ADMIN-7..ADMIN-11 — this phase's own four new reads.
  fetchAdminOrganization: vi.fn(),
  fetchAdminProject: vi.fn(),
  fetchAdminAccounts: vi.fn(),
  fetchAdminAccount: vi.fn(),
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
    fetchAdminOrganization,
    fetchAdminProject,
    fetchAdminAccounts,
    fetchAdminAccount,
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
    const nav = await screen.findByRole('navigation', { name: 'Console' })
    fireEvent.click(within(nav).getByRole('link', { name: 'Deletion history' }))

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
      // ADMIN-7 — `'admin-organization'` now fires its own read too; the
      // identical refusal, the same account-wide gate every route behind
      // `/platform-admin` makes.
      fetchAdminOrganization.mockRejectedValue(
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

// ADMIN-7 — `'admin-organization'`'s own fixture: `fetchAdminOrganization`'s
// full shape, not merely the list row `fetchAdminOrganizations` returns.
const ORG_DETAIL = {
  organizationId: 'org-1',
  name: 'A Real Tenant',
  isPersonal: false,
  spendingCapMicros: null,
  createdAt: Date.now(),
  usage: {
    totalCostMicros: 1_500_000,
    callCount: 3,
    hasEstimated: false,
    bySurface: [],
  },
  owners: [],
  members: [],
  projects: [],
}

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
    fetchAdminOrganization.mockResolvedValue(ORG_DETAIL)
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

  // ADMIN-7 — the organization's own screen is now its own read
  // (`fetchAdminOrganization`), not a row `.find()`d out of the list.
  it('opens an organization’s own detail screen by name, reads its own richer fetch, and back returns to the list', async () => {
    fetchAdminOrganization.mockResolvedValue(ORG_DETAIL)
    renderAdmin()

    fireEvent.click(await screen.findByRole('link', { name: 'A Real Tenant' }))

    expect(
      await screen.findByTestId('admin-org-detail-org-1')
    ).toBeInTheDocument()
    expect(fetchAdminOrganization).toHaveBeenCalledWith('org-1')
    expect(screen.getByText(/\$1\.50 spent/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '← Organizations' }))

    expect(await screen.findByTestId('admin-organizations')).toBeInTheDocument()
  })

  // ADMIN-7: an address naming an organization the API 404s renders the
  // same not-found treatment the rest of the panel gives, not an empty
  // screen.
  it('an organization id the API does not recognise (404) renders not-found', async () => {
    fetchAdminOrganization.mockRejectedValue(
      new ApiError(404, { error: 'organization_not_found' })
    )

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
    projectId: 'proj-1',
    projectName: 'Fall 2026',
    organizationId: 'org-1',
    organizationName: 'A Real Tenant',
    owners: [{ accountId: 'account-1', email: 'owner@example.edu' }],
    createdAt: Date.now(),
    aiApprovedAt: null,
    aiApprovedByAccountId: null,
    aiApprovedByEmail: null,
  }
  const APPROVED_COURSE = {
    courseId: 'course-2',
    courseTitle: 'Intro to Bloom',
    projectId: 'proj-2',
    projectName: 'Spring 2027',
    organizationId: 'org-2',
    organizationName: 'Another Tenant',
    owners: [{ accountId: 'account-2', email: 'other-owner@example.edu' }],
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

  // ADMIN-12/ADMIN-7: the last gap two reviews flagged — a row's own
  // project and owner emails were plain text; now every entity this row
  // names is a real link, the same treatment the title and organization
  // already got.
  it('links a row’s project and each owner email to their own console screens', async () => {
    fetchAdminCourses.mockResolvedValue({ courses: [PENDING_COURSE] })

    renderAdmin({ route: { kind: 'admin-courses' } })

    const pending = await screen.findByTestId('admin-courses-pending')
    expect(
      within(pending).getByRole('link', { name: 'Fall 2026' })
    ).toHaveAttribute('href', '/platform-admin/projects/proj-1')
    expect(
      within(pending).getByRole('link', { name: 'owner@example.edu' })
    ).toHaveAttribute('href', '/platform-admin/users/account-1')
  })

  // ADMIN-15: the organizations list's own Courses button is gone —
  // reached through `AdminNav`'s own link instead, same as every other
  // console destination.
  it('reached from AdminNav’s own Courses link', async () => {
    fetchAdminCourses.mockResolvedValue({ courses: [PENDING_COURSE] })

    renderAdmin()
    const nav = await screen.findByRole('navigation', { name: 'Console' })
    fireEvent.click(within(nav).getByRole('link', { name: 'Courses' }))

    expect(await screen.findByText('Web Design')).toBeInTheDocument()
  })

  // ADMIN-13: not destructive (an administrator can always Unapprove
  // again), but still confirmed — a plain `confirm()` naming the course,
  // never a typed-name prompt like ADMIN-5's own delete.
  it('approve confirms first, naming the course, and sends nothing if cancelled', async () => {
    fetchAdminCourses.mockResolvedValue({ courses: [PENDING_COURSE] })

    renderAdmin({ route: { kind: 'admin-courses' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Web Design')
    expect(approveAdminCourse).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(approveAdminCourse).not.toHaveBeenCalled()
  })

  it('confirming approve sends the request and refreshes the list', async () => {
    fetchAdminCourses.mockResolvedValue({ courses: [PENDING_COURSE] })
    approveAdminCourse.mockResolvedValue({ approved: true })

    renderAdmin({ route: { kind: 'admin-courses' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }))

    await waitFor(() =>
      expect(approveAdminCourse).toHaveBeenCalledWith('course-1')
    )
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
      // ADMIN-9's own widening from ADMIN-6's settings-only read.
      approvalEvents: [],
      usage: { totalCostMicros: 0, callCount: 0, bySurface: [] },
      people: [],
      rosterAcknowledgements: [],
    })

    renderAdmin({ route: { kind: 'admin-courses' } })
    fireEvent.click(await screen.findByRole('link', { name: 'Web Design' }))

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
      approvalEvents: [],
      usage: { totalCostMicros: 0, callCount: 0, bySurface: [] },
      people: [],
      rosterAcknowledgements: [],
    })
    // ADMIN-7 — `'admin-organization'` now fires its own read too.
    fetchAdminOrganization.mockResolvedValue(ORG_DETAIL)
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

  // ADMIN-15: the organizations screen's own footer row (Courses / Users /
  // Deletion history buttons) duplicated `AdminNav`'s own links to those
  // same three destinations — removed here, while the nav above still
  // carries all three.
  it('renders no Courses/Users/Deletion history buttons of its own — AdminNav carries those links instead', async () => {
    renderAdmin({ route: { kind: 'admin-organizations' } })

    const nav = await screen.findByRole('navigation', { name: 'Console' })
    for (const label of ['Courses', 'Users', 'Deletion history']) {
      expect(within(nav).getByRole('link', { name: label })).toBeVisible()
      expect(
        screen.queryByRole('button', { name: label })
      ).not.toBeInTheDocument()
    }
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
    // ADMIN-9's own widening from ADMIN-6's settings-only read.
    approvalEvents: [
      {
        id: 'event-1',
        action: 'approve' as const,
        accountId: 'account-1',
        accountEmail: 'admin@bloombot.example',
        createdAt: Date.now(),
      },
    ],
    usage: {
      totalCostMicros: 250_000,
      callCount: 2,
      bySurface: [],
    },
    people: [
      {
        personId: 'person-1',
        displayName: 'QA Student',
        email: 'student@example.edu',
        enroledAt: Date.now(),
        connectedAt: Date.now(),
        accountId: 'account-2',
        totalCostMicros: 100_000,
        callCount: 1,
      },
    ],
    // ROST-20 — the course's own roster-import acknowledgements.
    rosterAcknowledgements: [
      {
        id: 'ack-1',
        accountId: 'account-1',
        accountEmail: 'instructor@bloombot.example',
        filename: 'roster.csv',
        acknowledgementVersion: '2026-09-18',
        acknowledgedAt: Date.now(),
      },
    ],
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

  // ADMIN-13: the same confirmed approve as `CoursesView`'s own list,
  // naming the course, from this screen too.
  it('approves from this screen and refreshes it, not only the list', async () => {
    fetchAdminCourse.mockResolvedValue(COURSE_DETAIL)
    approveAdminCourse.mockResolvedValue({ approved: true })

    renderAdmin({ route: { kind: 'admin-course', courseId: 'course-1' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(COURSE_DETAIL.courseTitle)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }))

    await waitFor(() =>
      expect(approveAdminCourse).toHaveBeenCalledWith('course-1')
    )
    // Refreshed the detail screen itself, not the list — the list was
    // never fetched by this test at all.
    await waitFor(() => expect(fetchAdminCourse).toHaveBeenCalledTimes(2))
    expect(fetchAdminCourses).not.toHaveBeenCalled()
  })

  // ADMIN-13: the same confirmed unapprove as `CoursesView`'s own list,
  // naming the course, from this screen too.
  it('unapproves from this screen, naming the course, and sends nothing if cancelled', async () => {
    fetchAdminCourse.mockResolvedValue({
      ...COURSE_DETAIL,
      aiApprovedAt: Date.now(),
      aiApprovedByEmail: 'admin@bloombot.example',
    })

    renderAdmin({ route: { kind: 'admin-course', courseId: 'course-1' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Unapprove' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(COURSE_DETAIL.courseTitle)
    expect(unapproveAdminCourse).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Unapprove' }))

    await waitFor(() =>
      expect(unapproveAdminCourse).toHaveBeenCalledWith('course-1')
    )
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

  // ADMIN-9 — the widening past ADMIN-6's settings-only read: organization
  // and project as links, the approval history, usage, and the people
  // enrolled, linking to `admin-account` when a person carries one.
  it('shows the organization/project links, approval history, usage and enrolled people (ADMIN-9)', async () => {
    fetchAdminCourse.mockResolvedValue(COURSE_DETAIL)

    renderAdmin({ route: { kind: 'admin-course', courseId: 'course-1' } })

    const detail = await screen.findByTestId('admin-course-detail-course-1')

    expect(
      within(detail).getByRole('link', { name: 'A Real Tenant' })
    ).toHaveAttribute('href', '/platform-admin/organizations/org-1')
    expect(
      within(detail).getByRole('link', { name: 'Fall 2026' })
    ).toHaveAttribute('href', '/platform-admin/projects/proj-1')

    expect(
      within(detail).getByRole('region', { name: 'Approval history' })
    ).toHaveTextContent('admin@bloombot.example')

    expect(
      within(detail).getByRole('region', { name: 'Usage' })
    ).toHaveTextContent('$0.25 spent')

    const people = within(detail).getByRole('region', { name: 'People' })
    expect(people).toHaveTextContent('QA Student')
    expect(
      within(people).getByRole('link', { name: 'QA Student' })
    ).toHaveAttribute('href', '/platform-admin/users/account-2')
  })

  // ROST-20 — the course's own roster-import acknowledgements, alongside
  // the approval history.
  it('shows the course’s own roster-import acknowledgements', async () => {
    fetchAdminCourse.mockResolvedValue(COURSE_DETAIL)

    renderAdmin({ route: { kind: 'admin-course', courseId: 'course-1' } })

    const detail = await screen.findByTestId('admin-course-detail-course-1')
    const acknowledgements = within(detail).getByRole('region', {
      name: 'Roster acknowledgements',
    })
    expect(acknowledgements).toHaveTextContent('roster.csv')
    expect(acknowledgements).toHaveTextContent('instructor@bloombot.example')
  })
})

// ADMIN-7 — the organization screen's own richer read: usage, owners,
// members with roles, and its projects, each listing its own courses with
// approval state, enrolment count and cost — every project, course and
// owner a link to that entity's own screen.
describe('Admin — ADMIN-7’s organization console screen', () => {
  const RICH_ORG_DETAIL = {
    organizationId: 'org-1',
    name: 'A Real Tenant',
    isPersonal: false,
    spendingCapMicros: 5_000_000,
    createdAt: Date.now(),
    usage: {
      totalCostMicros: 1_500_000,
      callCount: 3,
      hasEstimated: false,
      bySurface: [],
    },
    owners: [
      {
        accountId: 'account-1',
        email: 'owner@example.edu',
        displayName: 'Owner One',
      },
    ],
    members: [
      {
        accountId: 'account-1',
        email: 'owner@example.edu',
        displayName: 'Owner One',
        role: 'owner',
        grantedAt: Date.now(),
      },
    ],
    projects: [
      {
        projectId: 'proj-1',
        name: 'Fall 2026',
        archivedAt: null,
        createdAt: Date.now(),
        courses: [
          {
            courseId: 'course-1',
            title: 'Web Design',
            enabled: true,
            aiApprovedAt: null,
            enrolmentCount: 4,
            totalCostMicros: 250_000,
          },
        ],
      },
    ],
  }

  beforeEach(() => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [],
      platformHealth: PLATFORM_HEALTH,
    })
  })

  it('renders usage, owners, members and projects with courses, each a link to its own screen', async () => {
    fetchAdminOrganization.mockResolvedValue(RICH_ORG_DETAIL)

    renderAdmin({
      route: { kind: 'admin-organization', organizationId: 'org-1' },
    })

    const detail = await screen.findByTestId('admin-org-detail-org-1')

    expect(detail).toHaveTextContent('$1.50 spent')
    expect(
      within(detail).getByRole('region', { name: 'Owners' })
    ).toHaveTextContent('Owner One')
    expect(
      within(detail).getByRole('region', { name: 'Members' })
    ).toHaveTextContent('owner')

    const projects = within(detail).getByRole('region', { name: 'Projects' })
    expect(
      within(projects).getByRole('link', { name: 'Fall 2026' })
    ).toHaveAttribute('href', '/platform-admin/projects/proj-1')
    expect(
      within(projects).getByRole('link', { name: 'Web Design' })
    ).toHaveAttribute('href', '/platform-admin/courses/course-1')
    expect(projects).toHaveTextContent('4 enrolled')

    // "Owner One" links twice — once from Owners, once from Members (the
    // same account, both an owner and a member) — scoped to Owners rather
    // than asking `detail` for one link with two matches.
    const owners = within(detail).getByRole('region', { name: 'Owners' })
    expect(
      within(owners).getByRole('link', { name: 'Owner One' })
    ).toHaveAttribute('href', '/platform-admin/users/account-1')
  })
})

// ADMIN-8 — a project's own console screen, reached by a link from
// `admin-organization`: its name, its organization (a link back), when it
// was created, whether it is archived, and its courses.
describe('Admin — ADMIN-8’s project console screen', () => {
  const PROJECT_DETAIL = {
    projectId: 'proj-1',
    name: 'Fall 2026',
    organizationId: 'org-1',
    organizationName: 'A Real Tenant',
    archivedAt: null,
    createdAt: Date.now(),
    courses: [
      {
        courseId: 'course-1',
        title: 'Web Design',
        enabled: true,
        aiApprovedAt: Date.now(),
        enrolmentCount: 4,
        totalCostMicros: 250_000,
      },
    ],
  }

  beforeEach(() => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [],
      platformHealth: PLATFORM_HEALTH,
    })
  })

  it('renders the project’s own facts, its organization link, and its courses with a link each', async () => {
    fetchAdminProject.mockResolvedValue(PROJECT_DETAIL)

    renderAdmin({ route: { kind: 'admin-project', projectId: 'proj-1' } })

    const detail = await screen.findByTestId('admin-project-detail-proj-1')

    expect(
      within(detail).getByRole('link', { name: 'A Real Tenant' })
    ).toHaveAttribute('href', '/platform-admin/organizations/org-1')
    expect(
      within(detail).getByRole('link', { name: 'Web Design' })
    ).toHaveAttribute('href', '/platform-admin/courses/course-1')
    expect(detail).toHaveTextContent('4')
    expect(detail).toHaveTextContent('$0.25')
  })

  it('a project id the API does not recognise (404) renders not-found', async () => {
    fetchAdminProject.mockRejectedValue(
      new ApiError(404, { error: 'project_not_found' })
    )

    renderAdmin({ route: { kind: 'admin-project', projectId: 'missing' } })

    expect(await screen.findByTestId('not-found-page')).toBeInTheDocument()
  })
})

// ADMIN-10 — the console's Users screen: every account, newest first, each
// a link to its own console screen.
describe('Admin — ADMIN-10’s Users screen', () => {
  beforeEach(() => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [],
      platformHealth: PLATFORM_HEALTH,
    })
  })

  it('lists accounts with a link into each account’s own screen', async () => {
    fetchAdminAccounts.mockResolvedValue({
      accounts: [
        {
          accountId: 'account-1',
          email: 'owner@example.edu',
          displayName: 'Owner One',
          firstName: 'Owner',
          lastName: 'One',
          createdAt: Date.now(),
          disabledAt: null,
          isPlatformAdministrator: false,
          organizationCount: 2,
          totalCostMicros: 500_000,
        },
      ],
    })

    renderAdmin({ route: { kind: 'admin-accounts' } })

    const list = await screen.findByTestId('admin-accounts')
    expect(
      within(list).getByRole('link', { name: 'Owner One' })
    ).toHaveAttribute('href', '/platform-admin/users/account-1')
    expect(list).toHaveTextContent('owner@example.edu')
    expect(list).toHaveTextContent('$0.50')
  })

  // ADMIN-15: the organizations list's own Users button is gone — reached
  // through `AdminNav`'s own link instead, same as every other console
  // destination.
  it('reached from AdminNav’s own Users link', async () => {
    fetchAdminAccounts.mockResolvedValue({ accounts: [] })

    renderAdmin()
    const nav = await screen.findByRole('navigation', { name: 'Console' })
    fireEvent.click(within(nav).getByRole('link', { name: 'Users' }))

    expect(await screen.findByText('No accounts yet.')).toBeInTheDocument()
  })
})

// ADMIN-11 — one account's own console screen: identity, memberships with
// roles, connected organizations, enrolments, people records and usage,
// every organization/project/course a link to its own screen.
describe('Admin — ADMIN-11’s account console screen', () => {
  const ACCOUNT_DETAIL = {
    accountId: 'account-1',
    email: 'owner@example.edu',
    displayName: 'Owner One',
    firstName: 'Owner',
    lastName: 'One',
    createdAt: Date.now(),
    disabledAt: null,
    isPlatformAdministrator: false,
    memberships: [
      {
        organizationId: 'org-1',
        organizationName: 'A Real Tenant',
        role: 'owner',
        grantedAt: Date.now(),
      },
    ],
    connectedOrganizations: [],
    people: [
      {
        personId: 'person-1',
        organizationId: 'org-1',
        organizationName: 'A Real Tenant',
        displayName: 'Owner One',
        email: 'owner@example.edu',
        githubHandle: null,
        connectedAt: Date.now(),
        createdAt: Date.now(),
        identities: [
          { surface: 'web', externalId: 'account-1', createdAt: Date.now() },
        ],
      },
    ],
    enrolments: [
      {
        courseId: 'course-1',
        courseTitle: 'Web Design',
        projectId: 'proj-1',
        projectName: 'Fall 2026',
        organizationId: 'org-1',
        organizationName: 'A Real Tenant',
        enroledAt: Date.now(),
      },
    ],
    usage: {
      totalCostMicros: 500_000,
      callCount: 5,
      hasEstimated: false,
      bySurface: [],
      byCourse: [
        {
          courseId: 'course-1',
          courseTitle: 'Web Design',
          organizationId: 'org-1',
          totalCostMicros: 500_000,
          callCount: 5,
        },
      ],
      lastActiveAt: Date.now(),
    },
    // ROST-20 — every roster import this account has acknowledged.
    rosterAcknowledgements: [
      {
        id: 'ack-1',
        courseId: 'course-1',
        courseTitle: 'Web Design',
        organizationId: 'org-1',
        organizationName: 'A Real Tenant',
        filename: 'roster.csv',
        acknowledgementVersion: '2026-09-18',
        acknowledgedAt: Date.now(),
      },
    ],
  }

  beforeEach(() => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [],
      platformHealth: PLATFORM_HEALTH,
    })
  })

  it('renders identity, memberships, enrolments, people and usage, each entity a link to its own screen', async () => {
    fetchAdminAccount.mockResolvedValue(ACCOUNT_DETAIL)

    renderAdmin({
      route: { kind: 'admin-account', accountId: 'account-1' },
    })

    const detail = await screen.findByTestId('admin-account-detail-account-1')

    expect(detail).toHaveTextContent('owner@example.edu')
    // "A Real Tenant" links from three sections now, so each assertion scopes
    // to the section it is about rather than asking `detail` for one match.
    const organizations = within(detail).getByRole('region', {
      name: 'Organizations',
    })
    expect(
      within(organizations).getByRole('link', { name: 'A Real Tenant' })
    ).toHaveAttribute('href', '/platform-admin/organizations/org-1')
    // "Web Design" links twice — once from the enrolment, once from the
    // usage-by-course breakdown — so this scopes to the enrolments section
    // rather than asking `detail` for one link with two matches.
    const enrolments = within(detail).getByRole('region', {
      name: 'Enrolments',
    })
    expect(
      within(enrolments).getByRole('link', { name: 'Web Design' })
    ).toHaveAttribute('href', '/platform-admin/courses/course-1')
    // ADMIN-11: *every* entity named on this screen is a link, not only the
    // course — the project and organization an enrolment names are reachable
    // without going back out through the course screen.
    expect(
      within(enrolments).getByRole('link', { name: 'Fall 2026' })
    ).toHaveAttribute('href', '/platform-admin/projects/proj-1')
    expect(
      within(enrolments).getByRole('link', { name: 'A Real Tenant' })
    ).toHaveAttribute('href', '/platform-admin/organizations/org-1')
    // The same organization is a link in the people section too, where a
    // connected-only tenant may appear that the memberships section never
    // names.
    const peopleSection = within(detail).getByRole('region', { name: 'People' })
    expect(
      within(peopleSection).getByRole('link', { name: 'A Real Tenant' })
    ).toHaveAttribute('href', '/platform-admin/organizations/org-1')
    expect(detail).toHaveTextContent('$0.50 spent')
  })

  it('an account id the API does not recognise (404) renders not-found', async () => {
    fetchAdminAccount.mockRejectedValue(
      new ApiError(404, { error: 'account_not_found' })
    )

    renderAdmin({
      route: { kind: 'admin-account', accountId: 'missing' },
    })

    expect(await screen.findByTestId('not-found-page')).toBeInTheDocument()
  })

  // ROST-20 — every acknowledgement this account has made, each course
  // linking to its own console screen.
  it('shows the account’s own roster-import acknowledgements, its course a link to its own screen', async () => {
    fetchAdminAccount.mockResolvedValue(ACCOUNT_DETAIL)

    renderAdmin({
      route: { kind: 'admin-account', accountId: 'account-1' },
    })

    const detail = await screen.findByTestId('admin-account-detail-account-1')
    const acknowledgements = within(detail).getByRole('region', {
      name: 'Roster acknowledgements',
    })
    expect(acknowledgements).toHaveTextContent('roster.csv')
    expect(
      within(acknowledgements).getByRole('link', { name: 'Web Design' })
    ).toHaveAttribute('href', '/platform-admin/courses/course-1')
  })
})

// ADMIN-10 — `AdminNav` carries Users between Courses and Deletion
// history, and marks it current from either the list or its own account
// detail screen.
describe('Admin — ADMIN-10’s Users nav item', () => {
  beforeEach(() => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [],
      platformHealth: PLATFORM_HEALTH,
    })
    fetchAdminAccounts.mockResolvedValue({ accounts: [] })
  })

  it('appears between Courses and Deletion history, and is marked current on the Users screen', async () => {
    renderAdmin({ route: { kind: 'admin-accounts' } })

    const nav = await screen.findByRole('navigation', { name: 'Console' })
    const links = within(nav).getAllByRole('link')
    const labels = links.map((link) => link.textContent)
    expect(labels).toEqual([
      'Organizations',
      'Courses',
      'Users',
      'Deletion history',
    ])
    expect(within(nav).getByRole('link', { name: 'Users' })).toHaveAttribute(
      'aria-current',
      'page'
    )
  })
})

// ADMIN-12 — a search field on every list screen, filtering the rows
// already fetched (no new request), case-insensitively, over the field(s)
// each screen's own brief names.
describe('Admin — ADMIN-12’s console search', () => {
  it('narrows organizations by name, case-insensitively, reports the match count, and clears', async () => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [
        {
          organizationId: 'org-1',
          organizationName: 'Acme University',
          totalCostMicros: 0,
          estimatedCostMicros: 0,
          callCount: 0,
          bySurface: [],
        },
        {
          organizationId: 'org-2',
          organizationName: 'Beta College',
          totalCostMicros: 0,
          estimatedCostMicros: 0,
          callCount: 0,
          bySurface: [],
        },
      ],
      platformHealth: PLATFORM_HEALTH,
    })

    renderAdmin()

    await screen.findByText('Beta College')
    const field = screen.getByLabelText('Search organizations')
    fireEvent.change(field, { target: { value: 'ACME' } })

    expect(screen.getByText('Acme University')).toBeInTheDocument()
    expect(screen.queryByText('Beta College')).not.toBeInTheDocument()
    expect(screen.getByText('Showing 1 of 2 organizations')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(field).toHaveValue('')
    expect(screen.getByText('Beta College')).toBeInTheDocument()
  })

  it('a search matching no organizations says so, not an empty list', async () => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [
        {
          organizationId: 'org-1',
          organizationName: 'Acme University',
          totalCostMicros: 0,
          estimatedCostMicros: 0,
          callCount: 0,
          bySurface: [],
        },
      ],
      platformHealth: PLATFORM_HEALTH,
    })

    renderAdmin()
    await screen.findByText('Acme University')
    fireEvent.change(screen.getByLabelText('Search organizations'), {
      target: { value: 'nonexistent' },
    })

    expect(
      screen.getByText('No organizations match “nonexistent”.')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('admin-organizations')).not.toBeInTheDocument()
  })

  it('narrows courses by title, project, organization or owner email, filtering both the pending and approved lists', async () => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [],
      platformHealth: PLATFORM_HEALTH,
    })
    fetchAdminCourses.mockResolvedValue({
      courses: [
        {
          courseId: 'course-1',
          courseTitle: 'Web Design',
          projectId: 'proj-1',
          projectName: 'Fall 2026',
          organizationId: 'org-1',
          organizationName: 'A Real Tenant',
          owners: [{ accountId: 'account-1', email: 'owner@example.edu' }],
          createdAt: Date.now(),
          aiApprovedAt: null,
          aiApprovedByAccountId: null,
          aiApprovedByEmail: null,
        },
        {
          courseId: 'course-2',
          courseTitle: 'History 101',
          projectId: 'proj-2',
          projectName: 'Winter 2026',
          organizationId: 'org-2',
          organizationName: 'Zeta Org',
          owners: [{ accountId: 'account-2', email: 'zeta-owner@example.edu' }],
          createdAt: Date.now(),
          aiApprovedAt: null,
          aiApprovedByAccountId: null,
          aiApprovedByEmail: null,
        },
        {
          courseId: 'course-3',
          courseTitle: 'Intro to Bloom',
          projectId: 'proj-3',
          projectName: 'Spring 2027',
          organizationId: 'org-1',
          organizationName: 'A Real Tenant',
          owners: [{ accountId: 'account-1', email: 'owner@example.edu' }],
          createdAt: Date.now(),
          aiApprovedAt: Date.now(),
          aiApprovedByAccountId: 'admin-1',
          aiApprovedByEmail: 'admin@bloombot.example',
        },
        {
          courseId: 'course-4',
          courseTitle: 'Chemistry',
          projectId: 'proj-4',
          projectName: 'Fall 2025',
          organizationId: 'org-2',
          organizationName: 'Zeta Org',
          owners: [{ accountId: 'account-2', email: 'zeta-owner@example.edu' }],
          createdAt: Date.now(),
          aiApprovedAt: Date.now(),
          aiApprovedByAccountId: 'admin-1',
          aiApprovedByEmail: 'admin@bloombot.example',
        },
      ],
    })

    renderAdmin({ route: { kind: 'admin-courses' } })
    await screen.findByText('Chemistry')

    fireEvent.change(screen.getByLabelText('Search courses'), {
      target: { value: 'a real tenant' },
    })

    const pending = screen.getByTestId('admin-courses-pending')
    expect(within(pending).getByText('Web Design')).toBeInTheDocument()
    expect(within(pending).queryByText('History 101')).not.toBeInTheDocument()

    const approved = screen.getByTestId('admin-courses-approved')
    expect(within(approved).getByText('Intro to Bloom')).toBeInTheDocument()
    expect(within(approved).queryByText('Chemistry')).not.toBeInTheDocument()

    expect(screen.getByText('Showing 2 of 4 courses')).toBeInTheDocument()

    // Also matches by owner email and by project name — not only title or
    // organization.
    fireEvent.change(screen.getByLabelText('Search courses'), {
      target: { value: 'zeta-owner@example.edu' },
    })
    expect(screen.getByTestId('admin-courses-pending')).toHaveTextContent(
      'History 101'
    )
    fireEvent.change(screen.getByLabelText('Search courses'), {
      target: { value: 'Winter 2026' },
    })
    expect(screen.getByTestId('admin-courses-pending')).toHaveTextContent(
      'History 101'
    )
  })

  it('a search matching no courses says so for each list it empties, not an empty <ul>', async () => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [],
      platformHealth: PLATFORM_HEALTH,
    })
    fetchAdminCourses.mockResolvedValue({
      courses: [
        {
          courseId: 'course-1',
          courseTitle: 'Web Design',
          projectId: 'proj-1',
          projectName: 'Fall 2026',
          organizationId: 'org-1',
          organizationName: 'A Real Tenant',
          owners: [],
          createdAt: Date.now(),
          aiApprovedAt: null,
          aiApprovedByAccountId: null,
          aiApprovedByEmail: null,
        },
      ],
    })

    renderAdmin({ route: { kind: 'admin-courses' } })
    await screen.findByText('Web Design')
    fireEvent.change(screen.getByLabelText('Search courses'), {
      target: { value: 'nonexistent' },
    })

    expect(
      screen.getByText('No pending courses match “nonexistent”.')
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('admin-courses-pending')
    ).not.toBeInTheDocument()
  })

  it('narrows users by name or email', async () => {
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [],
      platformHealth: PLATFORM_HEALTH,
    })
    fetchAdminAccounts.mockResolvedValue({
      accounts: [
        {
          accountId: 'account-1',
          email: 'owner@example.edu',
          displayName: 'Owner One',
          firstName: 'Owner',
          lastName: 'One',
          createdAt: Date.now(),
          disabledAt: null,
          isPlatformAdministrator: false,
          organizationCount: 2,
          totalCostMicros: 500_000,
        },
        {
          accountId: 'account-2',
          email: 'second@example.edu',
          displayName: 'Second Person',
          firstName: 'Second',
          lastName: 'Person',
          createdAt: Date.now(),
          disabledAt: null,
          isPlatformAdministrator: false,
          organizationCount: 1,
          totalCostMicros: 0,
        },
      ],
    })

    renderAdmin({ route: { kind: 'admin-accounts' } })
    await screen.findByText('Second Person')

    fireEvent.change(screen.getByLabelText('Search users'), {
      target: { value: 'owner@example.edu' },
    })
    expect(screen.getByText('Owner One')).toBeInTheDocument()
    expect(screen.queryByText('Second Person')).not.toBeInTheDocument()
  })

  it('narrows deletion history by organization name', async () => {
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
      {
        id: 'deletion-2',
        organizationId: 'org-2',
        organizationName: 'Another Departure',
        deletedByAccountId: 'account-1',
        summary: '{}',
        deletedAt: Date.now(),
      },
    ])

    renderAdmin({ route: { kind: 'admin-deletions' } })
    await screen.findByText('Another Departure')

    fireEvent.change(screen.getByLabelText('Search deletion history'), {
      target: { value: 'departed' },
    })
    expect(screen.getByText('A Departed Tenant')).toBeInTheDocument()
    expect(screen.queryByText('Another Departure')).not.toBeInTheDocument()
    expect(screen.getByText('Showing 1 of 2 deletions')).toBeInTheDocument()
  })
})
