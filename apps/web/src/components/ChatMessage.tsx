/**
 * WEB-10: renders one chat message's text as Markdown, safely. The text
 * this component receives is untrusted on both sides of the conversation —
 * a student's own words, and a model's reply — so nothing here trusts it
 * to be anything but plain Markdown source.
 *
 * `react-markdown` (a maintained, widely used Markdown-to-React renderer)
 * plus `rehype-sanitize` against an explicit allowlist
 * (`../markdown-schema.ts`) is the pairing WEB-10's own brief asks for:
 * "prefer a well-maintained renderer plus an explicit sanitizer over
 * hand-rolling." Two layers, not one:
 *
 *  1. `react-markdown`'s own default pipeline never renders raw HTML in the
 *     first place — `<script>`, `<img onerror=...>` and the rest, written
 *     literally into the Markdown source, are parsed as an HTML node and
 *     *dropped*, not escaped and not executed (`mdast-util-to-hast`'s own
 *     `allowDangerousHtml` defaults to `false`, and this component never
 *     turns it on, and never adds `rehype-raw`, the plugin that would).
 *  2. `rehype-sanitize` still runs regardless, against the tree Markdown
 *     *syntax itself* can legitimately produce — a `[text](url)` link is
 *     real Markdown, not raw HTML, and produces a real `<a href>` node
 *     `rehype-sanitize` has to check; this is the layer that strips a
 *     `javascript:` URL a student or a model wrote as `[click me](javascript:...)`.
 *
 * Every element this renders comes from `../markdown-schema.ts`'s own
 * allowlist — nothing here reaches for a wider one for convenience.
 */

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'

import { CHAT_MARKDOWN_SCHEMA } from '../markdown-schema.js'

export interface ChatMessageProps {
  role: 'student' | 'assistant'
  text: string
}

/**
 * Tailwind classes for the handful of elements `CHAT_MARKDOWN_SCHEMA`
 * allows through — scoped with `[&_x]:` child selectors on the wrapping
 * `<div>` rather than a `components` override per tag, since none of them
 * need anything beyond spacing and type (no interactivity, no extra
 * markup) that a plain descendant selector cannot express just as well.
 */
const PROSE_CLASSES =
  '[&_h1]:mt-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:first:mt-0 ' +
  '[&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:first:mt-0 ' +
  '[&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:first:mt-0 ' +
  '[&_p]:mt-2 [&_p]:first:mt-0 ' +
  '[&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5 ' +
  '[&_ol]:mt-2 [&_ol]:list-decimal [&_ol]:pl-5 ' +
  '[&_li]:mt-0.5 ' +
  '[&_a]:underline [&_a]:underline-offset-2 ' +
  '[&_blockquote]:mt-2 [&_blockquote]:border-l-2 [&_blockquote]:border-neutral-300 [&_blockquote]:pl-3 [&_blockquote]:text-neutral-600 ' +
  '[&_code]:rounded [&_code]:bg-neutral-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] ' +
  '[&_pre]:mt-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-neutral-900 [&_pre]:p-3 [&_pre]:text-neutral-50 [&_pre_code]:bg-transparent [&_pre_code]:px-0 [&_pre_code]:py-0 ' +
  '[&_table]:mt-2 [&_table]:border-collapse [&_th]:border [&_th]:border-neutral-300 [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-neutral-300 [&_td]:px-2 [&_td]:py-1'

export function ChatMessage({ role, text }: ChatMessageProps) {
  const isStudent = role === 'student'
  return (
    <div
      className={`flex ${isStudent ? 'justify-end' : 'justify-start'}`}
      data-testid={`chat-message-${role}`}
    >
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isStudent
            ? 'bg-brand-600 text-white'
            : 'border border-neutral-200 bg-white text-neutral-900'
        } ${PROSE_CLASSES}`}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeSanitize, CHAT_MARKDOWN_SCHEMA]]}
        >
          {text}
        </ReactMarkdown>
      </div>
    </div>
  )
}
