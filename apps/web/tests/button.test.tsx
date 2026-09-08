/**
 * WEB-12: `Button.tsx`'s own "an icon never carries meaning alone" —
 * enforced, not only documented. A reviewer found the doc comment claimed
 * a guard that did not exist (`'aria-label'?: string` was merely optional);
 * this proves the guard this file adds actually runs.
 */

import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Button } from '../src/components/Button.js'
import { AddIcon } from '../src/icons.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Button (WEB-12)', () => {
  it('warns in development when an icon-only button has no accessible name', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Button icon={<AddIcon aria-hidden="true" />} />)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('aria-label'))
  })

  it('does not warn when an icon-only button carries an aria-label', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <Button icon={<AddIcon aria-hidden="true" />} aria-label="Add category" />
    )
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not warn when the button has visible label text alongside its icon', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Button icon={<AddIcon aria-hidden="true" />}>Add category</Button>)
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not warn for a plain text-only button (no icon at all)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Button>Save</Button>)
    expect(spy).not.toHaveBeenCalled()
  })
})
