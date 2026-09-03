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
import { SendIcon, SuccessIcon } from '../icons.js'

export interface ChatProps {
  organizationId: string
  /** WEB-25 — the course a join-link redemption most recently resolved for this account in this organization, preferred over `listChatCourses`' own first entry (`selectedCourseId`'s own initializer, below) so a redeemer already enrolled in more than one course here still lands on the one they just joined, not whichever the list happens to return first. */
  initialCourseId?: string
  /** WEB-25 — set only right alongside `initialCourseId`, by a just-completed join-link redemption: names the outcome plainly (`joinConfirmationText`, below) rather than leaving a redeemer to infer it from which course happens to be selected. `alreadyEnrolled` distinguishes "you're already enrolled" from a fresh join — ENRL-8's own "redeeming twice is a confirmation, not an error." */
  joinConfirmation?: { alreadyEnrolled: boolean }
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

export function Chat({
  organizationId,
  initialCourseId,
  joinConfirmation,
}: ChatProps) {
  const [courses, setCourses] = useState<ChatCourse[] | undefined>(undefined)
  const [coursesError, setCoursesError] = useState<ApiError | undefined>(
    undefined
  )
  // WEB-25: seeded from `initialCourseId` when supplied — `listChatCourses`'
  // own callback below (`current ?? result[0]?.id`) then leaves it alone,
  // the same "do not override a value already chosen" guard it already
  // holds for a course this component's own `<select>` picked.
  const [selectedCourseId, setSelectedCourseId] = useState<string | undefined>(
    initialCourseId
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
  // WEB-24: the thread's own scroll container — `scrollThreadToBottom`
  // below sets its `scrollTop` directly, rather than the previous
  // `scrollIntoView`, which (the reported defect) moved the whole page
  // once nothing bounded the thread's height and it was no longer the
  // nearest *scrollable* ancestor for `scrollIntoView` to find.
  const threadRef = useRef<HTMLDivElement>(null)
  // WEB-24: whether the reader was at, or within a few pixels of, the
  // bottom of the thread the last time they scrolled it — kept current by
  // `onScroll` on the thread itself (below), not recomputed here.
  // Appending a message never fires a `scroll` event on its own (the
  // browser does not move `scrollTop` just because the scrollable content
  // beneath it grew), so this still reflects the reader's own position at
  // the moment a new message lands, not a position the new message has
  // already shifted.
  const isNearBottomRef = useRef(true)
  // WEB-24: set immediately before the student's own message is appended
  // (`handleSend`, below), so the thread jumps to it even if the reader
  // had scrolled up to reread something first. The requirement draws a
  // scroll-preservation exception for a reply that *arrives*, not for a
  // message the reader just sent themselves — consumed (and reset) the
  // first time the effect below runs afterward.
  const forceScrollRef = useRef(false)
  // WEB-24: true once a message has arrived while the reader was scrolled
  // away from the bottom — the affordance below tells them plainly, rather
  // than silently scrolling them to a message they did not ask to see yet.
  const [newMessageWaiting, setNewMessageWaiting] = useState(false)

  const scrollThreadToBottom = useCallback(() => {
    const el = threadRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [])

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
    // WEB-24: a freshly selected course's thread opens at its newest
    // message regardless of where the reader had scrolled in whichever
    // course was open before — without this, a stale `isNearBottomRef`
    // left over from the previous thread could suppress this thread's own
    // first auto-scroll.
    isNearBottomRef.current = true
    setNewMessageWaiting(false)
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

  // WEB-24: the thread follows the conversation — but only when following
  // it does not steal a reader's place (the requirement's own judgement
  // call, `docs/SPEC.md`'s WEB-24). Skipped while `messages` is still
  // `undefined` (the initial fetch, or a course switch already reset by
  // `loadMessages` above) — nothing to scroll to, and reading
  // `isNearBottomRef` before the new thread has rendered would still hold
  // whichever course was open before.
  useEffect(() => {
    if (messages === undefined) return
    if (forceScrollRef.current || isNearBottomRef.current) {
      forceScrollRef.current = false
      scrollThreadToBottom()
      isNearBottomRef.current = true
      setNewMessageWaiting(false)
    } else {
      setNewMessageWaiting(true)
    }
  }, [messages, scrollThreadToBottom])

  // WEB-24: jumps the reader to the newest message on demand — the
  // "New messages" affordance below is the only caller, but this also
  // stands in for a reader who instead scrolls the thread back to the
  // bottom themselves (`onScroll`, below, clears `newMessageWaiting` the
  // same way once `isNearBottomRef` reports they arrived there on their
  // own).
  const jumpToLatest = () => {
    scrollThreadToBottom()
    isNearBottomRef.current = true
    setNewMessageWaiting(false)
  }

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
    // WEB-24: the thread jumps to the reader's own message unconditionally
    // (`forceScrollRef`'s own comment, above) — sending is exactly the
    // "student sends one" case the requirement names with no
    // scroll-preservation exception, unlike a reply that arrives on its
    // own.
    forceScrollRef.current = true
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

  // WEB-25 — named by title, not merely "this course": `courses` (just
  // confirmed defined, above) is this account's own enrolled list, read
  // moments after the redemption that set `joinConfirmation` in the first
  // place, so the just-joined course's own title is always in it.
  //
  // Rework finding (must-fix): this used to look the title up by
  // `selectedCourseId`, which `courses.length > 1`'s own `<select onChange>`
  // (below) rewrites on every switch — the banner has no dismissal and
  // persists for the mount's whole life, so it kept asserting a fact about
  // whichever course the student most recently *looked at*, not the one the
  // link actually joined. `initialCourseId` is the one value this component
  // never changes after mount (there is no setter for it, unlike
  // `selectedCourseId`), so it is the only correct key for a banner that is
  // itself about a one-time event, not the current selection.
  const joinedCourseTitle = joinConfirmation
    ? courses.find((course) => course.id === initialCourseId)?.title
    : undefined

  return (
    <section
      aria-label="Chat"
      data-testid="chat-screen"
      // WEB-24: bounded to exactly the space `AppShell.tsx`'s fixed header
      // and footer leave for `main`'s own content — `--spacing-header`/
      // `--spacing-footer` (`style.css`) are the same tokens `AppShell`
      // itself sizes them with, minus the 1.5rem gap `main`'s own padding
      // reserves on each side (`AppShell.tsx`'s `pt-[...]`/`pb-[...]`) —
      // rather than changing `main` itself, which every other screen this
      // shell renders still relies on to grow with its content and let the
      // ordinary document scroll (this slice's own report has the reasoning
      // for staying scoped to this one screen). `overflow-hidden` is what
      // actually enforces the bound: a flex column's children can still
      // spill past a fixed height rather than being clipped to it, which is
      // the same "grows past its box" failure this slice exists to fix, one
      // level up. `100dvh`, not `100vh` — the dynamic viewport unit shrinks
      // with a mobile browser's own chrome, and with a software keyboard on
      // the browsers that report it there, so this box (and the composer
      // pinned inside it, below) resizes down with the keyboard rather than
      // leaving the composer hidden underneath it.
      className="flex h-[calc(100dvh-var(--spacing-header)-var(--spacing-footer)-3rem)] flex-col gap-4 overflow-hidden"
    >
      <h1 className="shrink-0 text-page-title font-semibold text-neutral-900">
        Chat
      </h1>

      {joinConfirmation && (
        // WEB-25: `role="status"` — an `aria-live` region, so a screen
        // reader announces this the moment it renders, the same "confirmed
        // to a screen reader, not only shown" requirement `docs/SPEC.md`'s
        // own WEB-25 states directly. Rendered inline with the rest of this
        // screen, not a toast that times out on its own — nothing here ever
        // removes it, so there is nothing a student has to notice before it
        // disappears.
        <p
          role="status"
          data-testid="join-confirmation"
          // WEB-24: `shrink-0` — this banner, like every other element
          // outside the thread itself, keeps its natural height rather than
          // being squeezed by the flex column's fixed total (this file's
          // own module comment on the outer `<section>`, above); only the
          // thread (`flex-1 min-h-0`, below) gives up space for it.
          className="flex shrink-0 items-center gap-2 rounded-md bg-success-50 px-3 py-2 text-sm text-neutral-700"
        >
          <SuccessIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-success-600"
          />
          {joinConfirmation.alreadyEnrolled
            ? `You're already enrolled in ${joinedCourseTitle ?? 'this course'}.`
            : `You're enrolled in ${joinedCourseTitle ?? 'this course'}.`}
        </p>
      )}

      {courses.length > 1 && (
        <label className="flex shrink-0 items-center gap-2 text-sm text-neutral-600">
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
        <p className="shrink-0 text-sm font-medium text-neutral-700">
          {courses[0]?.title}
        </p>
      )}

      <div
        ref={threadRef}
        onScroll={(event) => {
          // WEB-24: kept current on every real scroll — appending a message
          // never itself fires this handler (`isNearBottomRef`'s own
          // comment, above), so it only ever reflects the reader's own
          // movement, including scrolling back to the bottom themselves
          // rather than using the "New messages" affordance below.
          const el = event.currentTarget
          const distanceFromBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight
          // "Near", not "exactly at" — a few pixels of rounding (subpixel
          // layout, a scrollbar's own reserved width) would otherwise read
          // a reader who is visually at the bottom as scrolled away from
          // it.
          const nearBottom = distanceFromBottom < 48
          isNearBottomRef.current = nearBottom
          if (nearBottom) setNewMessageWaiting(false)
        }}
        // WEB-24: `flex-1 min-h-0`, not the previous `min-h-64` with no
        // maximum — this is the actual fix for the reported defect. `flex-1`
        // gives the thread every pixel the bounded column (above) has left
        // once the title, course picker, banners and composer have taken
        // their own natural height; `min-h-0` overrides a flex item's
        // default `min-height: auto` (sized to its content), which would
        // otherwise refuse to shrink below the transcript's full height and
        // push the composer past the bottom of the column again — the exact
        // "grows with the conversation" failure this slice exists to fix.
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-md border border-neutral-200 bg-neutral-50 p-3"
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
      </div>

      {newMessageWaiting && (
        // WEB-24: the judgement call the requirement's own text calls out
        // by name — a reader scrolled away from the bottom is told a new
        // message arrived, not scrolled to it against their will. A plain
        // sibling of the thread, in normal flow rather than an overlay
        // positioned on top of it, so it can never cover the last message
        // the way an absolutely-positioned banner would risk doing.
        // `role="status"` is an `aria-live` region — the same device the
        // join banner and decline notice below already use — so a screen
        // reader announces it the moment it appears; the `<button>` inside
        // is a perfectly ordinary one, reachable by Tab and activated by
        // Enter/Space like every other control on this screen, so nothing
        // about noticing or acting on it depends on a mouse.
        <p role="status" className="flex shrink-0 justify-center">
          <button
            type="button"
            data-testid="new-messages-button"
            onClick={jumpToLatest}
            className="rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-sm font-medium text-brand-700 hover:bg-brand-100"
          >
            New messages ↓
          </button>
        </p>
      )}

      {notice && (
        <p role="status" className="shrink-0 text-sm text-neutral-600">
          {notice}
        </p>
      )}

      <form
        className="flex shrink-0 items-end gap-2"
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
