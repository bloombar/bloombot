/**
 * WEB-10: `pages/Chat.tsx` — the not-connected state reads as an
 * invitation, not an error, and is distinct from "connected, but genuinely
 * enrolled in nothing" (`routes/chat.ts`'s own module comment on the
 * rework this file follows).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import { Chat } from '../src/pages/Chat.js'

const { listChatCourses } = vi.hoisted(() => ({
  listChatCourses: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, listChatCourses }
})

afterEach(() => {
  vi.resetAllMocks()
})

describe('Chat (WEB-10)', () => {
  it('an unconnected account sees an invitation, not an error banner', async () => {
    listChatCourses.mockRejectedValue(
      new ApiError(404, { error: 'chat_not_connected' })
    )

    render(<Chat organizationId="org-1" />)

    expect(
      await screen.findByText(/not connected to a course here yet/)
    ).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // LINK-6/7 — the invitation is now a real link to `pages/Connect.tsx`,
  // for this same organization, not merely advice to find an instructor.
  it('an unconnected account can navigate straight to the connect screen for this organization', async () => {
    listChatCourses.mockRejectedValue(
      new ApiError(404, { error: 'chat_not_connected' })
    )
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign },
      writable: true,
    })

    render(<Chat organizationId="org-1" />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Connect your account' })
    )

    expect(assign).toHaveBeenCalledWith('/connect/org-1')
  })

  it('a connected account with no enrolments sees the distinct "not enrolled" message, not the connect invitation', async () => {
    listChatCourses.mockResolvedValue([])

    render(<Chat organizationId="org-1" />)

    expect(
      await screen.findByText(/not enrolled in a course here yet/)
    ).toBeInTheDocument()
  })

  it('lists the courses this account may ask', async () => {
    listChatCourses.mockResolvedValue([
      { id: 'course-1', title: 'Intro to Testing' },
    ])

    render(<Chat organizationId="org-1" />)

    await waitFor(() =>
      expect(screen.getByText('Intro to Testing')).toBeInTheDocument()
    )
  })

  it('any other refusal still renders through the ordinary ErrorMessage', async () => {
    listChatCourses.mockRejectedValue(
      new ApiError(500, { error: 'internal_error' })
    )

    render(<Chat organizationId="org-1" />)

    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})

// WEB-25: redemption confirms itself, names the course, and lands the
// student in chat with it already selected — `pages/JoinLink.tsx` discarded
// all three before this rework (that page's own module comment); `Shell.tsx`
// wires the server's own answer into `initialCourseId`/`joinConfirmation`,
// proven here directly against `Chat` itself.
describe('Chat — join-link confirmation (WEB-25)', () => {
  it('a fresh join preselects the joined course and confirms it by title, announced to a screen reader', async () => {
    listChatCourses.mockResolvedValue([
      { id: 'course-1', title: 'Intro to Testing' },
      { id: 'course-2', title: 'Advanced Testing' },
    ])

    render(
      <Chat
        organizationId="org-1"
        initialCourseId="course-2"
        joinConfirmation={{ alreadyEnrolled: false }}
      />
    )

    // Fails without the fix: `selectedCourseId` used to always default to
    // the *first* course the list happened to return (`course-1`), not the
    // one this redemption actually named.
    expect(await screen.findByRole('combobox', { name: 'Course' })).toHaveValue(
      'course-2'
    )
    const status = await screen.findByTestId('join-confirmation')
    expect(status).toHaveAttribute('role', 'status')
    expect(status).toHaveTextContent("You're enrolled in Advanced Testing.")
  })

  // Rework finding (must-fix) — reproduced exactly as reported: a student
  // already enrolled in a second course redeems a link for the one named
  // here, then switches the picker to check the other course. The banner,
  // which has no dismissal, must keep naming the *joined* course, not
  // whichever one the switch just selected — fails without the fix, since
  // the banner used to derive its title from `selectedCourseId` (the same
  // state the picker's own `onChange` rewrites), asserting a fresh-join
  // claim about a course the student has actually been in for weeks.
  it('switching the course picker away from the joined course does not change who the banner names', async () => {
    listChatCourses.mockResolvedValue([
      { id: 'course-1', title: 'Intro to Testing' },
      { id: 'course-2', title: 'Advanced Testing' },
    ])

    render(
      <Chat
        organizationId="org-1"
        initialCourseId="course-2"
        joinConfirmation={{ alreadyEnrolled: false }}
      />
    )

    await screen.findByTestId('join-confirmation')
    fireEvent.change(screen.getByRole('combobox', { name: 'Course' }), {
      target: { value: 'course-1' },
    })

    expect(screen.getByRole('combobox', { name: 'Course' })).toHaveValue(
      'course-1'
    )
    expect(screen.getByTestId('join-confirmation')).toHaveTextContent(
      "You're enrolled in Advanced Testing."
    )
  })

  // ENRL-8/WEB-25: redeeming twice is a confirmation, not an error — this is
  // what distinguishes it in the browser, the same way `alreadyEnrolled`
  // distinguishes it over HTTP (`apps/api/tests/routes/join-links.test.ts`).
  it('an already-enrolled redemption says so, plainly, rather than the fresh-join wording', async () => {
    listChatCourses.mockResolvedValue([
      { id: 'course-1', title: 'Intro to Testing' },
    ])

    render(
      <Chat
        organizationId="org-1"
        initialCourseId="course-1"
        joinConfirmation={{ alreadyEnrolled: true }}
      />
    )

    expect(await screen.findByTestId('join-confirmation')).toHaveTextContent(
      "You're already enrolled in Intro to Testing."
    )
  })

  // Confirmation "does not depend on the student noticing something that
  // disappears on its own" (`docs/SPEC.md`'s own WEB-25) — still present
  // after the transcript itself has loaded and rendered, not merely on the
  // first paint.
  it('the confirmation is still present once the rest of the screen has finished loading', async () => {
    listChatCourses.mockResolvedValue([
      { id: 'course-1', title: 'Intro to Testing' },
    ])

    render(
      <Chat
        organizationId="org-1"
        initialCourseId="course-1"
        joinConfirmation={{ alreadyEnrolled: false }}
      />
    )

    await screen.findByTestId('chat-thread')
    expect(screen.getByTestId('join-confirmation')).toBeInTheDocument()
  })

  it('no joinConfirmation prop, no banner — the ordinary case', async () => {
    listChatCourses.mockResolvedValue([
      { id: 'course-1', title: 'Intro to Testing' },
    ])

    render(<Chat organizationId="org-1" />)

    await screen.findByText('Intro to Testing')
    expect(screen.queryByTestId('join-confirmation')).not.toBeInTheDocument()
  })
})
