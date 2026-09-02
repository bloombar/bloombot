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
    // `href` only, and only http(s)/mailto — never `javascript:` — the
    // `defaultSchema`'s own `protocols.href` allowlist, unchanged: this
    // schema narrows *which tags and attributes* survive, not the protocol
    // check that already protects the one attribute (`href`) that could
    // otherwise carry a `javascript:` URL.
    a: ['href', 'title'],
    // A fenced code block's own language, as GFM's own
    // ```language convention encodes it — `className` is the one
    // presentational attribute this schema allows through, and only the
    // `language-*` shape rehype's own code-block handling emits, via
    // `defaultSchema`'s own `clobberPrefix`-free `className` allowance
    // pattern (kept from the default schema rather than reinvented).
    code: ['className'],
  },
  protocols: {
    // Only `href` needs a protocol check at all — no other allowed
    // attribute above ever carries a URL (no `src` survives — images are
    // excluded entirely, this file's own module comment says why).
    href: defaultSchema.protocols?.href ?? ['http', 'https', 'mailto'],
  },
}
