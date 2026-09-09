/**
 * Static legal documents — the privacy policy and the terms — as content
 * rather than components: a heading, the date the text last changed, and a
 * Markdown body.
 *
 * Keeping the prose out of `.tsx` keeps it editable by whoever owns the
 * words: nothing in a body below is code, and `pages/StaticDocument.tsx`
 * renders any of them without knowing which one it has.
 *
 * They are published policies, not drafts: written from what this platform
 * actually does — what the Discord bot stores, what an instructor can read,
 * what is sent to the model provider — rather than from a template, so that
 * every claim corresponds to code that exists. Where the platform does not
 * yet do something, they say so instead of promising it — that honesty stays
 * in the prose itself, it is just no longer announced by a banner at the top
 * (see the note on `OPERATOR` below for why the banner is gone).
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
  /** Postal address, where a policy is expected to give one. Empty when the
   * deployment has not set one — the Contact section omits the line rather
   * than printing a placeholder for it (see `privacy.ts`/`terms.ts`). */
  postalAddress: string
}

/**
 * Who these documents name as the operator, build-time configurable from
 * `apps/web`'s own `VITE_OPERATOR_*` variables (documented alongside
 * `VITE_GOOGLE_CLIENT_ID` in `docs/CONTRIBUTING.md`) rather than hard-coded —
 * a deployment run by someone other than this project can publish these
 * pages under its own name without editing this file.
 *
 * The defaults are deliberately *not* placeholders. Google's OAuth review
 * rejects a policy with square-bracket "[fill this in]" text outright, as
 * evidence the page is not really published — so an unconfigured build still
 * ships a valid, name-bearing policy (Bloombot's own), rather than a draft
 * with blanks in it. `postalAddress` alone defaults to empty, since printing
 * a fabricated address would be worse than omitting the line — both
 * documents' Contact sections only print it when it is non-empty.
 *
 * Deliberately a plain constant reading `import.meta.env` rather than
 * server-supplied configuration: this platform has no `OPERATOR_*`
 * environment on `apps/api` today, and inventing one to hold four strings
 * nobody has decided yet would be a schema change in service of a single
 * static page. `packages/config` is where they would move if they ever need
 * to differ per request rather than per build.
 */
export const OPERATOR: OperatorDetails = {
  name: import.meta.env['VITE_OPERATOR_NAME'] || 'Bloombot',
  jurisdiction:
    import.meta.env['VITE_OPERATOR_JURISDICTION'] || 'New York, United States',
  contactEmail:
    import.meta.env['VITE_OPERATOR_CONTACT_EMAIL'] || 'privacy@wonkledge.com',
  postalAddress: import.meta.env['VITE_OPERATOR_POSTAL_ADDRESS'] || '',
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
