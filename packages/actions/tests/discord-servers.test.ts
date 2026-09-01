/**
 * `discordServers.remove` (TEN-6): marks a binding inactive without
 * deleting anything, refuses another organization's binding the same
 * not-found-shaped way every other action does (TEN-5), and is proven not
 * to touch courses, conversations or messages at all — counted before and
 * after, not merely "the binding row still resolves".
 */

import {
  conversations,
  courses,
  discordServers,
  people,
  projects,
  schema,
  type Database,
} from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import { removeDiscordServerAction } from '../src/actions/discord-servers.js'
import { dispatch } from '../src/dispatch.js'
import { ActionRefusedError } from '../src/errors.js'
import { seedOrganizationWithBoundServer } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** One course, one person, and a conversation with a couple of messages — TEN-6's own "deletes nothing" claim needs actual rows to count. */
function seedCourseConversationAndMessages(
  organizationId: string,
  db: Database
) {
  const project = projects.createProject(
    organizationId,
    { name: 'Test Term' },
    db
  )
  const courseResult = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Test Course',
      filePrefix: 'tc',
      enabled: true,
      adminsRole: 'admins-tc',
      studentsRole: 'students-tc',
      categories: [],
    },
    db
  )
  if (!courseResult.ok) throw new Error('setup failed: unexpected conflict')

  const person = people.createPerson(organizationId, {}, db)
  const conversation = conversations.getOrCreateConversation(
    organizationId,
    {
      courseId: courseResult.course.id,
      personId: person.id,
      surface: 'discord',
    },
    db
  )
  if (!conversation) throw new Error('setup failed: no conversation')

  conversations.appendMessage(
    organizationId,
    conversation.id,
    { direction: 'from_person', content: 'Hello' },
    db
  )
  conversations.appendMessage(
    organizationId,
    conversation.id,
    { direction: 'to_person', content: 'Hi there' },
    db
  )
}

/** Row counts across the tables TEN-6 promises removal never touches. */
function countRows(db: Database): {
  courses: number
  conversations: number
  messages: number
} {
  return {
    courses: db.select().from(schema.courses).all().length,
    conversations: db.select().from(schema.conversations).all().length,
    messages: db.select().from(schema.messages).all().length,
  }
}

describe('discordServers.remove', () => {
  it('marks an active binding inactive', async () => {
    testDb = createTestDatabase()
    const { organizationId, serverId } = seedOrganizationWithBoundServer(
      testDb.db
    )

    const result = await dispatch(
      removeDiscordServerAction,
      { serverId },
      { organizationId, db: testDb.db }
    )

    expect(result).toEqual({ removed: true })
    expect(
      discordServers.resolveDiscordServerBinding(serverId, testDb.db)
    ).toBeUndefined()
  })

  // TEN-6: a re-installation restores a working binding — removal is not a
  // one-way door.
  it('a removed binding can be re-claimed afterward', async () => {
    testDb = createTestDatabase()
    const { organizationId, serverId, installerAccountId } =
      seedOrganizationWithBoundServer(testDb.db)
    await dispatch(
      removeDiscordServerAction,
      { serverId },
      { organizationId, db: testDb.db }
    )

    const reclaimed = discordServers.claimDiscordServerBinding(
      organizationId,
      { serverId, installedByAccountId: installerAccountId },
      testDb.db
    )
    expect(reclaimed).toMatchObject({ serverId, organizationId })
    expect(
      discordServers.resolveDiscordServerBinding(serverId, testDb.db)
    ).toMatchObject({ organizationId })
  })

  // TEN-5: refused the same not-found-shaped way every other action
  // refuses a cross-tenant record — the binding itself is left untouched.
  it("refuses to remove another organization's binding", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA, serverId } = seedOrganizationWithBoundServer(
      testDb.db,
      'Org A'
    )
    const { organizationId: orgB } = seedOrganizationWithBoundServer(
      testDb.db,
      'Org B'
    )

    await expect(
      dispatch(
        removeDiscordServerAction,
        { serverId },
        { organizationId: orgB, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)

    expect(
      discordServers.resolveDiscordServerBinding(serverId, testDb.db)
    ).toMatchObject({ organizationId: orgA })
  })

  it('refuses to remove a binding that does not exist', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganizationWithBoundServer(
      testDb.db
    ).organizationId

    await expect(
      dispatch(
        removeDiscordServerAction,
        { serverId: 'no-such-server' },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  // TEN-6: "never deletes the organization's courses, rosters or
  // transcripts" — counted, not merely inferred from the binding's own row
  // surviving.
  it('deletes no courses, conversations or messages', async () => {
    testDb = createTestDatabase()
    const { organizationId, serverId } = seedOrganizationWithBoundServer(
      testDb.db
    )
    seedCourseConversationAndMessages(organizationId, testDb.db)
    const before = countRows(testDb.db)
    expect(before).toEqual({ courses: 1, conversations: 1, messages: 2 })

    await dispatch(
      removeDiscordServerAction,
      { serverId },
      { organizationId, db: testDb.db }
    )

    expect(countRows(testDb.db)).toEqual(before)
  })
})
