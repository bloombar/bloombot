/**
 * `discordServers.remove` (TEN-6): marks a binding inactive without
 * deleting anything, refuses another organization's binding the same
 * not-found-shaped way every other action does (TEN-5), and is proven not
 * to touch courses, conversations or messages at all — counted before and
 * after, not merely "the binding row still resolves". `discordServers.scaffold`
 * (SRV-6): enqueues rather than working inline — dispatching it creates a
 * job row and reaches no Discord state at all, since this package holds no
 * Discord client to reach one with in the first place.
 */

import {
  conversations,
  courses,
  discordServers,
  jobs,
  people,
  projects,
  schema,
  type Database,
} from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  removeDiscordServerAction,
  scaffoldDiscordServerAction,
} from '../src/actions/discord-servers.js'
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

/** One bare course, no categories — enough for `discordServers.scaffold`'s own policy to resolve. */
function seedCourse(organizationId: string, db: Database): string {
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
      categories: [{ name: 'Week 1', channels: [] }],
    },
    db
  )
  if (!courseResult.ok) throw new Error('setup failed: unexpected conflict')
  return courseResult.course.id
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

describe('discordServers.scaffold (SRV-6)', () => {
  // The action enqueues rather than working inline: dispatching it creates
  // exactly one job row, naming the course, and reaches no Discord state at
  // all — this package holds no Discord client to reach one with.
  it('enqueues a discordServers.scaffold job naming the course, without doing any work inline', async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithBoundServer(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)
    const before = countJobRows(testDb.db)

    const result = await dispatch(
      scaffoldDiscordServerAction,
      { courseId },
      { organizationId, db: testDb.db }
    )

    expect(result.jobId).toEqual(expect.any(String))
    const rows = allJobRows(testDb.db)
    expect(rows).toHaveLength(before + 1)
    const created = rows.find((row) => row.id === result.jobId)
    expect(created).toMatchObject({
      organizationId,
      kind: 'discordServers.scaffold',
      status: 'pending',
    })
    expect(JSON.parse(created?.payload ?? '{}')).toEqual({ courseId })
  })

  // TEN-5: refuses another organization's course the same not-found-shaped
  // way every other action does, enqueueing nothing.
  it("refuses to scaffold another organization's course", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithBoundServer(
      testDb.db,
      'Org A'
    )
    const courseId = seedCourse(orgA, testDb.db)
    const { organizationId: orgB } = seedOrganizationWithBoundServer(
      testDb.db,
      'Org B'
    )

    await expect(
      dispatch(
        scaffoldDiscordServerAction,
        { courseId },
        { organizationId: orgB, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)

    expect(allJobRows(testDb.db)).toHaveLength(0)
  })
})

/** `schema.jobs` row count — a small local helper rather than pulling in `jobs.countQueuedJobs` (which excludes terminal states this test does not create anyway). */
function countJobRows(db: Database): number {
  return db.select().from(schema.jobs).all().length
}

function allJobRows(db: Database): jobs.Job[] {
  return db.select().from(schema.jobs).all()
}
