/**
 * `components/JoinLinks.tsx` (WEB-20): the screen a course's join links
 * were missing entirely. Every case below is what that component's own
 * module comment promises: a created secret shown exactly once with a copy
 * control, a list that never repeats it, and a revoke that confirms first
 * and states both halves of ENRL-4.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { CourseJoinLinkSummary } from '../src/api/types.js'
import { JoinLinks } from '../src/components/JoinLinks.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const { createCourseJoinLink, listCourseJoinLinks, revokeCourseJoinLink } =
  vi.hoisted(() => ({
    createCourseJoinLink: vi.fn(),
    listCourseJoinLinks: vi.fn(),
    revokeCourseJoinLink: vi.fn(),
  }))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    createCourseJoinLink,
    listCourseJoinLinks,
    revokeCourseJoinLink,
  }
})

function link(
  overrides: Partial<CourseJoinLinkSummary> = {}
): CourseJoinLinkSummary {
  return {
    id: 'link-1',
    courseId: 'course-1',
    expiresAt: null,
    revokedAt: null,
    createdByAccountId: 'account-1',
    createdAt: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  // jsdom carries no `navigator.clipboard` by default — stubbed here so
  // `handleCopy` has something real to call, and so tests below can assert
  // the exact URL it was called with.
  Object.assign(navigator, { clipboard: { writeText: vi.fn() } })
})

afterEach(() => {
  vi.resetAllMocks()
})

describe('JoinLinks (WEB-20)', () => {
  it('shows the empty state when a course has no join links', async () => {
    listCourseJoinLinks.mockResolvedValue([])

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)

    expect(
      await screen.findByText('No join links issued yet.')
    ).toBeInTheDocument()
  })

  it('lists each link with its expiry and revoked state', async () => {
    listCourseJoinLinks.mockResolvedValue([
      link({ id: 'link-1', expiresAt: null, revokedAt: null }),
      link({ id: 'link-2', expiresAt: Date.now() + 100_000, revokedAt: null }),
      link({ id: 'link-3', expiresAt: null, revokedAt: Date.now() }),
    ])

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)

    expect(await screen.findByText('No expiry')).toBeInTheDocument()
    expect(screen.getByText(/^Expires /)).toBeInTheDocument()
    expect(screen.getByText(/^Revoked /)).toBeInTheDocument()
    // A revoked link offers no revoke control of its own.
    expect(
      screen.queryAllByRole('button', { name: /^Revoke join link/ })
    ).toHaveLength(2)
  })

  // Fails without the fix: before `courseJoinLinks.list` existed, this
  // component had nothing to call and nothing to render here at all.
  it('creating shows the secret exactly once, with a control that copies it — the list never repeats it', async () => {
    listCourseJoinLinks
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([link({ id: 'link-1' })])
    createCourseJoinLink.mockResolvedValue({
      linkId: 'link-1',
      secret: 'the-secret-value',
      expiresAt: null,
    })

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText('No join links issued yet.')

    fireEvent.click(screen.getByRole('button', { name: 'Create join link' }))

    await waitFor(() =>
      expect(createCourseJoinLink).toHaveBeenCalledWith('org-1', 'course-1')
    )
    const urlNode = await screen.findByTestId('created-join-link-url')
    expect(urlNode).toHaveTextContent('/join/the-secret-value')
    expect(screen.getByText(/shown only this once/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('/join/the-secret-value')
      )
    )

    // The list itself — read back from `courseJoinLinks.list` — never
    // carries anything secret-shaped; only the one-time banner above does.
    const list = await screen.findByRole('list')
    expect(within(list).queryByText(/the-secret-value/)).not.toBeInTheDocument()
  })

  // "Not re-fetchable after a reload" — a fresh mount of this same
  // component (standing in for a reload, which always remounts React state
  // from scratch) has never seen the secret and has no route back to it: it
  // reads only `courseJoinLinks.list`, which never carries one.
  it('a fresh mount never shows a secret, even for a link this session already created', async () => {
    listCourseJoinLinks.mockResolvedValue([link({ id: 'link-1' })])

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)

    await screen.findByText(/^Created /)
    expect(
      screen.queryByTestId('created-join-link-url')
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/shown only this once/)).not.toBeInTheDocument()
  })

  it('revoking confirms first, stating both halves of ENRL-4 — cancelling calls nothing', async () => {
    listCourseJoinLinks.mockResolvedValue([link({ id: 'link-1' })])

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText(/^Created /)

    fireEvent.click(screen.getByRole('button', { name: /^Revoke join link/ }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Revoke this join link?',
    })
    expect(dialog).toHaveTextContent('stops the link admitting anyone new')
    expect(dialog).toHaveTextContent('does not un-enrol anybody')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(revokeCourseJoinLink).not.toHaveBeenCalled()
  })

  it('revoking, confirmed, dispatches the action and the link reads as revoked', async () => {
    listCourseJoinLinks
      .mockResolvedValueOnce([link({ id: 'link-1', revokedAt: null })])
      .mockResolvedValue([link({ id: 'link-1', revokedAt: Date.now() })])
    revokeCourseJoinLink.mockResolvedValue({ revoked: true })

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText(/^Created /)

    fireEvent.click(screen.getByRole('button', { name: /^Revoke join link/ }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Revoke this join link?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }))

    await waitFor(() =>
      expect(revokeCourseJoinLink).toHaveBeenCalledWith('org-1', 'link-1')
    )
    expect(await screen.findByText(/^Revoked /)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^Revoke join link/ })
    ).not.toBeInTheDocument()
  })

  // Rework finding (cheap-fix): `navigator.clipboard` is `undefined` on a
  // non-secure origin — before this fix, `handleCopy` awaited
  // `.writeText` straight off it with no `try`/`catch`, which threw a
  // `TypeError` as an unhandled rejection: the label stayed "Copy link"
  // forever and nothing told the instructor their one, unrecoverable
  // secret was never actually copied. Fails without the fix (the `catch`
  // in `handleCopy`): `screen.findByRole('alert')` below times out, since
  // nothing renders one.
  it('a clipboard that cannot be reached is reported, and the URL stays visible to copy by hand', async () => {
    listCourseJoinLinks.mockResolvedValue([])
    createCourseJoinLink.mockResolvedValue({
      linkId: 'link-1',
      secret: 'the-secret-value',
      expiresAt: null,
    })
    // Standing in for a non-secure origin, where the browser never defines
    // `navigator.clipboard` at all — overriding this test file's own
    // `beforeEach` stub.
    Object.assign(navigator, { clipboard: undefined })

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText('No join links issued yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Create join link' }))
    await screen.findByTestId('created-join-link-url')

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not copy the link — copy it from the text above by hand.'
    )
    // The label never claims a copy that did not happen.
    expect(
      screen.queryByRole('button', { name: 'Copied!' })
    ).not.toBeInTheDocument()
    // The one unrecoverable value stays on screen, still copyable by hand.
    expect(screen.getByTestId('created-join-link-url')).toHaveTextContent(
      '/join/the-secret-value'
    )
  })

  it('a refused create renders the same ErrorMessage every other refusal in this app uses', async () => {
    listCourseJoinLinks.mockResolvedValue([])
    createCourseJoinLink.mockRejectedValue(
      new ApiError(404, { error: 'action_refused' })
    )

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText('No join links issued yet.')

    fireEvent.click(screen.getByRole('button', { name: 'Create join link' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })
})

// WEB-23: an instructor chooses an expiry when issuing a link — defaulting
// to none, so today's behaviour (the block above) is what an instructor
// gets by not choosing at all.
describe('JoinLinks expiry (WEB-23)', () => {
  it("issuing without choosing an expiry still sends none — today's behaviour, unchanged. Fails without the fix: before WEB-23, this was the only path that existed at all, but a naive fix that always sends a third argument breaks this exact call shape", async () => {
    listCourseJoinLinks
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([link({ id: 'link-1' })])
    createCourseJoinLink.mockResolvedValue({
      linkId: 'link-1',
      secret: 'the-secret-value',
      expiresAt: null,
    })

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText('No join links issued yet.')

    fireEvent.click(screen.getByRole('button', { name: 'Create join link' }))

    // Exactly two arguments — no `expiresAt`, not even `undefined` — so a
    // link issued without touching the new control redeems forever, same as
    // before this slice.
    await waitFor(() =>
      expect(createCourseJoinLink).toHaveBeenCalledWith('org-1', 'course-1')
    )
  })

  it('choosing an expiry sends a future epoch-millisecond value, and the created link carries it. Fails without the fix: the expiry control did not exist, so there was nothing to select and this action was never called with a third argument at all', async () => {
    listCourseJoinLinks
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        link({ id: 'link-1', expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 }),
      ])
    createCourseJoinLink.mockResolvedValue({
      linkId: 'link-1',
      secret: 'the-secret-value',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    })

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText('No join links issued yet.')

    fireEvent.change(screen.getByLabelText('Expiry'), {
      target: { value: '1w' },
    })
    const before = Date.now()
    fireEvent.click(screen.getByRole('button', { name: 'Create join link' }))

    await waitFor(() => expect(createCourseJoinLink).toHaveBeenCalled())
    const [organizationId, courseId, expiresAt] = createCourseJoinLink.mock
      .calls[0] as [string, string, number]
    expect(organizationId).toBe('org-1')
    expect(courseId).toBe('course-1')
    expect(typeof expiresAt).toBe('number')
    expect(Number.isInteger(expiresAt)).toBe(true)
    // Strictly in the future, as `createInputSchema` requires — and
    // consistent with a one-week duration added to roughly "now".
    expect(expiresAt).toBeGreaterThan(before)
    expect(expiresAt).toBeLessThanOrEqual(
      before + 7 * 24 * 60 * 60 * 1000 + 1000
    )
  })

  // Rework finding (cheap-fix): the test above only bounds `1w`'s own value
  // (`> before`, `<= before + a week + 1000`) — any duration up to a week
  // satisfies it, so mutating `EXPIRY_OPTIONS`' own `durationMs` table (a
  // later edit mistyping `16 * 7` as `16 * 6`, say) shipped green with the
  // label still reading "1 term (16 weeks)" while term links stopped
  // admitting students two weeks early. This pins every timed option to its
  // exact millisecond duration, computed off a frozen clock, so the table
  // itself is what is under test rather than merely its own loose bounds.
  it.each([
    ['1d', 24 * 60 * 60 * 1000],
    ['1w', 7 * 24 * 60 * 60 * 1000],
    ['1mo', 30 * 24 * 60 * 60 * 1000],
    ['1term', 16 * 7 * 24 * 60 * 60 * 1000],
  ] as const)(
    'option %s sends an expiry exactly %i ms after send time',
    async (value, durationMs) => {
      listCourseJoinLinks.mockResolvedValue([])
      createCourseJoinLink.mockResolvedValue({
        linkId: 'link-1',
        secret: 'the-secret-value',
        expiresAt: null,
      })
      const t0 = 1_700_000_000_000
      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(t0)

      renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
      await screen.findByText('No join links issued yet.')
      fireEvent.change(screen.getByLabelText('Expiry'), {
        target: { value },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Create join link' }))

      await waitFor(() => expect(createCourseJoinLink).toHaveBeenCalled())
      const [, , expiresAt] = createCourseJoinLink.mock.calls[0] as [
        string,
        string,
        number,
      ]
      expect(expiresAt).toBe(t0 + durationMs)

      dateSpy.mockRestore()
    }
  )

  // "Mind the gap between rendering a choice and the request being made" —
  // the brief's own wording. Fails without the fix if the component instead
  // captured `Date.now() + duration` at the moment the option was selected:
  // this test lets a long delay pass between selecting and clicking, and
  // asserts the value sent is still computed relative to *send* time, not
  // stale from selection time.
  it('recomputes the expiry at send time, not at the moment the option was selected', async () => {
    listCourseJoinLinks.mockResolvedValue([])
    createCourseJoinLink.mockResolvedValue({
      linkId: 'link-1',
      secret: 'the-secret-value',
      expiresAt: null,
    })
    const dayMs = 24 * 60 * 60 * 1000
    const t0 = 1_700_000_000_000
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(t0)

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText('No join links issued yet.')
    fireEvent.change(screen.getByLabelText('Expiry'), {
      target: { value: '1d' },
    })

    // A long pause between choosing and clicking — long enough that a value
    // computed eagerly at selection time (t0 + 1 day) would already be in
    // the past by the time the request is actually sent.
    dateSpy.mockReturnValue(t0 + 2 * dayMs)
    fireEvent.click(screen.getByRole('button', { name: 'Create join link' }))

    await waitFor(() => expect(createCourseJoinLink).toHaveBeenCalled())
    const [, , expiresAt] = createCourseJoinLink.mock.calls[0] as [
      string,
      string,
      number,
    ]
    // Computed off the clock at send time (t0 + 2 days), not selection time
    // (t0) — strictly greater than "now" at the moment of sending.
    expect(expiresAt).toBe(t0 + 2 * dayMs + dayMs)
    expect(expiresAt).toBeGreaterThan(t0 + 2 * dayMs)

    dateSpy.mockRestore()
  })

  it('the list renders a real expiry, and an already-expired link reads as expired — distinct from a revoked one', async () => {
    const past = Date.now() - 1000
    listCourseJoinLinks.mockResolvedValue([
      link({ id: 'link-1', expiresAt: past, revokedAt: null }),
      link({ id: 'link-2', expiresAt: null, revokedAt: past }),
    ])

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)

    expect(await screen.findByText(/^Expired /)).toBeInTheDocument()
    expect(screen.getByText(/^Revoked /)).toBeInTheDocument()
    // An already-expired, never-revoked link still offers "Revoke" — it is
    // read as expired, not folded into the revoked state.
    expect(
      screen.getAllByRole('button', { name: /^Revoke join link/ })
    ).toHaveLength(1)
  })

  // Rework finding (cheap-fix): the test above only ever exercises one
  // expired-not-revoked link and one revoked-with-null-expiry link, never a
  // link that is both — so `formatExpiry`'s own branch order (D-63: revoked
  // checked before expired) was undefended. Moving the `expiresAt` branch
  // above the `revokedAt` one survived every existing case; this one would
  // not, since it is the one link both branches could plausibly claim.
  it("a link that is both expired and revoked reads as revoked, not expired (D-63: the clock does not override an instructor's own act)", async () => {
    const past = Date.now() - 1000
    listCourseJoinLinks.mockResolvedValue([
      link({ id: 'link-1', expiresAt: past, revokedAt: past }),
    ])

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)

    expect(await screen.findByText(/^Revoked /)).toBeInTheDocument()
    expect(screen.queryByText(/^Expired /)).not.toBeInTheDocument()
  })
})
