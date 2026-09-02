/**
 * MCP-1/3/4/5's own dispatch logic, exercised with no transport at all —
 * this file's own proof that `call-tool.ts` is testable the way this
 * slice's brief asks: a throwaway database, a real `createPlatformRegistry`,
 * and plain function calls.
 */

import { createPlatformRegistry } from '@bloombot/actions'
import { courseAttachments, jobs } from '@bloombot/db'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  callTool,
  ConfirmationRequiredError,
  UnknownMcpToolError,
} from '../src/call-tool.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'
import {
  seedAttachment,
  seedOtherOrganization,
  seedSignedInAccount,
} from './helpers/seed.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Every test dispatches through the real platform registry — MCP-1's own "the same dispatcher", not a stand-in. */
function registry() {
  return createPlatformRegistry()
}

describe('MCP-1 — an assistant reaches the platform through the action layer', () => {
  it('dispatches a non-destructive tool through the real action pipeline, attributed to the calling account', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)

    const result = await callTool(
      'projects.create',
      { organizationId: caller.organizationId, name: 'A New Term' },
      {
        registry: registry(),
        db: testDb.db,
        accountId: caller.accountId,
        requestConfirmation: () => Promise.resolve(false),
      }
    )

    expect(result.output).toMatchObject({ name: 'A New Term' })
  })

  it('rejects a name unknown to the MCP allowlist even when it is a real, registered action', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)

    // `discordServers.remove` is a real, registered action (packages/actions)
    // but deliberately not on `MCP_TOOL_SURFACE` (tool-surface.ts's own
    // module comment) — MCP-2's own allowlist, proven from the dispatch
    // side this time rather than the definitions side.
    await expect(
      callTool(
        'discordServers.remove',
        { organizationId: caller.organizationId, serverId: 'srv-1' },
        {
          registry: registry(),
          db: testDb.db,
          accountId: caller.accountId,
          requestConfirmation: () => Promise.resolve(false),
        }
      )
    ).rejects.toThrow(UnknownMcpToolError)
  })

  it("surfaces the action pipeline's own input validation failure for a malformed argument", async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)

    await expect(
      callTool(
        'projects.create',
        // `name` fails `projects.create`'s own zod schema (`z.string().min(1)`).
        { organizationId: caller.organizationId, name: '' },
        {
          registry: registry(),
          db: testDb.db,
          accountId: caller.accountId,
          requestConfirmation: () => Promise.resolve(false),
        }
      )
    ).rejects.toThrow(/validation/)
  })
})

describe("MCP-3 — an agent acts as an account, with that account's authority", () => {
  it('refuses a call against an organization the caller has no membership in, not-found-shaped (TEN-5)', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const otherOrganizationId = seedOtherOrganization(testDb.db)

    await expect(
      callTool(
        'projects.create',
        { organizationId: otherOrganizationId, name: 'Should Not Be Created' },
        {
          registry: registry(),
          db: testDb.db,
          accountId: caller.accountId,
          requestConfirmation: () => Promise.resolve(false),
        }
      )
      // ActionRefusedError's own message: "This record does not exist or
      // you do not have access to it." — identical whether the
      // organization is real (this test) or entirely made up (next test),
      // exactly the "not an existence oracle" guarantee MCP-3 asks for.
    ).rejects.toThrow(/does not exist or you do not have access to it/)
  })

  it('gives the identical refusal for an organization id that does not exist at all', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)

    let realOrgError: unknown
    let fakeOrgError: unknown
    try {
      await callTool(
        'projects.create',
        {
          organizationId: seedOtherOrganization(testDb.db),
          name: 'x',
        },
        {
          registry: registry(),
          db: testDb.db,
          accountId: caller.accountId,
          requestConfirmation: () => Promise.resolve(false),
        }
      )
    } catch (error) {
      realOrgError = error
    }
    try {
      await callTool(
        'projects.create',
        { organizationId: 'org-does-not-exist', name: 'x' },
        {
          registry: registry(),
          db: testDb.db,
          accountId: caller.accountId,
          requestConfirmation: () => Promise.resolve(false),
        }
      )
    } catch (error) {
      fakeOrgError = error
    }

    expect((realOrgError as Error).message).toBe(
      (fakeOrgError as Error).message
    )
  })

  it("does not let the caller reach another account's organization, even for a read-only tool", async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const otherOrganizationId = seedOtherOrganization(testDb.db)

    await expect(
      callTool(
        'projects.list',
        { organizationId: otherOrganizationId },
        {
          registry: registry(),
          db: testDb.db,
          accountId: caller.accountId,
          requestConfirmation: () => Promise.resolve(false),
        }
      )
    ).rejects.toThrow(/does not exist or you do not have access to it/)
  })

  it('succeeds for the same tool and account once a real membership exists', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)

    const result = await callTool(
      'projects.list',
      { organizationId: caller.organizationId },
      {
        registry: registry(),
        db: testDb.db,
        accountId: caller.accountId,
        requestConfirmation: () => Promise.resolve(false),
      }
    )
    expect(result.output).toEqual([])
  })
})

describe('MCP-4 — a destructive tool asks first', () => {
  it('never dispatches courseAttachments.detach when confirmation is declined', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const attachmentId = seedAttachment(testDb.db, caller.organizationId)
    const requestConfirmation = vi.fn(() => Promise.resolve(false))

    await expect(
      callTool(
        'courseAttachments.detach',
        { organizationId: caller.organizationId, attachmentId },
        {
          registry: registry(),
          db: testDb.db,
          accountId: caller.accountId,
          requestConfirmation,
        }
      )
    ).rejects.toThrow(ConfirmationRequiredError)

    expect(requestConfirmation).toHaveBeenCalledTimes(1)
    // Not merely "the error was thrown" — the attachment itself is
    // untouched and no removal job was ever enqueued.
    expect(
      courseAttachments.getAttachment(
        caller.organizationId,
        attachmentId,
        testDb.db
      )?.status
    ).toBe('pending')
    expect(jobs.countQueuedJobs(testDb.db)).toBe(0)
  })

  it('dispatches courseAttachments.detach once confirmation is granted', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const attachmentId = seedAttachment(testDb.db, caller.organizationId)
    const requestConfirmation = vi.fn(() => Promise.resolve(true))

    const result = await callTool(
      'courseAttachments.detach',
      { organizationId: caller.organizationId, attachmentId },
      {
        registry: registry(),
        db: testDb.db,
        accountId: caller.accountId,
        requestConfirmation,
      }
    )

    expect(requestConfirmation).toHaveBeenCalledTimes(1)
    expect(result.output).toMatchObject({ jobId: expect.any(String) })
  })

  it("is asked to confirm a tool the caller cannot reach — the tenancy refusal happens first, so a caller cannot use a destructive tool to probe another organization's existence", async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const otherOrganizationId = seedOtherOrganization(testDb.db)
    const requestConfirmation = vi.fn(() => Promise.resolve(true))

    await expect(
      callTool(
        'courseAttachments.detach',
        { organizationId: otherOrganizationId, attachmentId: 'whatever' },
        {
          registry: registry(),
          db: testDb.db,
          accountId: caller.accountId,
          requestConfirmation,
        }
      )
    ).rejects.toThrow(/does not exist or you do not have access to it/)

    expect(requestConfirmation).not.toHaveBeenCalled()
  })

  it('treats a rejected confirmation the same as a declined one — fails closed', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const attachmentId = seedAttachment(testDb.db, caller.organizationId)

    await expect(
      callTool(
        'courseAttachments.detach',
        { organizationId: caller.organizationId, attachmentId },
        {
          registry: registry(),
          db: testDb.db,
          accountId: caller.accountId,
          requestConfirmation: () =>
            Promise.reject(new Error('client disconnected mid-elicitation')),
        }
      )
    ).rejects.toThrow(ConfirmationRequiredError)
  })

  it('does not ask for confirmation at all for an ordinary, non-destructive tool', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const requestConfirmation = vi.fn(() => Promise.resolve(false))

    await callTool(
      'projects.create',
      { organizationId: caller.organizationId, name: 'Ordinary' },
      {
        registry: registry(),
        db: testDb.db,
        accountId: caller.accountId,
        requestConfirmation,
      }
    )

    expect(requestConfirmation).not.toHaveBeenCalled()
  })
})
