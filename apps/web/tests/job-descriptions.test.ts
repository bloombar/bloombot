/**
 * `describeJob` (WEB-70) — every job kind `apps/worker/src/index.ts`
 * registers a handler for gets a real, readable title and detail, and a
 * kind this module does not recognise falls back to naming the kind
 * itself rather than returning something blank.
 */

import { describe, expect, it } from 'vitest'

import { describeJob } from '../src/pages/job-descriptions.js'

// The seven kinds `apps/worker/src/index.ts` registers a handler for
// (that file's own `handlers.register` calls) — kept in step by hand, the
// same convention `job-descriptions.ts`'s own module comment explains.
const REGISTERED_KINDS = [
  'discordServers.scaffold',
  'roster.import',
  'courseAttachments.attach',
  'courseAttachments.detach',
  'transcripts.export',
  'contentDeletions.removeBytes',
  'courseApproval.notifyPending',
]

describe('describeJob (WEB-70)', () => {
  it.each(REGISTERED_KINDS)(
    '%s gets a real title and detail, not the raw kind string',
    (kind) => {
      const description = describeJob(kind)
      expect(description.title).not.toHaveLength(0)
      expect(description.detail).not.toHaveLength(0)
      // Neither field is merely the raw kind string echoed back — a real
      // kind's own case always names its work in ordinary language.
      expect(description.title).not.toBe(kind)
      expect(description.detail).not.toBe(kind)
    }
  )

  it('falls back to the kind string itself for a kind this module does not recognise, rather than returning something blank or throwing', () => {
    expect(() => describeJob('someFuture.kind')).not.toThrow()
    const description = describeJob('someFuture.kind')
    expect(description.title).toBe('someFuture.kind')
    expect(description.detail).toBe('someFuture.kind')
  })
})
