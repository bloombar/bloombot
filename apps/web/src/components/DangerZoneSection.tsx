/**
 * The one look every "Danger zone" shares (account, organization, course,
 * project, admin screens), so they cannot drift apart.
 *
 * Deliberately discreet: no tinted fill and no boxed red border. A thin
 * neutral rule separates it from the content above, and the only red is the
 * heading text (`danger-700`, about 6.5:1 on white — WCAG AA) plus the red
 * outlined destructive `Button` inside. The app has no dark mode, so there
 * is one palette to check.
 *
 * The destructive button hugs its content (`[&>button]:self-start`) rather
 * stretching full width, which would make it the loudest thing on screen; an
 * error message above it still spans the full width.
 *
 * Visual only: callers keep their own confirmation flows and test ids.
 */

import type { ReactNode } from 'react'

export interface DangerZoneSectionProps {
  /** Heading text — most screens say "Danger zone"; the organization tab says what it deletes. */
  title: string
  /** Heading level, so each screen keeps the outline it already had. */
  as?: 'h2' | 'h3'
  /** Draw the neutral rule above. Turn off only where the caller already draws one (the organization tab). */
  divider?: boolean
  children: ReactNode
}

export function DangerZoneSection({
  title,
  as: Heading = 'h2',
  divider = true,
  children,
}: DangerZoneSectionProps) {
  return (
    <section
      aria-label="Danger zone"
      className={
        divider
          ? 'flex flex-col gap-3 border-t border-neutral-200 pt-6 [&>button]:self-start'
          : 'flex flex-col gap-3 [&>button]:self-start'
      }
    >
      <Heading className="text-section-title font-semibold text-danger-700">
        {title}
      </Heading>
      {children}
    </section>
  )
}
