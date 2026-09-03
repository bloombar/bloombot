/**
 * WEB-10: `pages/Chat.tsx` — the not-connected state reads as an
 * invitation, not an error, and is distinct from "connected, but genuinely
 * enrolled in nothing" (`routes/chat.ts`'s own module comment on the
 * rework this file follows).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { ChatAnswerResult } from '../src/api/types.js'
import { Chat } from '../src/pages/Chat.js'

// WEB-24's own tests (below) additionally mock `getChatMessages` and
// `postChatMessage` — the pre-existing tests above only ever mocked
// `listChatCourses`, since they never depend on when the (real, unmocked)
// `getChatMessages` call resolves; the scroll tests do, so they get
// deterministic control over it.
const { listChatCourses, getChatMessages, postChatMessage } = vi.hoisted(
  () => ({
    listChatCourses: vi.fn(),
    getChatMessages: vi.fn(),
    postChatMessage: vi.fn(),
  })
)

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, listChatCourses, getChatMessages, postChatMessage }
})

// WEB-24 — `getChatMessages`/`postChatMessage` now being mocked (above)
// means every test needs *some* resolved value for them, not only the ones
// that care what it is: `Chat.tsx#loadMessages` calls `getChatMessages(...)
// .then(...)` unconditionally once a course is selected, and a bare
// `vi.fn()` with no configured implementation returns `undefined`, not a
// promise — `.then` on that throws before any pre-existing test below even
// gets to its own assertion. An empty transcript is a harmless default
// every pre-existing test can render past unnoticed; the WEB-24 tests
// further down override it with their own values.
beforeEach(() => {
  getChatMessages.mockResolvedValue([])
  postChatMessage.mockResolvedValue({
    kind: 'answered',
    conversationId: 'stub-conversation',
    text: 'stub reply',
  })
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

/**
 * WEB-24 — the thread's own scroll behaviour, at the level jsdom can
 * actually prove. jsdom never lays out real content: `scrollHeight`,
 * `clientHeight` and `scrollTop` read as `0`/writable-but-inert on every
 * element unless a test overrides them directly (`Object.defineProperty`,
 * below), and nothing here can observe whether the *page itself* scrolled
 * versus the thread `<div>` — that needs a real browser laying out real
 * pixels, which is `e2e/chat.spec.ts`'s job, not this file's. What these
 * tests do prove, deterministically: `pages/Chat.tsx` sets the thread
 * container's own `scrollTop` to its `scrollHeight` — the imperative action
 * "scroll the thread to its newest message" actually means in code — on
 * the student's own send and on a reply that arrives while the reader was
 * near the bottom; and it does *not* touch `scrollTop` when a reply arrives
 * while the reader had scrolled away, showing the "New messages" affordance
 * instead.
 */
describe('Chat — thread scroll behaviour (WEB-24)', () => {
  beforeEach(() => {
    listChatCourses.mockResolvedValue([
      { id: 'course-1', title: 'Intro to Testing' },
    ])
  })

  it('sending a message scrolls the thread to its newest message — fails without the fix (no maximum height meant nothing needed scrolling)', async () => {
    getChatMessages.mockResolvedValue([])

    render(<Chat organizationId="org-1" />)
    const thread = await screen.findByTestId('chat-thread')
    // Simulated overflow — see this file's own module comment above on why
    // jsdom needs this before `scrollTop`/`scrollHeight` mean anything.
    Object.defineProperty(thread, 'scrollHeight', {
      value: 4000,
      configurable: true,
    })
    expect(thread.scrollTop).toBe(0)

    fireEvent.change(screen.getByLabelText('Ask a question'), {
      target: { value: 'When is the midterm?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    // Fails without the fix: the previous `scrollIntoView({ block: 'end' })`
    // call targeted an end-of-thread marker `<div>`, not the thread
    // container's own `scrollTop` — this assertion reads that container
    // directly and would stay `0` under the old implementation even though
    // jsdom's own stub `scrollIntoView` silently no-ops either way.
    await waitFor(() => expect(thread.scrollTop).toBe(4000))
  })

  it('a reply arriving while the reader is at the bottom scrolls the thread again, not only for the student’s own message', async () => {
    getChatMessages.mockResolvedValue([])
    let resolvePost: (result: ChatAnswerResult) => void = () => {
      throw new Error('resolvePost not assigned yet')
    }
    postChatMessage.mockImplementation(
      () =>
        new Promise<ChatAnswerResult>((resolve) => {
          resolvePost = resolve
        })
    )

    render(<Chat organizationId="org-1" />)
    const thread = await screen.findByTestId('chat-thread')
    Object.defineProperty(thread, 'scrollHeight', {
      value: 100,
      configurable: true,
    })

    fireEvent.change(screen.getByLabelText('Ask a question'), {
      target: { value: 'Hi' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(thread.scrollTop).toBe(100))

    // The transcript grows again once the reply lands — a taller thread
    // than the student's own message alone produced. If the effect only
    // ever ran once (a defect this test would also catch), `scrollTop`
    // would stay at the first value instead of following here too.
    Object.defineProperty(thread, 'scrollHeight', {
      value: 260,
      configurable: true,
    })
    resolvePost({
      kind: 'answered',
      conversationId: 'conv-1',
      text: 'The midterm is in week 8.',
    })

    await waitFor(() => expect(thread.scrollTop).toBe(260))
    expect(screen.queryByTestId('new-messages-button')).not.toBeInTheDocument()
  })

  it('a reply arriving while the reader has scrolled up does not move them — and tells them instead', async () => {
    getChatMessages.mockResolvedValue([])
    let resolvePost: (result: ChatAnswerResult) => void = () => {
      throw new Error('resolvePost not assigned yet')
    }
    postChatMessage.mockImplementation(
      () =>
        new Promise<ChatAnswerResult>((resolve) => {
          resolvePost = resolve
        })
    )

    render(<Chat organizationId="org-1" />)
    const thread = await screen.findByTestId('chat-thread')
    Object.defineProperty(thread, 'scrollHeight', {
      value: 100,
      configurable: true,
    })
    Object.defineProperty(thread, 'clientHeight', {
      value: 40,
      configurable: true,
    })

    fireEvent.change(screen.getByLabelText('Ask a question'), {
      target: { value: 'Hi' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(thread.scrollTop).toBe(100))
    expect(screen.queryByTestId('new-messages-button')).not.toBeInTheDocument()

    // The reader scrolls back up to reread something while the reply is
    // still in flight — `pages/Chat.tsx`'s own `onScroll` handler is what
    // reads this back into `isNearBottomRef`.
    thread.scrollTop = 0
    fireEvent.scroll(thread)

    Object.defineProperty(thread, 'scrollHeight', {
      value: 260,
      configurable: true,
    })
    resolvePost({
      kind: 'answered',
      conversationId: 'conv-1',
      text: 'The midterm is in week 8.',
    })

    // Fails without the fix: an unconditional auto-scroll would move
    // `thread.scrollTop` to `260` the moment the reply's `setMessages` call
    // runs, regardless of where the reader had scrolled.
    const jumpButton = await screen.findByTestId('new-messages-button')
    expect(thread.scrollTop).toBe(0)
    expect(jumpButton.closest('[role="status"]')).not.toBeNull()

    fireEvent.click(jumpButton)

    await waitFor(() => expect(thread.scrollTop).toBe(260))
    expect(screen.queryByTestId('new-messages-button')).not.toBeInTheDocument()
  })
})
