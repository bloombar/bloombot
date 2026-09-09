/**
 * The published legal documents, named once.
 *
 * Both the navigation drawer and `SiteFooter` list these, and Google's OAuth
 * review checks that the privacy policy is linked from the homepage at the
 * same address given on the consent screen — so the one thing that must not
 * happen is the two lists drifting to different paths. Defining them here
 * makes that impossible rather than merely unlikely.
 */

export interface LegalLink {
  /** The address, matching `routing/route.ts`'s own `buildPath`. */
  href: string
  /** What the link says. */
  label: string
}

export const LEGAL_LINKS: readonly LegalLink[] = [
  { href: '/privacy', label: 'Privacy policy' },
  { href: '/terms', label: 'Terms & conditions' },
]
