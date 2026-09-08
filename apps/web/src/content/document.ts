/**
 * Static legal documents — the privacy policy and the terms — as content
 * rather than components: a heading, the date the text last changed, and a
 * Markdown body.
 *
 * Keeping the prose out of `.tsx` keeps it editable by whoever owns the
 * words: nothing in a body below is code, and `pages/StaticDocument.tsx`
 * renders any of them without knowing which one it has.
 *
 * **Both are drafts pending legal review.** No lawyer has read them. They are
 * written from what this platform actually does — what the Discord bot stores,
 * what an instructor can read, what is sent to the model provider — rather
 * than from a template, so that every claim corresponds to code that exists.
 * Where the platform does not yet do something, they say so instead of
 * promising it.
 *
 * They are English only, deliberately. A machine translation of a privacy
 * policy is a legal statement nobody has read.
 */

/** Who runs this deployment, as the documents refer to them. */
export interface OperatorDetails {
  /** The legal entity behind the service. */
  name: string
  /** Whose law governs the terms, and where disputes are heard. */
  jurisdiction: string
  /** Where privacy and legal correspondence should go. */
  contactEmail: string
  /** Postal address, where a policy is expected to give one. */
  postalAddress: string
}

/**
 * What the documents say until a deployment fills them in. Square brackets,
 * so an unconfigured page reads as the draft it is rather than as a policy
 * with a suspiciously vague party to it.
 *
 * Deliberately a plain constant rather than server-supplied configuration:
 * this platform has no `OPERATOR_*` environment today, and inventing one to
 * hold four strings nobody has decided yet would be a schema change in
 * service of a placeholder. Replace the values here when the operator is
 * settled; `packages/config` is where they would move if they ever need to
 * differ per deployment.
 */
export const OPERATOR: OperatorDetails = {
  name: '[Operator legal name]',
  jurisdiction: '[State / Country]',
  contactEmail: '[legal@example.com]',
  postalAddress: '[Street, City, Postal code, Country]',
}

export interface StaticDocument {
  /** The page's heading, and its only `h1`. */
  title: string
  /** One line under the heading saying what the document is for. */
  summary: string
  /** When the text last changed. */
  updated: string
  /** The document itself, as Markdown. `##` is its top level. */
  body: string
}

/**
 * The banner every legal page opens with. Separate from each document's own
 * body so the two cannot drift apart, and so removing it after a review is
 * one edit rather than two.
 */
export function draftNotice(operator: OperatorDetails): string {
  return [
    `> **Draft, pending legal review.** This text has not been reviewed by a`,
    `> lawyer. It describes what the platform does today, and it will change.`,
    `> If your institution needs a reviewed agreement before you use this`,
    `> service, contact ${operator.contactEmail} first.`,
  ].join('\n')
}
