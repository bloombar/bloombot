/**
 * Renders one of `content/`'s static legal documents — the privacy policy and
 * the terms — from its Markdown body.
 *
 * One component for both, taking the document as a prop, because the two
 * differ only in their words: a second near-identical page is a second place
 * for a heading style or a sanitizer setting to drift.
 *
 * **Reachable signed out.** `App.tsx` matches these routes before it decides
 * whether anyone is signed in: a privacy policy nobody can read without an
 * account is not a published policy, and Google's OAuth review asks for one at
 * a public address.
 *
 * The sanitizer runs here for the same reason it does on a chat message, even
 * though this text ships in the bundle rather than arriving from a model:
 * `CHAT_MARKDOWN_SCHEMA` is the allowlist this app already trusts, and giving
 * one Markdown surface a different, laxer policy is how the strict one stops
 * being the rule.
 */

import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'

import { CHAT_MARKDOWN_SCHEMA } from '../markdown-schema.js'
import type { StaticDocument as StaticDocumentContent } from '../content/document.js'

/**
 * Tailwind has no default styling for bare `<h2>`/`<ul>`/`<blockquote>`, so a
 * long document needs its elements styled explicitly or it renders as one
 * undifferentiated wall of text. Mapped per element rather than through a
 * prose plugin this app does not depend on.
 */
const MARKDOWN_COMPONENTS: Components = {
  h2: ({ children }) => (
    <h2 className="mt-8 mb-2 text-lg font-semibold text-neutral-900">
      {children}
    </h2>
  ),
  p: ({ children }) => (
    <p className="mb-3 text-sm leading-6 text-neutral-700">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="mb-3 list-disc space-y-1 pl-5 text-sm leading-6 text-neutral-700">
      {children}
    </ul>
  ),
  li: ({ children }) => <li>{children}</li>,
  strong: ({ children }) => (
    <strong className="font-semibold text-neutral-900">{children}</strong>
  ),
  a: ({ href, children }) => (
    <a className="text-brand-600 underline" href={href}>
      {children}
    </a>
  ),
  // Neither document currently uses a blockquote, but the sanitizer schema
  // allows one and Markdown is hand-written prose — styled so a future
  // callout does not fall back to unstyled default markup.
  blockquote: ({ children }) => (
    <blockquote className="mb-4 border-l-4 border-amber-400 bg-amber-50 px-4 py-3 text-sm leading-6 text-neutral-800">
      {children}
    </blockquote>
  ),
}

export interface StaticDocumentProps {
  document: StaticDocumentContent
  /** Rendered as a testid suffix, so a test can name the page it asserts on. */
  testId: string
}

export function StaticDocument({ document, testId }: StaticDocumentProps) {
  return (
    <div className="mx-auto max-w-3xl p-6" data-testid={testId}>
      <h1 className="text-page-title font-semibold text-neutral-900">
        {document.title}
      </h1>
      <p className="mt-1 text-sm text-neutral-600">{document.summary}</p>
      <p className="mt-1 text-xs text-neutral-500">
        Last updated {document.updated}
      </p>
      <div className="mt-6">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeSanitize, CHAT_MARKDOWN_SCHEMA]]}
          components={MARKDOWN_COMPONENTS}
        >
          {document.body}
        </ReactMarkdown>
      </div>
    </div>
  )
}
