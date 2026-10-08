/**
 * Danger zones are discreet: a thin neutral rule and a red heading, not a
 * red-filled, red-bordered box. One shared component, so every screen's
 * Danger zone looks the same.
 */

import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { DangerZoneSection } from '../src/components/DangerZoneSection.js'

const SCREENS = [
  'src/components/DangerZone.tsx',
  'src/pages/Account.tsx',
  'src/pages/CourseEditor.tsx',
  'src/pages/admin/AccountDetail.tsx',
  'src/pages/admin/CourseDetail.tsx',
  'src/pages/admin/ProjectDetail.tsx',
]

describe('DangerZoneSection', () => {
  it('has no red fill or red box border, only a neutral top rule', () => {
    render(
      <DangerZoneSection title="Danger zone">
        <p>body</p>
      </DangerZoneSection>
    )
    const region = screen.getByRole('region', { name: 'Danger zone' })
    expect(region.className).not.toMatch(/bg-danger|border-danger/)
    expect(region.className).toContain('border-t')
    expect(region.className).toContain('border-neutral-200')
    expect(region.className).not.toMatch(/(^|\s)(border|rounded\S*)(\s|$)/)
  })

  it('puts the red accent on the heading text and honours the heading level', () => {
    render(
      <DangerZoneSection title="Danger zone" as="h3">
        <p>body</p>
      </DangerZoneSection>
    )
    const heading = screen.getByRole('heading', { level: 3 })
    expect(heading.className).toContain('text-danger-700')
  })

  it.each(SCREENS)(
    '%s uses the shared section, not its own red box',
    (file) => {
      const source = readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), '..', file),
        'utf8'
      )
      expect(source).toContain('<DangerZoneSection')
      expect(source).not.toMatch(/bg-danger-50 p-4/)
    }
  )
})
