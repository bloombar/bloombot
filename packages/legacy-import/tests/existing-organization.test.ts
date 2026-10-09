/**
 * MIG-5: importing into an EXISTING organization — one with a UUID id whose
 * courses declare upper-case categories — using `organizationId` and `routes`.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  conversations,
  courses,
  organizations,
  people,
  projects,
} from '@bloombot/db'

import { parseCliArgs } from '../src/cli-args.js'
import { runImport, type ImportReport } from '../src/import.js'
import {
  createLegacyFixture,
  formatLegacyTimestamp,
  type LegacyFixture,
} from './helpers/legacy-fixture.js'
import {
  createTestPlatformDatabase,
  type TestPlatformDatabase,
} from './helpers/platform-db.js'

const ALICE = '200000000000000001'
const BOB = '200000000000000002'
const CAROL = '200000000000000003'
const T0 = Date.parse('2026-06-01T10:00:00.000Z')
const at = (s: number): string => formatLegacyTimestamp(T0 + s * 1000)

let testDb: TestPlatformDatabase
let fixtures: LegacyFixture[] = []

afterEach(() => {
  testDb.cleanup()
  for (const f of fixtures) f.cleanup()
  fixtures = []
})

interface World {
  orgId: string
  pythonId: string
  webId: string
  otherOrgCourseId: string
}

function newCourse(projectId: string, title: string, category: string) {
  return {
    projectId,
    title,
    enabled: true,
    adminsRole: `admins-${title}`,
    studentsRole: `students-${title}`,
    promptId: 'pmpt',
    instructions: null,
    model: null,
    vectorStoreId: null,
    maxRequestsPerDay: null,
    categories: [{ name: category, channels: [] }],
  }
}

/** An organization with a UUID id and upper-case categories, plus an unrelated second one. */
function buildWorld(): World {
  testDb = createTestPlatformDatabase()
  const db = testDb.db
  const orgId = randomUUID()
  organizations.createOrganization(
    orgId,
    { name: 'Summer', isPersonal: false },
    db
  )
  const project = projects.createProject(orgId, { name: 'Summer' }, db)
  const make = (title: string, category: string): string => {
    const result = courses.createCourse(
      orgId,
      newCourse(project.id, title, category),
      db
    )
    if (!result.ok) throw new Error('fixture course refused')
    return result.course.id
  }
  const pythonId = make('Python', 'PYTHON - STUDENTS 01')
  const webId = make('Web Design', 'WEB DESIGN - STUDENTS 01')

  const otherOrg = randomUUID()
  organizations.createOrganization(
    otherOrg,
    { name: 'Other', isPersonal: false },
    db
  )
  const otherProject = projects.createProject(otherOrg, { name: 'Other' }, db)
  const other = courses.createCourse(
    otherOrg,
    newCourse(otherProject.id, 'Python', 'PYTHON - X'),
    db
  )
  if (!other.ok) throw new Error('fixture course refused')
  return { orgId, pythonId, webId, otherOrgCourseId: other.course.id }
}

function row(
  userId: number,
  content: string,
  seconds: number,
  category: string,
  direction: 'to' | 'from' = 'from'
) {
  return {
    userId,
    content,
    category,
    channel: 'general',
    direction,
    createdAt: at(seconds),
  }
}

/** First snapshot: three rows, mixed-case declared categories. */
function snapshotP(): LegacyFixture {
  const f = createLegacyFixture()
  const alice = f.insertUser({ discordId: ALICE })
  const bob = f.insertUser({ discordId: BOB })
  f.insertMessage(row(alice, 'p1', 0, 'Python - Students 01'))
  f.insertMessage(row(bob, 'p2', 1, 'Web Design - STUDENTS 01'))
  f.insertMessage(row(alice, 'p3', 2, 'python - students 01 '))
  f.close()
  fixtures.push(f)
  return f
}

/** Later snapshot: ids restart; rows 1..2 repeat P, 3..5 are new, 3 is an undeclared GLOBAL. */
function snapshotQ(extra?: (f: LegacyFixture, userIds: number[]) => void) {
  const f = createLegacyFixture()
  const bob = f.insertUser({ discordId: BOB })
  const alice = f.insertUser({ discordId: ALICE })
  const carol = f.insertUser({ discordId: CAROL })
  f.insertMessage(row(alice, 'p1', 0, 'Python - STUDENTS 01'))
  f.insertMessage(row(bob, 'p2', 1, 'Web Design - Students 01'))
  f.insertMessage(row(alice, 'q3 global', 10, 'Python - GLOBAL'))
  f.insertMessage(row(carol, 'q4', 11, 'Web Design - GLOBAL'))
  f.insertMessage(row(carol, 'q5', 12, 'Python - Students 01'))
  extra?.(f, [bob, alice, carol])
  f.close()
  fixtures.push(f)
  return f
}

const routes = (w: World) => [
  { prefix: 'python', courseId: w.pythonId },
  { prefix: 'Web Design', courseId: w.webId },
]

function run(
  w: World,
  path: string,
  extra: { source?: string; routes?: ReturnType<typeof routes> } = {}
): ImportReport {
  return runImport({
    snapshotPath: path,
    yamlPath: '-',
    db: testDb.db,
    organizationId: w.orgId,
    ...extra,
  })
}

function count(table: string): number {
  return (
    testDb.db.$client.prepare(`select count(*) as n from ${table}`).get() as {
      n: number
    }
  ).n
}

describe('importing into an existing organization (MIG-5)', () => {
  it('places every row, creating only people, identities, conversations and messages', () => {
    const w = buildWorld()
    const p = snapshotP()
    const q = snapshotQ()
    run(w, p.path)
    const before = {
      orgs: count('organizations'),
      projects: count('projects'),
      courses: count('courses'),
      categories: count('course_categories'),
    }
    const report = run(w, q.path, { source: 'q', routes: routes(w) })

    expect(report.messages).toMatchObject({
      created: 3,
      matchedByContent: 2,
      matched: 0,
      unplaceable: [],
    })
    expect(report.people).toMatchObject({ created: 1, matched: 2 })
    expect({
      orgs: count('organizations'),
      projects: count('projects'),
      courses: count('courses'),
      categories: count('course_categories'),
    }).toEqual(before)
    expect(count('messages')).toBe(6)
    expect(people.listPeople(w.orgId, testDb.db)).toHaveLength(3)
    // The course the undeclared GLOBAL category was routed to got the message,
    // with the legacy category kept as its reference.
    const python = conversations
      .listConversationsForCourse(w.orgId, w.pythonId, testDb.db)
      .flatMap((c) => conversations.getTranscript(w.orgId, c.id, testDb.db))
    expect(python.find((m) => m.content === 'q3 global')?.categoryRef).toBe(
      'Python - GLOBAL'
    )
    expect(testDb.db.$client.pragma('foreign_key_check')).toEqual([])
  })

  it('matches declared categories case-insensitively without any route', () => {
    const w = buildWorld()
    const report = run(w, snapshotP().path)
    expect(report.messages).toMatchObject({ created: 3, unplaceable: [] })
  })

  it('changes nothing on a re-run', () => {
    const w = buildWorld()
    const q = snapshotQ()
    run(w, q.path, { source: 'q', routes: routes(w) })
    const messagesBefore = count('messages')
    const again = run(w, q.path, { source: 'q', routes: routes(w) })
    expect(again.messages).toMatchObject({ created: 0, matched: 5 })
    expect(again.people.created).toBe(0)
    expect(count('messages')).toBe(messagesBefore)
  })

  it('reports a category nothing routes, rather than dropping it', () => {
    const w = buildWorld()
    const q = snapshotQ((f, [bob]) =>
      f.insertMessage(row(bob!, 'banter', 20, 'Banter'))
    )
    const report = run(w, q.path, { routes: routes(w) })
    expect(report.messages.unplaceable).toHaveLength(1)
    expect(report.messages.unplaceable[0]?.reason).toMatch(/Banter/)
  })

  it('lets an explicit route win over a declared category', () => {
    const w = buildWorld()
    const f = createLegacyFixture()
    const alice = f.insertUser({ discordId: ALICE })
    f.insertMessage(row(alice, 'x', 0, 'Python - STUDENTS 01'))
    f.close()
    fixtures.push(f)
    run(w, f.path, { routes: [{ prefix: 'Python', courseId: w.webId }] })
    const inWeb = conversations.listConversationsForCourse(
      w.orgId,
      w.webId,
      testDb.db
    )
    expect(inWeb).toHaveLength(1)
  })

  it('refuses an unknown organization, and a route to an unknown or foreign course', () => {
    const w = buildWorld()
    const q = snapshotQ()
    expect(() =>
      runImport({
        snapshotPath: q.path,
        yamlPath: '-',
        db: testDb.db,
        organizationId: randomUUID(),
      })
    ).toThrow(/does not exist/)
    expect(() =>
      run(w, q.path, { routes: [{ prefix: 'Python', courseId: randomUUID() }] })
    ).toThrow(/does not exist/)
    expect(() =>
      run(w, q.path, {
        routes: [{ prefix: 'Python', courseId: w.otherOrgCourseId }],
      })
    ).toThrow(/does not exist/)
    expect(count('messages')).toBe(0)
    expect(count('people')).toBe(0)
  })
})

describe('isolation between organizations (MIG-5, TEN-2)', () => {
  it('creates a new person for a Discord user known only to another organization', () => {
    const w = buildWorld()
    // The same Discord user already exists in the unrelated organization.
    const otherOrgId = (
      testDb.db.$client
        .prepare('select organization_id as id from courses where id = ?')
        .get(w.otherOrgCourseId) as { id: string }
    ).id
    const stranger = people.resolvePersonByIdentity(
      otherOrgId,
      { surface: 'discord', externalId: ALICE },
      testDb.db
    )
    const othersBefore = people.listPeople(otherOrgId, testDb.db)

    const report = run(w, snapshotP().path)
    expect(report.people).toMatchObject({ created: 2, matched: 0 })

    const mine = people.listPeople(w.orgId, testDb.db)
    expect(mine).toHaveLength(2)
    expect(mine.map((p) => p.id)).not.toContain(stranger.id)
    expect(people.listPeople(otherOrgId, testDb.db)).toEqual(othersBefore)

    // Every message agrees with its conversation, person and course on org.
    const mismatched = testDb.db.$client
      .prepare(
        `select count(*) as n from messages m
         join conversations c on c.id = m.conversation_id
         join people p on p.id = m.person_id
         join courses k on k.id = m.course_id
         where m.organization_id != c.organization_id
            or m.organization_id != p.organization_id
            or m.organization_id != k.organization_id`
      )
      .get() as { n: number }
    expect(mismatched.n).toBe(0)
    expect(count('messages')).toBe(3)
    expect(testDb.db.$client.pragma('foreign_key_check')).toEqual([])
  })
})

describe('parseCliArgs --organization / --route (MIG-5)', () => {
  it('reads both flags, with --route repeatable', () => {
    const parsed = parseCliArgs([
      's.db',
      '-',
      '--organization',
      'org-1',
      '--route',
      'Python=c1',
      '--route=Web Design=c2',
    ])
    expect(parsed).toMatchObject({
      yamlPath: '-',
      organizationId: 'org-1',
      routes: [
        { prefix: 'Python', courseId: 'c1' },
        { prefix: 'Web Design', courseId: 'c2' },
      ],
    })
  })

  it('refuses two routes with the same prefix, ignoring case', () => {
    expect(() =>
      parseCliArgs([
        's',
        '-',
        '--organization',
        'o',
        '--route',
        'Python=a',
        '--route',
        'python=b',
      ])
    ).toThrow(/more than once/)
    const w = buildWorld()
    expect(() =>
      run(w, snapshotP().path, {
        routes: [
          { prefix: 'Python', courseId: w.pythonId },
          { prefix: 'PYTHON', courseId: w.webId },
        ],
      })
    ).toThrow(/more than once/)
    expect(count('messages')).toBe(0)
  })

  it('refuses a malformed route, an empty organization, and a route without one', () => {
    expect(() =>
      parseCliArgs(['s', '-', '--organization', 'o', '--route', 'nope'])
    ).toThrow(/Python=/)
    expect(() => parseCliArgs(['s', '-', '--organization', ''])).toThrow(
      /non-empty/
    )
    expect(() => parseCliArgs(['s', '-', '--route', 'P=c'])).toThrow(
      /--organization/
    )
  })
})
