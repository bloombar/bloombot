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
