/**
 * WEB-10: `ChatMessage` renders Markdown, and renders it safely. Every
 * "hostile" case here is exactly the class of input the brief names —
 * raw HTML, a `javascript:` URL, an `onerror` attribute — sent as the
 * literal text a model or a student typed, never pre-escaped by this
 * test. A test that only tried safe Markdown would not be testing the
 * sanitizer at all.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ChatMessage } from '../src/components/ChatMessage.js'

// WEB-65 added these props to `ChatMessage`; every test in this file is
// about Markdown rendering, not about them, so a fixed, unremarkable value
// for each keeps every call site below focused on what it is actually
// testing (`createdAt` is a real epoch millisecond, not `Date.now()` —
// deterministic, so nothing here is sensitive to when the suite runs).
const BASE_PROPS = {
  createdAt: 1_700_000_000_000,
  surface: null,
  channelRef: null,
  categoryRef: null,
  studentName: 'Jordan',
} as const

describe('ChatMessage (WEB-10)', () => {
  it('renders standard Markdown — headings, emphasis, lists, links, fenced code', () => {
    const text = [
      '# Welcome',
      '',
      'This is **bold**, this is _emphasis_, and here is `inline code`.',
      '',
      '- one',
      '- two',
      '',
      '[the syllabus](https://example.edu/syllabus)',
      '',
      '```js',
      'console.log(1)',
      '```',
    ].join('\n')
    render(<ChatMessage {...BASE_PROPS} role="assistant" text={text} />)
    const message = screen.getByTestId('chat-message-assistant')

    expect(
      screen.getByRole('heading', { level: 1, name: 'Welcome' })
    ).toBeInTheDocument()
    expect(message.querySelector('strong')).toHaveTextContent('bold')
    expect(message.querySelector('em')).toHaveTextContent('emphasis')
    expect(message.querySelectorAll('li')).toHaveLength(2)
    const link = screen.getByRole('link', { name: 'the syllabus' })
    expect(link).toHaveAttribute('href', 'https://example.edu/syllabus')
    expect(message.querySelector('pre code')).toHaveTextContent(
      'console.log(1)'
    )
  })

  it('never executes or preserves a raw <script> tag written into the message text', () => {
    render(
      <ChatMessage
        {...BASE_PROPS}
        role="assistant"
        text="Here is a tip.<script>window.__pwned = true</script>"
      />
    )
    const message = screen.getByTestId('chat-message-assistant')
    expect(message.querySelector('script')).not.toBeInTheDocument()
    expect((window as { __pwned?: boolean }).__pwned).toBeUndefined()
    expect(message.innerHTML).not.toContain('<script')
  })

  it('strips a javascript: URL from a Markdown link — no href survives that could run one', () => {
    render(
      <ChatMessage
        {...BASE_PROPS}
        role="assistant"
        text="[click me](javascript:window.__pwned=true)"
      />
    )
    const message = screen.getByTestId('chat-message-assistant')
    expect(message).toHaveTextContent('click me')
    const link = message.querySelector('a')
    // Rendered as a real `<a>` element (Markdown link syntax survives —
    // WEB-10 asks for links to render), but with no `href` at all: the
    // sanitizer's own protocol check drops a disallowed URL rather than
    // passing it through.
    expect(link).not.toHaveAttribute('href')
    expect(message.innerHTML).not.toContain('javascript:')
  })

  it('strips a javascript: URL written as raw HTML, not only Markdown link syntax', () => {
    render(
      <ChatMessage
        {...BASE_PROPS}
        role="assistant"
        text='<a href="javascript:window.__pwned=true">bad link</a>'
      />
    )
    const message = screen.getByTestId('chat-message-assistant')
    expect(message.innerHTML).not.toContain('javascript:')
    expect(message.querySelector('a')).not.toBeInTheDocument()
  })

  it('drops an onerror-carrying <img> tag entirely — no element with the attribute reaches the DOM', () => {
    render(
      <ChatMessage
        {...BASE_PROPS}
        role="assistant"
        text='Look: <img src="x" onerror="window.__pwned=true">'
      />
    )
    const message = screen.getByTestId('chat-message-assistant')
    expect(message.querySelector('img')).not.toBeInTheDocument()
    expect(message.innerHTML).not.toContain('onerror')
  })

  it('drops a Markdown image pointing at a javascript: URL, and images generally', () => {
    render(
      <ChatMessage
        {...BASE_PROPS}
        role="assistant"
        text="![alt](javascript:window.__pwned=true)"
      />
    )
    const message = screen.getByTestId('chat-message-assistant')
    expect(message.querySelector('img')).not.toBeInTheDocument()
  })

  it('strips a <style> block — no CSS-based exfiltration or injected presentation survives', () => {
    render(
      <ChatMessage
        {...BASE_PROPS}
        role="assistant"
        text="<style>body{background:url(javascript:window.__pwned=true)}</style>"
      />
    )
    const message = screen.getByTestId('chat-message-assistant')
    expect(message.querySelector('style')).not.toBeInTheDocument()
  })

  it('places a student message on the trailing edge and an assistant message on the leading edge', () => {
    render(<ChatMessage {...BASE_PROPS} role="student" text="hi" />)
    // WEB-65 — the outer element is now a column (heading above bubble),
    // so it is `items-end` that pins the whole thing to the trailing edge,
    // not `justify-end` (the row alignment this used before that change).
    expect(screen.getByTestId('chat-message-student').className).toContain(
      'items-end'
    )
  })

  // Rework finding — the schema's own comment claimed "http(s)/mailto"
  // while actually inheriting `defaultSchema`'s wider `irc`/`ircs`/`xmpp`
  // allowance too; narrowed to exactly what a course's own content ever
  // needs.
  it("strips an irc: URL from a Markdown link — the schema is narrowed to http(s)/mailto only, not defaultSchema's wider allowance", () => {
    render(
      <ChatMessage
        {...BASE_PROPS}
        role="assistant"
        text="[irc link](irc://evil.test/somechannel)"
      />
    )
    const message = screen.getByTestId('chat-message-assistant')
    expect(message).toHaveTextContent('irc link')
    expect(message.querySelector('a')).not.toHaveAttribute('href')
  })

  // The positive half of the assertion just above — narrowing the protocol
  // allowlist is only a real fix if the two protocols a course's own
  // content actually needs still work.
  it('keeps a mailto: link — the narrowed schema still allows exactly what a course needs', () => {
    render(
      <ChatMessage
        {...BASE_PROPS}
        role="assistant"
        text="[email the staff](mailto:staff@example.edu)"
      />
    )
    const link = screen.getByRole('link', { name: 'email the staff' })
    expect(link).toHaveAttribute('href', 'mailto:staff@example.edu')
  })

  it('a fenced code block keeps its real language className', () => {
    render(
      <ChatMessage
        {...BASE_PROPS}
        role="assistant"
        text={'```js\nconsole.log(1)\n```'}
      />
    )
    const message = screen.getByTestId('chat-message-assistant')
    expect(message.querySelector('code')).toHaveClass('language-js')
  })

  // WEB-13: a GFM table renders inside its own horizontal-scroll container,
  // so a table wider than the message bubble scrolls within it rather than
  // extending past the viewport with no way to reach the last columns
  // (reproduced in a real browser at 390×844 before this fix — see
  // `docs/DECISIONS.md`).
  it('wraps a Markdown table in its own horizontal-scroll container', () => {
    render(
      <ChatMessage
        {...BASE_PROPS}
        role="assistant"
        text={[
          '| Week | Topic | Reading | Assignment |',
          '|---|---|---|---|',
          '| 1 | Intro | Ch. 1 | none |',
          '| 2 | Loops | Ch. 2 | HW1 |',
        ].join('\n')}
      />
    )
    const message = screen.getByTestId('chat-message-assistant')
    const table = message.querySelector('table')
    expect(table).toBeInTheDocument()
    const scrollContainer = table?.parentElement
    // Its own dedicated wrapper — not the message bubble itself, whose own
    // class list happens to contain the substring "overflow-x-auto" too
    // (`[&_pre]:overflow-x-auto`, for fenced code blocks) and would make a
    // plain `.toContain()` on the bubble's own className a false positive.
    expect(scrollContainer).not.toBe(message)
    expect(scrollContainer?.classList.contains('overflow-x-auto')).toBe(true)
  })

  // WEB-65 — the headings this slice adds: a student's own message is
  // headed by their name alone, and the bot's own reply is headed
  // "Bloombot to `<name>`" — replacing the former "asked"/"answered"
  // pairing this file's own earlier test above already covers moving away
  // from.
  it('heads a student message by their own name, and the reply "Bloombot to `<name>`" (WEB-65)', () => {
    render(
      <ChatMessage {...BASE_PROPS} role="student" text="hi" studentName="Amy" />
    )
    render(
      <ChatMessage
        {...BASE_PROPS}
        role="assistant"
        text="hello"
        studentName="Amy"
      />
    )
    expect(screen.getByText('Amy')).toBeInTheDocument()
    expect(screen.getByText('Bloombot to Amy')).toBeInTheDocument()
  })

  // WEB-65 — a web message names its own surface, but never a channel or
  // category (Discord-only fields).
  it('shows a web message’s own surface, with no channel or category (WEB-65)', () => {
    render(
      <ChatMessage {...BASE_PROPS} role="student" text="hi" surface="web" />
    )
    expect(screen.getByText('· Web')).toBeInTheDocument()
  })

  // WEB-65 — a Discord message names its surface, category and channel.
  it('shows a Discord message’s own surface, category and channel (WEB-65)', () => {
    render(
      <ChatMessage
        {...BASE_PROPS}
        role="student"
        text="hi"
        surface="discord"
        categoryRef="General"
        channelRef="announcements"
      />
    )
    expect(
      screen.getByText('· Discord — General / announcements')
    ).toBeInTheDocument()
  })

  // WEB-65 — a message whose surface was never recorded shows nothing for
  // it, never a guess or an "unknown" badge (`BASE_PROPS.surface` is
  // already `null`, the case every other test in this file renders under).
  it('shows nothing for a message whose surface was never recorded (WEB-65)', () => {
    render(<ChatMessage {...BASE_PROPS} role="student" text="hi" />)
    expect(screen.queryByText(/Web|Discord|MCP/)).not.toBeInTheDocument()
  })

  // WEB-65 — the timestamp renders in the same readable form
  // `components/TranscriptBrowser.tsx` already uses (`new Date(...).toLocaleString()`
  // inside a real `<time>` element).
  it('renders the message’s own timestamp, in the existing readable form (WEB-65)', () => {
    render(<ChatMessage {...BASE_PROPS} role="student" text="hi" />)
    const time = screen.getByText(
      new Date(BASE_PROPS.createdAt).toLocaleString()
    )
    expect(time.tagName).toBe('TIME')
    expect(time).toHaveAttribute(
      'dateTime',
      new Date(BASE_PROPS.createdAt).toISOString()
    )
  })
})
