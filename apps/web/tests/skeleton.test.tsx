/**
 * WEB-45: `components/Skeleton.tsx`'s own contract — the decorative shapes
 * are `aria-hidden`, and the accessible status text is present and reads
 * "Loading…" (or a caller's own `label`), so a screen reader loses nothing
 * a purely visual pulse would otherwise take away.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  LoadingStatus,
  Skeleton,
  SkeletonLine,
  SkeletonRow,
} from '../src/components/Skeleton.js'

describe('Skeleton (WEB-45)', () => {
  it('the base Skeleton is aria-hidden and carries no accessible role of its own', () => {
    const { container } = render(<Skeleton className="h-4 w-full" />)
    const shape = container.firstChild as HTMLElement
    expect(shape).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('SkeletonLine is also aria-hidden — the same decorative contract as the base shape', () => {
    const { container } = render(<SkeletonLine />)
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true')
  })

  it('SkeletonRow is aria-hidden as a whole, matching the card rows it stands in for', () => {
    const { container } = render(<SkeletonRow />)
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true')
  })

  it('LoadingStatus exposes "Loading…" through a role="status" region, visually hidden', () => {
    const { container } = render(<LoadingStatus />)
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Loading…')
    // `sr-only` (Tailwind's own visually-hidden utility) — present, not
    // merely rendered, so a sighted reader never sees stray "Loading…"
    // text sitting beside the shapes it accompanies.
    expect(container.firstChild).toHaveClass('sr-only')
  })

  it('LoadingStatus accepts a more specific label, for a screen that already says one', () => {
    render(<LoadingStatus label="Loading jobs…" />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading jobs…')
  })
})
