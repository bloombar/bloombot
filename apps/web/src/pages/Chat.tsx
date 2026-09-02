/**
 * WEB-10: hold a conversation with a course's assistant in the browser —
 * pick a course from the ones this account is enrolled in (ENRL-2: "a
 * student chooses among the courses they are already eligible for"), see
 * its transcript, and ask it something. Every reply is rendered through
 * `ChatMessage.tsx`'s own sanitized Markdown, never trusted as HTML.
 *
 * `AnswerResult`'s non-`answered` kinds (`declined-over-limit`,
 * `course-disabled`, ...) carry no text of their own — `@bloombot/core`'s
 * own module comment on `AnswerResult` says the wording is each surface's
 * job — so `describeDeclineNotice` below is this surface's own wording,
 * shown as a plain notice rather than a message bubble neither side
 * actually said.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ApiError,
  getChatMessages,
  listChatCourses,
  postChatMessage,
} from '../api/client.js'
import type {
  ChatAnswerResult,
  ChatCourse,
  ChatMessageEntry,
} from '../api/types.js'
import { Button } from '../components/Button.js'
import { ChatMessage } from '../components/ChatMessage.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { SendIcon } from '../icons.js'

export interface ChatProps {
  organizationId: string
}

/**
 * A refusal `answerQuestion` reports as a *kind*, not an error — WEB-10's
 * own surface has to say something in its place, since none of these carry
 * text. Only ever called for a *non-answered* kind (`Chat.tsx`'s own
 * `handleSend` already branches `answered`/`answered-last-request`/
 * `failed-with-apology` — every kind that carries a reply — away before
 * this runs), so the exhaustiveness check below covers exactly the
 * remaining, textless kinds.
 *
 * The `never` assignment is deliberate, not decorative: before it existed,
 * `default: return undefined` silently swallowed any kind this function had
 * not been taught about — `not-connected` (LINK-1, merged after this
 * surface was first built) reached here, got no notice and no reply, and a
 * student watched their own message post and then nothing happen at all. A
 * kind this function does not name is now a compile error, not a blank
 * screen. In practice `routes/chat.ts` refuses an unconnected caller before
 * `answerQuestion` ever runs (that file's own module comment), so this
 * particular case should be unreachable from this route — the branch stays
 * here anyway, for the same reason every other "unreachable in practice"
 * guard in this codebase does: defended, not assumed.
 */
function describeDeclineNotice(kind: ChatAnswerResult['kind']): string {
  switch (kind) {
    case 'declined-over-limit':
      return 'You have reached the maximum number of questions for today.'
    case 'declined-over-cap':
      return 'This course is unable to answer right now. See your course staff for help.'
    case 'declined-busy':
      return 'Bloombot is busy right now. Please try again shortly.'
    case 'course-disabled':
      return 'This course is not currently accepting questions.'
    case 'not-configured':
      return 'This course has not been set up to answer questions yet.'
    case 'not-connected':
      return 'Your account is not connected here yet. Ask your instructor for help connecting it.'
    case 'answered':
    case 'answered-last-request':
    case 'failed-with-apology':
      // Handled by `handleSend` before this function is ever called for
      // one of these — see this function's own doc comment.
      return 'Something went wrong.'
    default: {
      const exhaustive: never = kind
      throw new Error(
        `describeDeclineNotice: unhandled kind ${String(exhaustive)}`
      )
    }
  }
}

export function Chat({ organizationId }: ChatProps) {
  const [courses, setCourses] = useState<ChatCourse[] | undefined>(undefined)
  const [coursesError, setCoursesError] = useState<ApiError | undefined>(
    undefined
  )
  const [selectedCourseId, setSelectedCourseId] = useState<string | undefined>(
    undefined
  )
  const [messages, setMessages] = useState<ChatMessageEntry[] | undefined>(
    undefined
  )
  const [messagesError, setMessagesError] = useState<ApiError | undefined>(
    undefined
  )
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const threadEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setCourses(undefined)
    setCoursesError(undefined)
    listChatCourses(organizationId).then(
      (result) => {
        setCourses(result)
        setSelectedCourseId((current) => current ?? result[0]?.id)
      },
      (caught: unknown) => {
        if (caught instanceof ApiError) setCoursesError(caught)
        else throw caught
      }
    )
  }, [organizationId])

  const loadMessages = useCallback(() => {
    if (!selectedCourseId) return
    setMessages(undefined)
    setMessagesError(undefined)
    getChatMessages(organizationId, selectedCourseId).then(
      (result) => setMessages(result),
      (caught: unknown) => {
        if (caught instanceof ApiError) setMessagesError(caught)
        else throw caught
      }
    )
  }, [organizationId, selectedCourseId])

  useEffect(() => {
    loadMessages()
  }, [loadMessages])

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  const handleSend = async () => {
    const text = draft.trim()
    if (!text || !selectedCourseId) return
    setNotice(undefined)
    setMessagesError(undefined)
    setSending(true)
    // Optimistic: the student's own message appears immediately, before
    // `postChatMessage` below has even resolved. CONV-4/D-49 — this is no
    // longer risk-free: `answerQuestion` now throws, rather than silently
    // continuing, if the inbound write it records before asking the model
    // itself fails past every retry, so this bubble can be shown for a
    // message the platform never actually recorded. The `catch` below
    // still surfaces that as a visible error (`ApiError` → `messagesError`,
    // `ErrorMessage`), so the student is not misled about whether their
    // question landed — only this optimistic bubble, which a refresh
    // reloads from `getChatMessages` and drops, is briefly stale.
    const optimistic: ChatMessageEntry = {
      id: `pending-${crypto.randomUUID()}`,
      role: 'student',
      text,
      createdAt: Date.now(),
    }
    setMessages((current) => [...(current ?? []), optimistic])
    setDraft('')
    try {
      const result = await postChatMessage(
        organizationId,
        selectedCourseId,
        text
      )
      if (
        result.kind === 'answered' ||
        result.kind === 'answered-last-request'
      ) {
        setMessages((current) => [
          ...(current ?? []),
          {
            id: `${result.conversationId}-${Date.now()}`,
            role: 'assistant',
            text: result.text,
            createdAt: Date.now(),
          },
        ])
        if (result.kind === 'answered-last-request') {
          setNotice('That was your last question for today.')
        }
      } else if (result.kind === 'failed-with-apology') {
        setMessages((current) => [
          ...(current ?? []),
          {
            id: `${result.conversationId}-${Date.now()}`,
            role: 'assistant',
            text: result.text,
            createdAt: Date.now(),
          },
        ])
      } else {
        setNotice(describeDeclineNotice(result.kind))
      }
    } catch (caught) {
      if (caught instanceof ApiError) setMessagesError(caught)
      else throw caught
    } finally {
      setSending(false)
    }
  }

  // WEB-10 rework — `chat_not_connected` is not an error to alarm anyone
  // with: it is the same "invited to connect" outcome LINK-1 gives an
  // unconnected identity on any other surface (`routes/chat.ts`'s own
  // module comment), an expected state for an account nobody has connected
  // yet, not a failure. Shown as a plain notice, not `ErrorMessage`.
  //
  // LINK-6/7 — now a real link, not just advice to find an instructor:
  // `pages/Connect.tsx` is exactly the screen this account needs, for this
  // same organization, and reaching it from here needs no invitation at all
  // (the account is already signed in) — a full-page navigation
  // (`window.location.assign`, not client-side state) since this app has no
  // router (`App.tsx`'s own module comment).
  if (coursesError?.body.error === 'chat_not_connected') {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-neutral-600">
          Your account is not connected to a course here yet.
        </p>
        <Button
          variant="primary"
          onClick={() => window.location.assign(`/connect/${organizationId}`)}
        >
          Connect your account
        </Button>
      </div>
    )
  }

  if (coursesError) {
    return <ErrorMessage error={coursesError} />
  }

  if (courses === undefined) {
    return (
      <p className="text-sm text-neutral-500" role="status">
        Loading…
      </p>
    )
  }

  if (courses.length === 0) {
    return (
      <p className="text-sm text-neutral-600">
        You are not enrolled in a course here yet. Ask your instructor to add
        you.
      </p>
    )
  }

  return (
    <section
      aria-label="Chat"
      data-testid="chat-screen"
      className="flex flex-col gap-4"
    >
      <h1 className="text-page-title font-semibold text-neutral-900">Chat</h1>

      {courses.length > 1 && (
        <label className="flex items-center gap-2 text-sm text-neutral-600">
          Course
          <select
            aria-label="Course"
            value={selectedCourseId}
            onChange={(event) => setSelectedCourseId(event.target.value)}
            className="rounded-md border border-neutral-300 py-1 pl-2 pr-7 text-sm text-neutral-900 focus:border-brand-500"
          >
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {courses.length === 1 && (
        <p className="text-sm font-medium text-neutral-700">
          {courses[0]?.title}
        </p>
      )}

      <div
        className="flex min-h-64 flex-col gap-2 overflow-y-auto rounded-md border border-neutral-200 bg-neutral-50 p-3"
        aria-live="polite"
        data-testid="chat-thread"
      >
        {messagesError ? (
          <ErrorMessage error={messagesError} />
        ) : messages === undefined ? (
          <p className="text-sm text-neutral-500" role="status">
            Loading…
          </p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No messages yet — ask something below.
          </p>
        ) : (
          messages.map((message) => (
            <ChatMessage
              key={message.id}
              role={message.role}
              text={message.text}
            />
          ))
        )}
        <div ref={threadEndRef} />
      </div>

      {notice && (
        <p role="status" className="text-sm text-neutral-600">
          {notice}
        </p>
      )}

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void handleSend()
        }}
      >
        <label className="sr-only" htmlFor="chat-composer">
          Ask a question
        </label>
        <textarea
          id="chat-composer"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter inserts a newline — the same
            // convention most chat surfaces already use, so nothing here
            // is a control a keyboard user has to learn from scratch
            // (WEB-17).
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void handleSend()
            }
          }}
          rows={2}
          placeholder="Ask a question…"
          disabled={sending}
          className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-brand-500"
        />
        <Button
          type="submit"
          variant="primary"
          aria-label="Send"
          icon={<SendIcon aria-hidden="true" className="size-4" />}
          disabled={sending || draft.trim().length === 0}
        >
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </form>
    </section>
  )
}
