/**
 * WEB-10: the chat surface's sanitizer policy — what `rehype-sanitize`
 * (`components/ChatMessage.tsx`) is allowed to let through, spelled out
 * explicitly rather than inherited from `hast-util-sanitize`'s own
 * `defaultSchema` unmodified. The brief this schema exists to satisfy is
 * "pin what the sanitizer allows, not what it denies" — a denylist has to
 * anticipate every dangerous thing a model might emit; an allowlist only
 * has to name the handful of things Markdown legitimately produces, and
 * everything else — a raw `<script>`, an `onerror` handler, a `javascript:`
 * URL, an `<iframe>` — is refused by construction, not because this file
 * happened to think of it. See `docs/DECISIONS.md` for the full reasoning
 * and the specific choices below.
 *
 * Scope: exactly what WEB-10's own text names — "headings, emphasis,
 * lists, links, and fenced code blocks" — plus paragraphs, line breaks,
 * blockquotes and GFM's tables/strikethrough (`remark-gfm`, already in the
 * rendering pipeline this schema pairs with; excluding their own output
 * elements here would render as literal Markdown syntax instead of the
 * formatting a course's assistant intended).
 *
 * Deliberately excluded: images (`<img>` — an `src` is a live fetch to
 * whatever URL the model names, and even a protocol-restricted one still
 * lets a message load an arbitrary tracking pixel or probe a private
 * network address the moment a student reads it) and raw HTML wholesale
 * (react-markdown's own default pipeline already drops raw HTML nodes
 * rather than rendering them — see `ChatMessage.tsx`'s own module comment
 * — so this schema's job is narrower than a general-purpose HTML
 * sanitizer's: it only has to hold the line on what *Markdown syntax
 * itself* can produce).
 */

import { defaultSchema, type Schema } from 'hast-util-sanitize'

export const CHAT_MARKDOWN_SCHEMA: Schema = {
  ...defaultSchema,
  tagNames: [
    'p',
    'br',
    'strong',
    'em',
    'del',
    'blockquote',
    'ul',
    'ol',
    'li',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'a',
    'code',
    'pre',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'hr',
  ],
  attributes: {
    // `href` only. `title` carries no URL, nothing to check.
    a: ['href', 'title'],
    // A fenced code block's own language, as GFM's own
    // ```language convention encodes it — restricted to exactly the
    // `language-*` shape rehype's own code-block handling emits, via a
    // regex `PropertyDefinition` (`hast-util-sanitize`'s own array-with-pattern
    // form), not merely an allowed attribute *name* with an unconstrained
    // value — a rework finding: the previous `code: ['className']` allowed
    // any `className` value at all through, wider than this comment always
    // claimed it was.
    code: [['className', /^language-[\w-]+$/]],
  },
  protocols: {
    // Rework finding — `defaultSchema.protocols.href` is `['http', 'https',
    // 'irc', 'ircs', 'mailto', 'xmpp']`; this file's own comment claimed
    // "http(s)/mailto" while actually inheriting all six, so
    // `[x](irc://evil.test)` kept its `href` (confirmed: harmless in
    // practice — nothing in this app hands an `irc:`/`xmpp:` URL to an
    // external protocol handler on click alone — but wider than "pin what
    // the sanitizer allows" (this file's own module comment) should ever
    // mean by accident). Spelled out explicitly instead of inherited, so
    // the list here is exactly what a course's own content ever needs: a
    // web link or a mail address.
    href: ['http', 'https', 'mailto'],
  },
}
