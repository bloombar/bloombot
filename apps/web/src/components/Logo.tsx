/**
 * The Bloombot mark, inline.
 *
 * Inline SVG rather than an `<img src="/logo.svg">` so it renders with no
 * second request and no flash of nothing at the top of every page — and so
 * `apps/web/tests` can assert on it without a network. The same artwork lives
 * at `public/logo.svg`, which is what the favicon, the manifest icons and
 * `scripts/generate-icons.sh` all render from; the two are kept in step by
 * hand, and `tests/logo.test.tsx` pins the shapes so a change to one without
 * the other is at least visible in a diff.
 *
 * A four-petal bloom around a dark centre with two eyes: the bloom for the
 * name, the eyes because this is a bot a student talks to. Every element is a
 * circle or a rounded rect, which is what keeps it legible at 16px in a
 * browser tab.
 */

export interface LogoProps {
  /** Tailwind size classes. Defaults to the header's own size. */
  className?: string
  /**
   * Accessible name. Defaults to none: beside a visible "Bloombot" wordmark
   * the mark is decorative, and naming it twice makes a screen reader say it
   * twice. Pass a title where the mark stands alone.
   */
  title?: string
}

export function Logo({ className = 'size-7', title }: LogoProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : 'true'}
      data-testid="bloombot-logo"
    >
      <rect width="64" height="64" rx="15" fill="#4f46e5" />
      <g fill="#ffffff">
        <circle cx="32" cy="19" r="9.5" />
        <circle cx="45" cy="32" r="9.5" />
        <circle cx="32" cy="45" r="9.5" />
        <circle cx="19" cy="32" r="9.5" />
      </g>
      <circle cx="32" cy="32" r="9" fill="#312e81" />
      <circle cx="28.6" cy="31" r="2.1" fill="#ffffff" />
      <circle cx="35.4" cy="31" r="2.1" fill="#ffffff" />
    </svg>
  )
}
