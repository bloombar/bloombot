import { describe, expect, it } from 'vitest'

import { courseNotApprovedNotice } from '../src/notices.js'

describe('courseNotApprovedNotice (COST-8/SURF-10)', () => {
  it('names the configured support contact when one is set', () => {
    expect(courseNotApprovedNotice('support@bloombot.example.edu')).toBe(
      "This course hasn't been approved to answer questions yet. The course owner should contact Bloombot support at support@bloombot.example.edu to request approval."
    )
  })

  it('omits the "at <contact>" clause when no support contact is configured', () => {
    expect(courseNotApprovedNotice('')).toBe(
      "This course hasn't been approved to answer questions yet. The course owner should contact Bloombot support to request approval."
    )
  })

  it('treats a whitespace-only contact the same as unset', () => {
    expect(courseNotApprovedNotice('   ')).toBe(
      "This course hasn't been approved to answer questions yet. The course owner should contact Bloombot support to request approval."
    )
  })
})
