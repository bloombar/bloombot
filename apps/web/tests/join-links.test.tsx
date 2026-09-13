/**
 * `components/JoinLinks.tsx` (WEB-20, ENRL-12): the screen a course's join
 * links were missing entirely. Every case below is what that component's
 * own module comment promises: a created secret shown exactly once with a
 * copy control, a list that never repeats it, a revoke that confirms first
 * and states both halves of ENRL-4, and — ENRL-12 — a live, revealable
 * link's secret shown again on request, with the same copy affordance and
 * copy-failure handling creation already offers.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { CourseJoinLinkSummary } from '../src/api/types.js'
import { JoinLinks } from '../src/components/JoinLinks.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const {
  createCourseJoinLink,
  listCourseJoinLinks,
  revealCourseJoinLink,
  revokeCourseJoinLink,
} = vi.hoisted(() => ({
  createCourseJoinLink: vi.fn(),
  listCourseJoinLinks: vi.fn(),
  revealCourseJoinLink: vi.fn(),
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
    revealCourseJoinLink,
    revokeCourseJoinLink,
  }
})

// ENRL-12: `revealable: true` by default — the shape a link created under
// this slice, with an encryption key configured, actually has. Tests about
// a link that predates ENRL-12 (or one created with no key) override this
// explicitly, the same way a revoked or expired case already overrides
// `revokedAt`/`expiresAt`.
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
    revealable: true,
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

// ENRL-12: a live, revealable link's secret can be shown again, with the
// same copy affordance (and copy-failure handling) creation already offers.
describe('JoinLinks reveal (ENRL-12)', () => {
  it("reveals a live link's secret, with a copy control matching creation's own", async () => {
    listCourseJoinLinks.mockResolvedValue([link({ id: 'link-1' })])
    revealCourseJoinLink.mockResolvedValue({ secret: 'the-revealed-secret' })

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText(/^Created /)

    fireEvent.click(screen.getByRole('button', { name: /^Show join link/ }))

    await waitFor(() =>
      expect(revealCourseJoinLink).toHaveBeenCalledWith('org-1', 'link-1')
    )
    const urlNode = await screen.findByTestId('revealed-join-link-url')
    expect(urlNode).toHaveTextContent('/join/the-revealed-secret')
    // The "Show secret" control retires once its own panel is open — one
    // way to reach it per link, not two redundant ones.
    expect(
      screen.queryByRole('button', { name: /^Show join link/ })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('/join/the-revealed-secret')
      )
    )
  })

  it('a revoked link offers no reveal control at all', async () => {
    listCourseJoinLinks.mockResolvedValue([
      link({ id: 'link-1', revokedAt: Date.now(), revealable: true }),
    ])

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText(/^Revoked /)

    expect(
      screen.queryByRole('button', { name: /^Show join link/ })
    ).not.toBeInTheDocument()
  })

  it('an expired link offers no reveal control at all, even though it still offers Revoke', async () => {
    listCourseJoinLinks.mockResolvedValue([
      link({
        id: 'link-1',
        expiresAt: Date.now() - 1000,
        revealable: true,
      }),
    ])

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText(/^Expired /)

    expect(
      screen.queryByRole('button', { name: /^Show join link/ })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^Revoke join link/ })
    ).toBeInTheDocument()
  })

  // ENRL-12's own text: a link created before this shipped (or while no key
  // was configured) explains itself in terms an instructor reads as an
  // explanation, not an error — never a control that can only fail.
  it('a live link with nothing encrypted to show explains itself, offering no control that would only fail', async () => {
    listCourseJoinLinks.mockResolvedValue([
      link({ id: 'link-1', revealable: false }),
    ])

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText(/^Created /)

    expect(
      screen.queryByRole('button', { name: /^Show join link/ })
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/didn.t keep a recoverable copy of this link.s secret/)
    ).toBeInTheDocument()
    // Reads as an explanation, not an error — no alert role for a state
    // this screen already knew about from the listing alone.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // The revealed secret does not survive where it should not: revealing a
  // second link replaces the first outright, and the DOM after that
  // re-render carries only the new one.
  it('revealing a different link replaces the previously revealed secret — it does not survive the re-render', async () => {
    listCourseJoinLinks.mockResolvedValue([
      link({ id: 'link-1' }),
      link({ id: 'link-2' }),
    ])
    revealCourseJoinLink.mockImplementation((_organizationId, linkId) =>
      Promise.resolve({ secret: `secret-for-${linkId}` })
    )

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findAllByText(/^Created /)

    const [showFirst, showSecond] = screen.getAllByRole('button', {
      name: /^Show join link/,
    })
    fireEvent.click(showFirst as HTMLElement)
    await screen.findByText(/secret-for-link-1/)

    fireEvent.click(showSecond as HTMLElement)
    await screen.findByText(/secret-for-link-2/)
    expect(screen.queryByText(/secret-for-link-1/)).not.toBeInTheDocument()
  })

  // The same property, proven the other way: an explicit "Hide" clears the
  // revealed secret from the DOM without revealing anything else.
  it('hiding a revealed secret removes it from the DOM, and the reveal control returns', async () => {
    listCourseJoinLinks.mockResolvedValue([link({ id: 'link-1' })])
    revealCourseJoinLink.mockResolvedValue({ secret: 'the-revealed-secret' })

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText(/^Created /)
    fireEvent.click(screen.getByRole('button', { name: /^Show join link/ }))
    await screen.findByTestId('revealed-join-link-url')

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))

    expect(
      screen.queryByTestId('revealed-join-link-url')
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^Show join link/ })
    ).toBeInTheDocument()
  })

  // The revealed secret does not survive an unmount either — a fresh mount
  // (standing in for navigating away and back, the same precedent
  // `join-links.test.tsx`'s own "a fresh mount never shows a secret" case
  // already uses for `created`) starts with nothing revealed, even though
  // the underlying link is still just as revealable.
  it('a fresh mount after revealing never shows the previously revealed secret', async () => {
    listCourseJoinLinks.mockResolvedValue([link({ id: 'link-1' })])
    revealCourseJoinLink.mockResolvedValue({ secret: 'the-revealed-secret' })

    const first = renderWithModal(
      <JoinLinks organizationId="org-1" courseId="course-1" />
    )
    await screen.findByText(/^Created /)
    fireEvent.click(screen.getByRole('button', { name: /^Show join link/ }))
    await screen.findByTestId('revealed-join-link-url')
    first.unmount()

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText(/^Created /)

    expect(
      screen.queryByTestId('revealed-join-link-url')
    ).not.toBeInTheDocument()
  })

  it('a clipboard that cannot be reached is reported for a revealed secret too, which stays visible to copy by hand', async () => {
    listCourseJoinLinks.mockResolvedValue([link({ id: 'link-1' })])
    revealCourseJoinLink.mockResolvedValue({ secret: 'the-revealed-secret' })
    Object.assign(navigator, { clipboard: undefined })

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText(/^Created /)
    fireEvent.click(screen.getByRole('button', { name: /^Show join link/ }))
    await screen.findByTestId('revealed-join-link-url')

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not copy the link — copy it from the text above by hand.'
    )
    expect(screen.getByTestId('revealed-join-link-url')).toHaveTextContent(
      '/join/the-revealed-secret'
    )
  })

  it('a refused reveal renders the same ErrorMessage every other refusal in this app uses', async () => {
    listCourseJoinLinks.mockResolvedValue([link({ id: 'link-1' })])
    revealCourseJoinLink.mockRejectedValue(
      new ApiError(404, { error: 'action_refused' })
    )

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText(/^Created /)
    fireEvent.click(screen.getByRole('button', { name: /^Show join link/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })
})

// WEB-23: an instructor chooses an expiry when issuing a link — defaulting
// to none, so today's behaviour (the block above) is what an instructor
// gets by not choosing at all.
describe('JoinLinks expiry (WEB-23/ENRL-17)', () => {
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

    // Exactly two arguments — no `expiresIn`, not even `undefined` — so a
    // link issued without touching the new control redeems forever, same as
    // before this slice.
    await waitFor(() =>
      expect(createCourseJoinLink).toHaveBeenCalledWith('org-1', 'course-1')
    )
  })

  // ENRL-17: this panel no longer computes a timestamp itself — it sends the
  // chosen option's own *name*, and `courseJoinLinks.create`'s own `execute`
  // resolves it against the clock on the server, at the moment the link is
  // actually created (`packages/actions/tests/course-join-links.test.ts`'s
  // own coverage of that resolution). Fails without the fix: before
  // `expiresIn` existed, this control sent a client-computed absolute
  // timestamp as its third argument instead of the string `'1w'`.
  it.each(['1d', '1w', '1mo', '1term'] as const)(
    'choosing "%s" sends that same value as expiresIn, not a computed timestamp',
    async (value) => {
      listCourseJoinLinks.mockResolvedValue([])
      createCourseJoinLink.mockResolvedValue({
        linkId: 'link-1',
        secret: 'the-secret-value',
        expiresAt: null,
      })

      renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
      await screen.findByText('No join links issued yet.')
      fireEvent.change(screen.getByLabelText('Expiry'), {
        target: { value },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Create join link' }))

      await waitFor(() =>
        expect(createCourseJoinLink).toHaveBeenCalledWith(
          'org-1',
          'course-1',
          value
        )
      )
    }
  )

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
