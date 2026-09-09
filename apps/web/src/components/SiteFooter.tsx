/**
 * A plain row of links to the published legal documents, at the foot of every
 * page.
 *
 * It exists so the privacy policy is reachable in one click from anywhere
 * without opening the navigation drawer first — which is what Google's OAuth
 * homepage requirement asks for ("linked on your homepage so that users can
 * find this information easily"), and better for anyone else looking for it.
 *
 * Ordinary `<a href>`s, not this app's own `navigate`: these are the two
 * addresses in the whole panel that must work as plain links — pasted into a
 * Google console field, opened in a new tab, or followed by a crawler that
 * runs no JavaScript. `parseRoute` handles them on the way back in either way.
 */

import { LEGAL_LINKS } from './legal-links.js'

export function SiteFooter() {
  return (
    <nav
      aria-label="Legal"
      data-testid="site-footer"
      className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-t border-neutral-200 px-4 py-3 text-xs text-neutral-500"
    >
      {LEGAL_LINKS.map((link) => (
        <a
          key={link.href}
          href={link.href}
          className="hover:text-neutral-900 hover:underline"
        >
          {link.label}
        </a>
      ))}
    </nav>
  )
}
