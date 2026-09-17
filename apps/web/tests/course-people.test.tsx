/**
 * `components/CoursePeople.tsx` (WEB-22, WEB-52): the screen a course's
 * people were missing entirely. Every case below is what that component's
 * own module comment promises: two distinct lists (never one status
 * column), how each person was admitted, ending behind a confirmation
 * stating both halves of ENRL-6, reinstating (ENRL-9) with no confirmation
 * at all, and — since WEB-52 — a name, an email and a Discord display name
 * shown wherever known, falling back to the bare person id only when all
 * three are unknown.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { CourseEnrolment } from '../src/api/types.js'
import { CoursePeople } from '../src/components/CoursePeople.js'
import { useNavigationGuard } from '../src/hooks/navigation-guard.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const { listCourseEnrolments, endCourseEnrolment, reinstateCourseEnrolment } =
  vi.hoisted(() => ({
    listCourseEnrolments: vi.fn(),
    endCourseEnrolment: vi.fn(),
    reinstateCourseEnrolment: vi.fn(),
  }))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    listCourseEnrolments,
    endCourseEnrolment,
    reinstateCourseEnrolment,
  }
})

function entry(overrides: Partial<CourseEnrolment> = {}): CourseEnrolment {
  return {
    id: 'enrolment-1',
    personId: 'person-1',
    displayName: 'Ada Lovelace',
    email: null,
    firstName: null,
    lastName: null,
    source: 'roster',
    createdAt: Date.now(),
    endedAt: null,
    reinstatedByAccountId: null,
    reinstatedAt: null,
    ...overrides,
  }
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('CoursePeople (WEB-22)', () => {
  it('shows the empty state for both lists when a course has no enrolments', async () => {
    listCourseEnrolments.mockResolvedValue([])

    renderWithModal(
      <CoursePeople
        organizationId="org-1"
        courseId="course-1"
        navigate={vi.fn()}
      />
    )

    expect(
      await screen.findByText('Nobody is enrolled yet.')
    ).toBeInTheDocument()
    expect(
      screen.getByText("Nobody's enrolment has ended.")
    ).toBeInTheDocument()
  })

  it('lists an active enrolment under "Enrolled", with how it was admitted, and offers only End', async () => {
    listCourseEnrolments.mockResolvedValue([
      entry({ id: 'e1', source: 'discord_role' }),
    ])

    renderWithModal(
      <CoursePeople
        organizationId="org-1"
        courseId="course-1"
        navigate={vi.fn()}
      />
    )

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText(/Discord role/)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: "End Ada Lovelace's enrolment" })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: "Reinstate Ada Lovelace's enrolment",
      })
    ).not.toBeInTheDocument()
  })

  it('lists an ended enrolment under "Enrolment ended", with how it was admitted, and offers only Reinstate', async () => {
    listCourseEnrolments.mockResolvedValue([
      entry({ id: 'e1', source: 'join_link', endedAt: Date.now() }),
    ])

    renderWithModal(
      <CoursePeople
        organizationId="org-1"
        courseId="course-1"
        navigate={vi.fn()}
      />
    )

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText(/Join link/)).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: "Reinstate Ada Lovelace's enrolment",
      })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: "End Ada Lovelace's enrolment" })
    ).not.toBeInTheDocument()
  })

  // WEB-52: the bare person id is the very last resort — shown only when
  // name, email and Discord name are all unknown.
  it('falls back to the person id only when name, email and Discord name are all null', async () => {
    listCourseEnrolments.mockResolvedValue([
      entry({ id: 'e1', personId: 'person-42', displayName: null }),
    ])

    renderWithModal(
      <CoursePeople
        organizationId="org-1"
        courseId="course-1"
        navigate={vi.fn()}
      />
    )

    expect(await screen.findByText('person-42')).toBeInTheDocument()
  })

  // WEB-52: a full name is the primary line, and the secondary line shows
  // email, Discord name and how/when the person joined — each labelled,
  // nothing repeated between the two lines.
  it('shows a full name as the primary line, and email/Discord/source-and-time on the secondary line', async () => {
    const createdAt = new Date('2026-09-16T14:03:00Z').getTime()
    listCourseEnrolments.mockResolvedValue([
      entry({
        id: 'e1',
        displayName: 'janed',
        email: 'jane@x.edu',
        firstName: 'Jane',
        lastName: 'Doe',
        source: 'join_link',
        createdAt,
      }),
    ])

    renderWithModal(
      <CoursePeople
        organizationId="org-1"
        courseId="course-1"
        navigate={vi.fn()}
      />
    )

    expect(await screen.findByText('Jane Doe')).toBeInTheDocument()
    const secondary = screen.getByText(/Join link/)
    expect(secondary).toHaveTextContent('jane@x.edu')
    expect(secondary).toHaveTextContent('Discord: janed')
    expect(secondary).toHaveTextContent('Join link')
  })

  // WEB-52: when no name is known, email becomes the primary line — and is
  // then omitted from the secondary line rather than repeated.
  it('uses email as the primary line when no name is known, without repeating it on the secondary line', async () => {
    listCourseEnrolments.mockResolvedValue([
      entry({
        id: 'e1',
        displayName: 'janed',
        email: 'jane@x.edu',
        firstName: null,
        lastName: null,
      }),
    ])

    renderWithModal(
      <CoursePeople
        organizationId="org-1"
        courseId="course-1"
        navigate={vi.fn()}
      />
    )

    const link = await screen.findByRole('link', { name: 'jane@x.edu' })
    expect(link).toBeInTheDocument()
    const secondary = screen.getByText(/Roster import/)
    expect(secondary).not.toHaveTextContent('jane@x.edu')
    expect(secondary).toHaveTextContent('Discord: janed')
  })

  it('ending confirms first, stating both halves of ENRL-6 — cancelling calls nothing', async () => {
    listCourseEnrolments.mockResolvedValue([entry({ id: 'e1' })])

    renderWithModal(
      <CoursePeople
        organizationId="org-1"
        courseId="course-1"
        navigate={vi.fn()}
      />
    )
    await screen.findByText('Ada Lovelace')

    fireEvent.click(
      screen.getByRole('button', { name: "End Ada Lovelace's enrolment" })
    )
    const dialog = await screen.findByRole('dialog', {
      name: "End Ada Lovelace's enrolment?",
    })
    expect(dialog).toHaveTextContent('This stops them asking this course')
    expect(dialog).toHaveTextContent('does not delete their transcript')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(endCourseEnrolment).not.toHaveBeenCalled()
  })

  it('ending, confirmed, dispatches enrolments.end and the person moves to "Enrolment ended"', async () => {
    listCourseEnrolments
      .mockResolvedValueOnce([entry({ id: 'e1', endedAt: null })])
      .mockResolvedValueOnce([entry({ id: 'e1', endedAt: Date.now() })])
    endCourseEnrolment.mockResolvedValue({ ended: true })

    renderWithModal(
      <CoursePeople
        organizationId="org-1"
        courseId="course-1"
        navigate={vi.fn()}
      />
    )
    await screen.findByText('Ada Lovelace')

    fireEvent.click(
      screen.getByRole('button', { name: "End Ada Lovelace's enrolment" })
    )
    const dialog = await screen.findByRole('dialog', {
      name: "End Ada Lovelace's enrolment?",
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'End enrolment' })
    )

    await waitFor(() =>
      expect(endCourseEnrolment).toHaveBeenCalledWith('org-1', 'e1')
    )
    expect(
      await screen.findByRole('button', {
        name: "Reinstate Ada Lovelace's enrolment",
      })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: "End Ada Lovelace's enrolment" })
    ).not.toBeInTheDocument()
    // WEB-22: the sr-only live region announces what the row's own move
    // already tells a sighted user — the one thing a screen reader has no
    // other way to learn from this screen's re-render (`CoursePeople.tsx`'s
    // own module comment on why `sr-only` rather than a visible banner).
    expect(screen.getByRole('status')).toHaveTextContent(
      "Ended Ada Lovelace's enrolment."
    )
  })

  // ENRL-9: reinstating grants access back, so it runs with no confirmation
  // at all — unlike ending, there is no dialog to find here.
  it('reinstating dispatches enrolments.reinstate immediately, with no confirmation, and the person moves back to "Enrolled"', async () => {
    listCourseEnrolments
      .mockResolvedValueOnce([entry({ id: 'e1', endedAt: Date.now() })])
      .mockResolvedValueOnce([entry({ id: 'e1', endedAt: null })])
    reinstateCourseEnrolment.mockResolvedValue({ reinstated: true })

    renderWithModal(
      <CoursePeople
        organizationId="org-1"
        courseId="course-1"
        navigate={vi.fn()}
      />
    )
    await screen.findByText('Ada Lovelace')

    fireEvent.click(
      screen.getByRole('button', {
        name: "Reinstate Ada Lovelace's enrolment",
      })
    )

    await waitFor(() =>
      expect(reinstateCourseEnrolment).toHaveBeenCalledWith('org-1', 'e1')
    )
    expect(
      await screen.findByRole('button', {
        name: "End Ada Lovelace's enrolment",
      })
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      "Reinstated Ada Lovelace's enrolment."
    )
  })

  it('a refused end renders the same ErrorMessage every other refusal in this app uses', async () => {
    listCourseEnrolments.mockResolvedValue([entry({ id: 'e1' })])
    endCourseEnrolment.mockRejectedValue(
      new ApiError(404, { error: 'action_refused' })
    )

    renderWithModal(
      <CoursePeople
        organizationId="org-1"
        courseId="course-1"
        navigate={vi.fn()}
      />
    )
    await screen.findByText('Ada Lovelace')

    fireEvent.click(
      screen.getByRole('button', { name: "End Ada Lovelace's enrolment" })
    )
    const dialog = await screen.findByRole('dialog', {
      name: "End Ada Lovelace's enrolment?",
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'End enrolment' })
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })

  // WEB-36: every row's own name is a real link to that person's transcript
  // for this course, in both lists — ending an enrolment never deleted the
  // transcript (ENRL-6), and reading it afterwards is the point.
  it('links an enrolled person’s name to their transcript, with a real href, and navigates in-app on click', async () => {
    listCourseEnrolments.mockResolvedValue([entry({ id: 'e1' })])
    const navigate = vi.fn()

    renderWithModal(
      <CoursePeople
        organizationId="org-1"
        courseId="course-1"
        navigate={navigate}
      />
    )

    const link = await screen.findByRole('link', { name: 'Ada Lovelace' })
    expect(link).toHaveAttribute(
      'href',
      '/o/org-1/transcripts/course-1/person-1'
    )

    fireEvent.click(link)

    expect(navigate).toHaveBeenCalledWith({
      kind: 'transcripts',
      organizationId: 'org-1',
      courseId: 'course-1',
      personId: 'person-1',
    })
  })

  it('links an ended enrolment’s name to their transcript exactly the same way', async () => {
    listCourseEnrolments.mockResolvedValue([
      entry({ id: 'e1', endedAt: Date.now() }),
    ])
    const navigate = vi.fn()

    renderWithModal(
      <CoursePeople
        organizationId="org-1"
        courseId="course-1"
        navigate={navigate}
      />
    )

    const link = await screen.findByRole('link', { name: 'Ada Lovelace' })
    expect(link).toHaveAttribute(
      'href',
      '/o/org-1/transcripts/course-1/person-1'
    )

    fireEvent.click(link)

    expect(navigate).toHaveBeenCalledWith({
      kind: 'transcripts',
      organizationId: 'org-1',
      courseId: 'course-1',
      personId: 'person-1',
    })
  })

  // A modified click (here, a held Ctrl — the same as Cmd on macOS) is left
  // entirely to the browser's own "open in a new tab" handling —
  // `TranscriptLink`'s own comment (`components/CoursePeople.tsx`) on why
  // intercepting it would be wrong.
  it('does not intercept a modified click — the browser handles it, not navigate', async () => {
    listCourseEnrolments.mockResolvedValue([entry({ id: 'e1' })])
    const navigate = vi.fn()

    renderWithModal(
      <CoursePeople
        organizationId="org-1"
        courseId="course-1"
        navigate={navigate}
      />
    )

    const link = await screen.findByRole('link', { name: 'Ada Lovelace' })
    fireEvent.click(link, { ctrlKey: true })

    expect(navigate).not.toHaveBeenCalled()
  })

  // Notes, rework round 1 — nothing asserted `preventDefault` itself either
  // way; a plain click has to call it (otherwise the browser's own default
  // navigation fires alongside the in-app one — jsdom's own "Not
  // implemented: navigation to another Document" warning is exactly that),
  // and a modified click must not (or the browser could never open the new
  // tab a Ctrl/Cmd-click promises).
  it('calls preventDefault on a plain click, and not on a modified one', async () => {
    listCourseEnrolments.mockResolvedValue([entry({ id: 'e1' })])

    renderWithModal(
      <CoursePeople
        organizationId="org-1"
        courseId="course-1"
        navigate={vi.fn()}
      />
    )

    const link = await screen.findByRole('link', { name: 'Ada Lovelace' })

    const plainEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    })
    const plainPreventDefault = vi.spyOn(plainEvent, 'preventDefault')
    fireEvent(link, plainEvent)
    expect(plainPreventDefault).toHaveBeenCalled()

    const modifiedEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    })
    const modifiedPreventDefault = vi.spyOn(modifiedEvent, 'preventDefault')
    fireEvent(link, modifiedEvent)
    expect(modifiedPreventDefault).not.toHaveBeenCalled()
  })

  // WEB-16 (rework round 1) — the real defect this rework found: a raw
  // `navigate` call unmounts `pages/CourseEditor.tsx` immediately, so an
  // edit on its General tab, never saved, was silently gone the moment a
  // click here landed on the People tab. Every navigation this component
  // starts must go through the same registered guard the rest of the shell
  // already consults (`hooks/navigation-guard.tsx`) before it ever calls
  // the `navigate` prop.
  describe('routes the transcript link through the unsaved-changes guard (WEB-16)', () => {
    // Registers a guard in the same `NavigationGuardProvider` tree
    // `renderWithModal` already wraps `CoursePeople` in — a sibling, not a
    // prop, the same way `pages/CourseEditor.tsx` itself registers one via
    // `useUnsavedChangesGuard`.
    function GuardHarness({ guardResult }: { guardResult: boolean }) {
      const { registerGuard } = useNavigationGuard()
      return (
        <button
          type="button"
          onClick={() => registerGuard(() => Promise.resolve(guardResult))}
        >
          register dirty guard
        </button>
      )
    }

    it('a registered guard that resolves false blocks the navigation', async () => {
      listCourseEnrolments.mockResolvedValue([entry({ id: 'e1' })])
      const navigate = vi.fn()

      renderWithModal(
        <>
          <GuardHarness guardResult={false} />
          <CoursePeople
            organizationId="org-1"
            courseId="course-1"
            navigate={navigate}
          />
        </>
      )

      fireEvent.click(
        screen.getByRole('button', { name: 'register dirty guard' })
      )
      const link = await screen.findByRole('link', { name: 'Ada Lovelace' })
      fireEvent.click(link)

      // The guard's own promise gets a tick to resolve — it never should
      // result in a call either way, but this proves the assertion is not
      // just racing an unresolved promise (the same discipline
      // `tests/navigation-guard.test.tsx` already holds itself to).
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(navigate).not.toHaveBeenCalled()
    })

    it('a registered guard that resolves true allows the navigation', async () => {
      listCourseEnrolments.mockResolvedValue([entry({ id: 'e1' })])
      const navigate = vi.fn()

      renderWithModal(
        <>
          <GuardHarness guardResult={true} />
          <CoursePeople
            organizationId="org-1"
            courseId="course-1"
            navigate={navigate}
          />
        </>
      )

      fireEvent.click(
        screen.getByRole('button', { name: 'register dirty guard' })
      )
      const link = await screen.findByRole('link', { name: 'Ada Lovelace' })
      fireEvent.click(link)

      await waitFor(() =>
        expect(navigate).toHaveBeenCalledWith({
          kind: 'transcripts',
          organizationId: 'org-1',
          courseId: 'course-1',
          personId: 'person-1',
        })
      )
    })

    it('with no guard registered, the navigation runs immediately, exactly as before', async () => {
      listCourseEnrolments.mockResolvedValue([entry({ id: 'e1' })])
      const navigate = vi.fn()

      renderWithModal(
        <CoursePeople
          organizationId="org-1"
          courseId="course-1"
          navigate={navigate}
        />
      )

      const link = await screen.findByRole('link', { name: 'Ada Lovelace' })
      fireEvent.click(link)

      expect(navigate).toHaveBeenCalledWith({
        kind: 'transcripts',
        organizationId: 'org-1',
        courseId: 'course-1',
        personId: 'person-1',
      })
    })
  })
})
