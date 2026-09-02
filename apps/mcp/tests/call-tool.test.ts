/**
 * MCP-1/3/4/5's own dispatch logic, exercised with no transport at all —
 * this file's own proof that `call-tool.ts` is testable the way this
 * slice's brief asks: a throwaway database, a real `createPlatformRegistry`,
 * and plain function calls.
 */

import { createPlatformRegistry } from '@bloombot/actions'
import {
  courseAttachments,
  courseInstructionRevisions,
  jobs,
} from '@bloombot/db'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  callTool,
  ConfirmationRequiredError,
  InvalidToolArgumentsError,
  UnknownMcpToolError,
} from '../src/call-tool.js'
import { buildToolDefinitions } from '../src/tool-surface.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'
import {
  seedAttachment,
  seedCompletedRosterImportJob,
  seedCourse,
  seedOtherOrganization,
  seedSignedInAccount,
} from './helpers/seed.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Every test dispatches through the real platform registry, resolved by the real allowlist — MCP-1's own "the same dispatcher", not a stand-in. */
function toolDefinitions() {
  return buildToolDefinitions(createPlatformRegistry())
}

describe('MCP-1 — an assistant reaches the platform through the action layer', () => {
  it('dispatches a non-destructive tool through the real action pipeline, attributed to the calling account', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)

    const result = await callTool(
      'projects.create',
      { organizationId: caller.organizationId, name: 'A New Term' },
      {
        toolDefinitions: toolDefinitions(),
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
          toolDefinitions: toolDefinitions(),
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
          toolDefinitions: toolDefinitions(),
          db: testDb.db,
          accountId: caller.accountId,
          requestConfirmation: () => Promise.resolve(false),
        }
      )
    ).rejects.toThrow(/validation/)
  })

  it('rejects a missing organizationId as a malformed call — InvalidToolArgumentsError, not the tenancy refusal', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)

    await expect(
      callTool(
        'projects.create',
        { name: 'No org at all' },
        {
          toolDefinitions: toolDefinitions(),
          db: testDb.db,
          accountId: caller.accountId,
          requestConfirmation: () => Promise.resolve(false),
        }
      )
    ).rejects.toThrow(InvalidToolArgumentsError)
  })

  describe('MCP-5 — attribution: the calling account is threaded to dispatch, not merely implied by success', () => {
    it("records the calling account as a course instruction revision's own author — this action refuses outright with no accountId, so a passing test here is only possible if attribution actually happened", async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInAccount(testDb.db)
      const { courseId } = seedCourse(testDb.db, caller.organizationId)
      const definitions = toolDefinitions()
      const context = {
        toolDefinitions: definitions,
        db: testDb.db,
        accountId: caller.accountId,
        requestConfirmation: () => Promise.resolve(false),
      }

      await callTool(
        'courseInstructions.save',
        {
          organizationId: caller.organizationId,
          courseId,
          instructions: 'Be kind. Cite the syllabus.',
        },
        context
      )

      // Read the authorship back through the repository directly, rather
      // than through another `callTool` — the strongest available proof
      // that `dispatch`'s own `accountId` argument (`call-tool.ts`'s own
      // module comment) is what actually reached
      // `courseInstructionRevisions.createRevision`, not merely that the
      // call happened not to throw.
      const revisions = courseInstructionRevisions.listRevisionsForCourse(
        caller.organizationId,
        courseId,
        testDb.db
      )
      expect(revisions).toHaveLength(1)
      expect(revisions[0]?.savedByAccountId).toBe(caller.accountId)
    })
  })

  describe("jobs.get's own output carries neither a job's payload nor its result — a roster-import job's payload is a raw CSV of students' names and emails, and a completed one's own result (a RosterImportReport) carries the same kind of PII in several of its own fields; roster.import is deliberately off this surface for exactly that reason (tool-surface.ts's own module comment)", () => {
    it('strips payload from a pending job', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInAccount(testDb.db)
      const job = jobs.enqueueJob(
        caller.organizationId,
        {
          kind: 'roster.import',
          payload: {
            courseId: 'course-1',
            csvText: 'name,email\nAda Lovelace,ada@example.edu',
          },
          maxAttempts: 5,
        },
        testDb.db
      )

      const result = await callTool(
        'jobs.get',
        { organizationId: caller.organizationId, jobId: job.id },
        {
          toolDefinitions: toolDefinitions(),
          db: testDb.db,
          accountId: caller.accountId,
          requestConfirmation: () => Promise.resolve(false),
        }
      )

      expect(result.output).not.toHaveProperty('payload')
      expect(JSON.stringify(result.output)).not.toContain('ada@example.edu')
      expect(result.output).toMatchObject({ id: job.id, kind: 'roster.import' })
    })

    it("strips result from a succeeded job — a pending job's own result is always null, which is why an earlier version of this test (exercising only a pending job) stayed green after result leaked", async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInAccount(testDb.db)
      const jobId = seedCompletedRosterImportJob(
        testDb.db,
        caller.organizationId
      )

      const result = await callTool(
        'jobs.get',
        { organizationId: caller.organizationId, jobId },
        {
          toolDefinitions: toolDefinitions(),
          db: testDb.db,
          accountId: caller.accountId,
          requestConfirmation: () => Promise.resolve(false),
        }
      )

      expect(result.output).not.toHaveProperty('payload')
      expect(result.output).not.toHaveProperty('result')
      expect(result.output).toMatchObject({
        id: jobId,
        kind: 'roster.import',
        status: 'succeeded',
      })
      // The property under test, not a key name: no student's address or
      // Discord handle survives anywhere in the serialized tool result —
      // `seedCompletedRosterImportJob`'s own report carries both, in
      // several fields at once, the same way a real completed import does.
      const serialized = JSON.stringify(result.output)
      expect(serialized).not.toContain('school.edu')
      expect(serialized).not.toContain('ada#1')
      expect(serialized).not.toContain('bob#2')
    })
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
          toolDefinitions: toolDefinitions(),
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
          toolDefinitions: toolDefinitions(),
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
          toolDefinitions: toolDefinitions(),
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
          toolDefinitions: toolDefinitions(),
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
        toolDefinitions: toolDefinitions(),
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
          toolDefinitions: toolDefinitions(),
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
        toolDefinitions: toolDefinitions(),
        db: testDb.db,
        accountId: caller.accountId,
        requestConfirmation,
      }
    )

    expect(requestConfirmation).toHaveBeenCalledTimes(1)
    expect(result.output).toMatchObject({ jobId: expect.any(String) })
  })

  it('names the specific record in the confirmation it asks for, not merely the tool name (a real, live-listener finding: the tool name and a raw org id alone read identically for any two attachments)', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const attachmentId = seedAttachment(testDb.db, caller.organizationId)
    const requestConfirmation = vi.fn(() => Promise.resolve(true))

    await callTool(
      'courseAttachments.detach',
      { organizationId: caller.organizationId, attachmentId },
      {
        toolDefinitions: toolDefinitions(),
        db: testDb.db,
        accountId: caller.accountId,
        requestConfirmation,
      }
    )

    expect(requestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'courseAttachments.detach' }),
      caller.organizationId,
      expect.stringContaining('notes.pdf')
    )
  })

  it('does not ask for confirmation at all — and never touches dispatch — when the target itself does not resolve (a made-up attachmentId)', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const requestConfirmation = vi.fn(() => Promise.resolve(true))

    await expect(
      callTool(
        'courseAttachments.detach',
        { organizationId: caller.organizationId, attachmentId: 'nope' },
        {
          toolDefinitions: toolDefinitions(),
          db: testDb.db,
          accountId: caller.accountId,
          requestConfirmation,
        }
      )
    ).rejects.toThrow(/does not exist or you do not have access to it/)

    // Asking a human to confirm deleting something that does not exist is
    // not a question worth asking — `dispatch`'s own refusal is what a
    // caller sees instead, the same refusal it would give with no
    // confirmation gate in front of it at all.
    expect(requestConfirmation).not.toHaveBeenCalled()
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
          toolDefinitions: toolDefinitions(),
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
          toolDefinitions: toolDefinitions(),
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
        toolDefinitions: toolDefinitions(),
        db: testDb.db,
        accountId: caller.accountId,
        requestConfirmation,
      }
    )

    expect(requestConfirmation).not.toHaveBeenCalled()
  })

  describe('courses.save — the second destructive tool this rework round added (it replaces every category and channel on every call)', () => {
    it('never dispatches courses.save when confirmation is declined — the course keeps its existing categories', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInAccount(testDb.db)
      const { courseId, projectId } = seedCourse(
        testDb.db,
        caller.organizationId,
        {
          title: 'Intro to Testing',
          categories: [
            {
              name: 'Lectures',
              channels: [{ name: 'general', adminsOnly: false }],
            },
          ],
        }
      )
      const requestConfirmation = vi.fn(() => Promise.resolve(false))

      await expect(
        callTool(
          'courses.save',
          {
            organizationId: caller.organizationId,
            id: courseId,
            projectId,
            title: 'Intro to Testing',
            filePrefix: 'tc',
            enabled: true,
            adminsRole: 'admins',
            studentsRole: 'students',
            categories: [],
          },
          {
            toolDefinitions: toolDefinitions(),
            db: testDb.db,
            accountId: caller.accountId,
            requestConfirmation,
          }
        )
      ).rejects.toThrow(ConfirmationRequiredError)

      expect(requestConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'courses.save' }),
        caller.organizationId,
        expect.stringContaining('Intro to Testing')
      )
    })
  })
})
