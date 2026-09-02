/**
 * `people.ts#connectIdentity`/`#mergePeople` (LINK-3, LINK-4, PPL-4): the
 * connect-a-second-surface half of `people.ts` — a proof attaching an
 * identity to an existing person, and the merge that follows when that
 * identity already belongs to someone else. Each test below fails without
 * the code it names; see the report for how each was confirmed.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  conversations,
  courses,
  enrolments,
  organizations,
  people,
  personLinkChallenges,
  projects,
  usage,
  type Database,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** One organization with one project and one enabled course — the smallest graph LINK-4's merge needs to exercise conversations, usage and enrolments. Synthetic data only (QA-3). */
function seedOrgWithCourse(db: Database) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Org', isPersonal: false },
    db
  )
  const project = projects.createProject(organizationId, { name: 'Term' }, db)
  const courseResult = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Course',
      filePrefix: 'c',
      enabled: true,
      adminsRole: 'admins-c',
      studentsRole: 'students-c',
      categories: [],
    },
    db
  )
  if (!courseResult.ok) {
    throw new Error(`seedOrgWithCourse: ${courseResult.conflict.message}`)
  }
  return { organizationId, courseId: courseResult.course.id }
}

/** A second, independent course in the same organization — for the "two conversations, two courses" case. */
function seedSecondCourse(db: Database, organizationId: string) {
  const project = projects.createProject(
    organizationId,
    { name: `Term ${randomUUID()}` },
    db
  )
  const courseResult = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Second Course',
      filePrefix: `c2-${randomUUID().slice(0, 8)}`,
      enabled: true,
      adminsRole: `admins-c2-${randomUUID()}`,
      studentsRole: `students-c2-${randomUUID()}`,
      categories: [],
    },
    db
  )
  if (!courseResult.ok) {
    throw new Error(`seedSecondCourse: ${courseResult.conflict.message}`)
  }
  return courseResult.course.id
}

describe('people.ts#connectIdentity (LINK-3)', () => {
  it('attaches a never-before-seen identity to an existing person', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)
    const person = people.createPerson(organizationId, {}, testDb.db)

    const identity = people.connectIdentity(
      organizationId,
      person.id,
      { surface: 'discord', externalId: 'snowflake-1' },
      testDb.db
    )

    expect(identity?.personId).toBe(person.id)
    expect(
      people.resolveIdentity(
        organizationId,
        { surface: 'discord', externalId: 'snowflake-1' },
        testDb.db
      )?.id
    ).toBe(person.id)
  })

  // D-35 rework, finding 1 — before this fix, attaching a never-before-seen
  // identity (the *only* thing an MCP connect ever does, and a Discord
  // connect for anyone who has not yet messaged the bot) left `connectedAt`
  // null: the proof succeeded, but the person was still declined by LINK-1's
  // own gate on their very next message, with clicking through again being
  // idempotent (so the loop never terminated).
  it('sets connectedAt when attaching a never-before-seen identity — the case a bare MCP connect always is', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)
    const person = people.createPerson(organizationId, {}, testDb.db)
    expect(person.connectedAt).toBeNull()

    people.connectIdentity(
      organizationId,
      person.id,
      { surface: 'mcp', externalId: 'mcp-client-1' },
      testDb.db
    )

    const reread = people.getPerson(organizationId, person.id, testDb.db)
    expect(reread?.connectedAt).not.toBeNull()
  })

  it('is idempotent when the identity already belongs to this same person', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)
    const person = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'discord', externalId: 'snowflake-1' },
      testDb.db
    )

    const second = people.connectIdentity(
      organizationId,
      person.id,
      { surface: 'discord', externalId: 'snowflake-1' },
      testDb.db
    )

    expect(second?.personId).toBe(person.id)
    expect(people.listPeople(organizationId, testDb.db)).toHaveLength(1)
    // Re-proving an identity you already hold is still a proof (LINK-3's
    // own point) — connectedAt is set even on the idempotent branch.
    expect(
      people.getPerson(organizationId, person.id, testDb.db)?.connectedAt
    ).not.toBeNull()
  })

  it('never moves connectedAt backward once set — a second, later connect keeps the first timestamp', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)
    const person = people.createPerson(organizationId, {}, testDb.db)
    people.connectIdentity(
      organizationId,
      person.id,
      { surface: 'mcp', externalId: 'mcp-client-1' },
      testDb.db
    )
    const firstConnectedAt = people.getPerson(
      organizationId,
      person.id,
      testDb.db
    )?.connectedAt

    people.connectIdentity(
      organizationId,
      person.id,
      { surface: 'web', externalId: 'account-1' },
      testDb.db
    )

    expect(
      people.getPerson(organizationId, person.id, testDb.db)?.connectedAt
    ).toBe(firstConnectedAt)
  })

  // D-35 rework, finding 2 — a person already merged away is a tombstone,
  // the same guard `mergePeople` already gives its own survivor. Without
  // this, a proof completing against a person concurrently merged away by a
  // *different*, faster proof would attach a real identity to a record
  // nothing can ever reach again.
  it('refuses when personId has itself already been merged into someone else', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)
    const survivor = people.createPerson(organizationId, {}, testDb.db)
    const mergedAway = people.createPerson(organizationId, {}, testDb.db)
    people.mergePeople(organizationId, survivor.id, mergedAway.id, testDb.db)

    expect(
      people.connectIdentity(
        organizationId,
        mergedAway.id,
        { surface: 'mcp', externalId: 'mcp-client-1' },
        testDb.db
      )
    ).toBeUndefined()
  })

  it('refuses when the identity already belongs to a different person — LINK-4 is the caller for that case, not this function', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)
    const owner = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'discord', externalId: 'snowflake-1' },
      testDb.db
    )
    const other = people.createPerson(organizationId, {}, testDb.db)

    expect(owner.id).not.toBe(other.id)
    expect(
      people.connectIdentity(
        organizationId,
        other.id,
        { surface: 'discord', externalId: 'snowflake-1' },
        testDb.db
      )
    ).toBeUndefined()
  })

  it('refuses a personId belonging to another organization (TEN-2)', () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrgWithCourse(testDb.db)
    const { organizationId: orgB } = seedOrgWithCourse(testDb.db)
    const personInB = people.createPerson(orgB, {}, testDb.db)

    expect(
      people.connectIdentity(
        orgA,
        personInB.id,
        { surface: 'discord', externalId: 'snowflake-1' },
        testDb.db
      )
    ).toBeUndefined()
  })
})

describe('people.ts#mergePeople (LINK-4)', () => {
  it('moves every identity from the loser to the survivor', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)
    const survivor = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'web', externalId: 'account-1' },
      testDb.db
    )
    const loser = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'discord', externalId: 'snowflake-1' },
      testDb.db
    )

    const result = people.mergePeople(
      organizationId,
      survivor.id,
      loser.id,
      testDb.db
    )

    expect(result?.alreadyMerged).toBe(false)
    expect(
      people.resolveIdentity(
        organizationId,
        { surface: 'discord', externalId: 'snowflake-1' },
        testDb.db
      )?.id
    ).toBe(survivor.id)
  })

  it('marks the survivor connected (LINK-1s own gate) and the loser as merged into it', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)
    const survivor = people.createPerson(organizationId, {}, testDb.db)
    const loser = people.createPerson(organizationId, {}, testDb.db)

    const result = people.mergePeople(
      organizationId,
      survivor.id,
      loser.id,
      testDb.db
    )

    expect(result?.survivor.connectedAt).not.toBeNull()
    const rereadLoser = people.getPerson(organizationId, loser.id, testDb.db)
    expect(rereadLoser?.mergedIntoPersonId).toBe(survivor.id)
    expect(rereadLoser?.mergedAt).not.toBeNull()
  })

  it('preserves both transcripts when the two people have conversations on different courses', () => {
    testDb = createTestDatabase()
    const { organizationId, courseId } = seedOrgWithCourse(testDb.db)
    const secondCourseId = seedSecondCourse(testDb.db, organizationId)
    const survivor = people.createPerson(organizationId, {}, testDb.db)
    const loser = people.createPerson(organizationId, {}, testDb.db)

    const survivorConversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId, personId: survivor.id, surface: 'discord' },
      testDb.db
    )
    const loserConversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId: secondCourseId, personId: loser.id, surface: 'discord' },
      testDb.db
    )
    if (!survivorConversation || !loserConversation) {
      throw new Error('setup failed')
    }
    conversations.appendMessage(
      organizationId,
      survivorConversation.id,
      { direction: 'from_person', content: 'survivor question' },
      testDb.db
    )
    conversations.appendMessage(
      organizationId,
      loserConversation.id,
      { direction: 'from_person', content: 'loser question' },
      testDb.db
    )

    people.mergePeople(organizationId, survivor.id, loser.id, testDb.db)

    // No collision on this course pair — the loser's own conversation moves
    // to the survivor outright.
    const movedTranscript = conversations.getTranscript(
      organizationId,
      loserConversation.id,
      testDb.db
    )
    expect(movedTranscript.map((m) => m.content)).toEqual(['loser question'])
    const movedConversation = conversations.getConversation(
      organizationId,
      loserConversation.id,
      testDb.db
    )
    expect(movedConversation?.personId).toBe(survivor.id)

    const survivorTranscript = conversations.getTranscript(
      organizationId,
      survivorConversation.id,
      testDb.db
    )
    expect(survivorTranscript.map((m) => m.content)).toEqual([
      'survivor question',
    ])
  })

  it('combines both transcripts, in chronological order, when both people have a conversation on the same course', () => {
    testDb = createTestDatabase()
    const { organizationId, courseId } = seedOrgWithCourse(testDb.db)
    const survivor = people.createPerson(organizationId, {}, testDb.db)
    const loser = people.createPerson(organizationId, {}, testDb.db)

    const survivorConversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId, personId: survivor.id, surface: 'discord' },
      testDb.db
    )
    const loserConversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId, personId: loser.id, surface: 'discord' },
      testDb.db
    )
    if (!survivorConversation || !loserConversation) {
      throw new Error('setup failed')
    }
    // Explicit `createdAt`s (MIG-1's own `appendMessage` parameter),
    // increasing within each conversation (a real transcript's own
    // invariant) but interleaved *between* the two, so the merge's own
    // chronological interleaving is actually exercised, not just two lists
    // concatenated.
    conversations.appendMessage(
      organizationId,
      survivorConversation.id,
      { direction: 'from_person', content: 's1', createdAt: 1000 },
      testDb.db
    )
    conversations.appendMessage(
      organizationId,
      loserConversation.id,
      { direction: 'from_person', content: 'l1', createdAt: 2000 },
      testDb.db
    )
    conversations.appendMessage(
      organizationId,
      survivorConversation.id,
      { direction: 'from_person', content: 's2', createdAt: 3000 },
      testDb.db
    )
    conversations.appendMessage(
      organizationId,
      loserConversation.id,
      { direction: 'from_person', content: 'l2', createdAt: 4000 },
      testDb.db
    )

    const result = people.mergePeople(
      organizationId,
      survivor.id,
      loser.id,
      testDb.db
    )
    expect(result?.alreadyMerged).toBe(false)

    // The survivor's own conversation row is the one that keeps all four
    // messages, interleaved by when they actually happened — not by which
    // person sent them.
    const merged = conversations.getTranscript(
      organizationId,
      survivorConversation.id,
      testDb.db
    )
    expect(merged.map((m) => m.content)).toEqual(['s1', 'l1', 's2', 'l2'])
    expect(merged.every((m) => m.personId === survivor.id)).toBe(true)

    // The loser's own conversation row is left in place, now empty — not
    // reassigned (that would collide with the survivor's own row for the
    // same course) and not deleted.
    const loserTranscript = conversations.getTranscript(
      organizationId,
      loserConversation.id,
      testDb.db
    )
    expect(loserTranscript).toHaveLength(0)
  })

  it("combines the day's usage — the count is the sum, never the larger of the two and never reset", () => {
    testDb = createTestDatabase()
    const { organizationId, courseId } = seedOrgWithCourse(testDb.db)
    const survivor = people.createPerson(organizationId, {}, testDb.db)
    const loser = people.createPerson(organizationId, {}, testDb.db)
    const day = '2026-01-01'

    usage.incrementUsage(organizationId, courseId, survivor.id, day, testDb.db)
    usage.incrementUsage(organizationId, courseId, survivor.id, day, testDb.db)
    usage.incrementUsage(organizationId, courseId, loser.id, day, testDb.db)
    usage.incrementUsage(organizationId, courseId, loser.id, day, testDb.db)
    usage.incrementUsage(organizationId, courseId, loser.id, day, testDb.db)

    people.mergePeople(organizationId, survivor.id, loser.id, testDb.db)

    // 2 (survivor) + 3 (loser) = 5 — not 3 (the larger of the two) and not
    // reset back to 0 or 2.
    expect(
      usage.getUsageCount(organizationId, courseId, survivor.id, day, testDb.db)
    ).toBe(5)
  })

  it('ends, rather than moves, the losers active enrolment when the survivor already holds one for the same course', () => {
    testDb = createTestDatabase()
    const { organizationId, courseId } = seedOrgWithCourse(testDb.db)
    const survivor = people.createPerson(organizationId, {}, testDb.db)
    const loser = people.createPerson(organizationId, {}, testDb.db)

    const survivorEnrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId, personId: survivor.id },
      testDb.db
    )
    const loserEnrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId, personId: loser.id },
      testDb.db
    )
    expect(survivorEnrolment).toBeDefined()
    expect(loserEnrolment).toBeDefined()

    people.mergePeople(organizationId, survivor.id, loser.id, testDb.db)

    // Exactly one active enrolment for (course, survivor) — the unique
    // constraint `mergePeople` has to avoid colliding with.
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        courseId,
        survivor.id,
        testDb.db
      )?.id
    ).toBe(survivorEnrolment?.id)
    // The loser's own row is ended, not silently dropped.
    const rereadLoserEnrolment = enrolments.getEnrolment(
      organizationId,
      loserEnrolment?.id as string,
      testDb.db
    )
    expect(rereadLoserEnrolment?.endedAt).not.toBeNull()
  })

  it('is idempotent — a second call with the same pair does nothing further, and does not double the combined usage', () => {
    testDb = createTestDatabase()
    const { organizationId, courseId } = seedOrgWithCourse(testDb.db)
    const survivor = people.createPerson(organizationId, {}, testDb.db)
    const loser = people.createPerson(organizationId, {}, testDb.db)
    const day = '2026-01-01'
    usage.incrementUsage(organizationId, courseId, loser.id, day, testDb.db)

    const first = people.mergePeople(
      organizationId,
      survivor.id,
      loser.id,
      testDb.db
    )
    const second = people.mergePeople(
      organizationId,
      survivor.id,
      loser.id,
      testDb.db
    )

    expect(first?.alreadyMerged).toBe(false)
    expect(second?.alreadyMerged).toBe(true)
    expect(
      usage.getUsageCount(organizationId, courseId, survivor.id, day, testDb.db)
    ).toBe(1)
  })

  it('moves an ended enrolment to the survivor outright — no collision to avoid', () => {
    testDb = createTestDatabase()
    const { organizationId, courseId } = seedOrgWithCourse(testDb.db)
    const survivor = people.createPerson(organizationId, {}, testDb.db)
    const loser = people.createPerson(organizationId, {}, testDb.db)
    const loserEnrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId, personId: loser.id },
      testDb.db
    )
    if (!loserEnrolment) throw new Error('setup failed')
    enrolments.endEnrolment(organizationId, loserEnrolment.id, testDb.db)

    people.mergePeople(organizationId, survivor.id, loser.id, testDb.db)

    const reread = enrolments.getEnrolment(
      organizationId,
      loserEnrolment.id,
      testDb.db
    )
    expect(reread?.personId).toBe(survivor.id)
    expect(reread?.endedAt).not.toBeNull()
  })

  it("moves the loser's active enrolment to the survivor outright when the survivor holds none for that course", () => {
    testDb = createTestDatabase()
    const { organizationId, courseId } = seedOrgWithCourse(testDb.db)
    const survivor = people.createPerson(organizationId, {}, testDb.db)
    const loser = people.createPerson(organizationId, {}, testDb.db)
    const loserEnrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId, personId: loser.id },
      testDb.db
    )

    people.mergePeople(organizationId, survivor.id, loser.id, testDb.db)

    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        courseId,
        survivor.id,
        testDb.db
      )?.id
    ).toBe(loserEnrolment?.id)
  })

  it('refuses when the survivor has itself already been merged into someone else', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)
    const alreadyMergedAway = people.createPerson(organizationId, {}, testDb.db)
    const somebodyElse = people.createPerson(organizationId, {}, testDb.db)
    people.mergePeople(
      organizationId,
      somebodyElse.id,
      alreadyMergedAway.id,
      testDb.db
    )
    const freshLoser = people.createPerson(organizationId, {}, testDb.db)

    expect(
      people.mergePeople(
        organizationId,
        alreadyMergedAway.id,
        freshLoser.id,
        testDb.db
      )
    ).toBeUndefined()
  })

  it('refuses when the loser has already been merged into a different survivor — a conflicting merge, not a replay', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)
    const firstSurvivor = people.createPerson(organizationId, {}, testDb.db)
    const loser = people.createPerson(organizationId, {}, testDb.db)
    people.mergePeople(organizationId, firstSurvivor.id, loser.id, testDb.db)
    const secondSurvivor = people.createPerson(organizationId, {}, testDb.db)

    expect(
      people.mergePeople(organizationId, secondSurvivor.id, loser.id, testDb.db)
    ).toBeUndefined()
  })

  // D-35 rework, finding 2 — the concrete race the finding names: L begins
  // a Discord connect attempt (a still-live, unredeemed challenge naming L
  // as its own survivor); before L returns to redeem it, a *different*,
  // faster proof merges L into S. Without repointing, L's still-live
  // challenge would later redeem successfully and then attach a genuinely
  // proven identity to a tombstone `mergePeople` now refuses as a survivor
  // — a legitimate connect attempt permanently declined with no recovery
  // path.
  it("re-points the loser's outstanding Discord challenge to the survivor, so an in-flight connect attempt still completes", () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)
    const survivor = people.createPerson(organizationId, {}, testDb.db)
    const loser = people.createPerson(organizationId, {}, testDb.db)
    const challenge = personLinkChallenges.createChallenge(
      {
        organizationId,
        surface: 'discord',
        personId: loser.id,
        codeVerifier: 'verifier-1',
        secretHash: 'some-hash',
        expiresAt: Date.now() + 10 * 60 * 1000,
      },
      testDb.db
    )

    people.mergePeople(organizationId, survivor.id, loser.id, testDb.db)

    // Read back through the repo's own read path (`peekChallenge`, the same
    // lookup a real redemption uses), not a raw column poke — proves the
    // row a real redemption would actually see now resolves the survivor.
    const stillLive = personLinkChallenges.peekChallenge(
      'some-hash',
      'discord',
      Date.now(),
      testDb.db
    )
    expect(stillLive?.id).toBe(challenge.id)
    expect(stillLive?.personId).toBe(survivor.id)
  })

  it('does not touch an mcp challenge on merge — it was never bound to a survivor at issue time', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)
    const survivor = people.createPerson(organizationId, {}, testDb.db)
    const loser = people.createPerson(organizationId, {}, testDb.db)
    personLinkChallenges.createChallenge(
      {
        organizationId,
        surface: 'mcp',
        identityExternalId: 'mcp-client-1',
        secretHash: 'mcp-hash',
        expiresAt: Date.now() + 10 * 60 * 1000,
      },
      testDb.db
    )

    people.mergePeople(organizationId, survivor.id, loser.id, testDb.db)

    const stillThere = personLinkChallenges.peekChallenge(
      'mcp-hash',
      'mcp',
      Date.now(),
      testDb.db
    )
    expect(stillThere).toBeDefined()
  })

  it('refuses to merge a person into itself', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)
    const person = people.createPerson(organizationId, {}, testDb.db)

    expect(
      people.mergePeople(organizationId, person.id, person.id, testDb.db)
    ).toBeUndefined()
  })

  it('refuses a survivor or loser id belonging to another organization (TEN-2)', () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrgWithCourse(testDb.db)
    const { organizationId: orgB } = seedOrgWithCourse(testDb.db)
    const personInA = people.createPerson(orgA, {}, testDb.db)
    const personInB = people.createPerson(orgB, {}, testDb.db)

    expect(
      people.mergePeople(orgA, personInA.id, personInB.id, testDb.db)
    ).toBeUndefined()
    expect(
      people.mergePeople(orgA, personInB.id, personInA.id, testDb.db)
    ).toBeUndefined()
  })
})

describe('PPL-4: an address match alone never links anything', () => {
  it('two people who happen to share the same roster-merged email stay two separate, unmerged people', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)

    const personA = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'discord', externalId: 'snowflake-a' },
      testDb.db
    )
    const personB = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'discord', externalId: 'snowflake-b' },
      testDb.db
    )
    // A roster's own assertion about both — PPL-4's own "a roster's email is
    // an instructor's assertion ... and is corroboration at best".
    people.mergeRosterFields(
      organizationId,
      personA.id,
      { email: 'shared@example.edu' },
      testDb.db
    )
    people.mergeRosterFields(
      organizationId,
      personB.id,
      { email: 'shared@example.edu' },
      testDb.db
    )

    expect(personA.id).not.toBe(personB.id)
    const rereadA = people.getPerson(organizationId, personA.id, testDb.db)
    const rereadB = people.getPerson(organizationId, personB.id, testDb.db)
    expect(rereadA?.mergedIntoPersonId).toBeNull()
    expect(rereadB?.mergedIntoPersonId).toBeNull()
    expect(rereadA?.connectedAt).toBeNull()
    expect(rereadB?.connectedAt).toBeNull()
    expect(people.listPeople(organizationId, testDb.db)).toHaveLength(2)
  })
})

describe('people.ts#hasVerifiedAddress (PPL-5, D-35 rework finding 4)', () => {
  it('is false for a person nobody has connected yet', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)
    const person = people.createPerson(organizationId, {}, testDb.db)

    expect(
      people.hasVerifiedAddress(organizationId, person.id, testDb.db)
    ).toBe(false)
  })

  // The finding's own reproduction case: `connectedAt` alone (LINK-1's
  // gate) is not an address. A person connected *only* through a Discord
  // snowflake — no `web` identity, `email` still `null` — must not read as
  // verified, or the first transcript-export caller built against this
  // function would disclose a transcript to someone who proved nothing
  // more than a snowflake.
  it('is false for a person connected only through Discord — connectedAt alone is not an address', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)
    const survivor = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'discord', externalId: 'snowflake-1' },
      testDb.db
    )
    const other = people.createPerson(organizationId, {}, testDb.db)
    const merged = people.mergePeople(
      organizationId,
      survivor.id,
      other.id,
      testDb.db
    )
    expect(merged?.survivor.connectedAt).not.toBeNull()
    expect(merged?.survivor.email).toBeNull()

    expect(
      people.hasVerifiedAddress(organizationId, survivor.id, testDb.db)
    ).toBe(false)
  })

  // Likewise for MCP: a token proves possession of a private channel, not
  // an email.
  it('is false for a person connected only through MCP', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)
    const survivor = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'mcp', externalId: 'mcp-client-1' },
      testDb.db
    )

    expect(
      people.hasVerifiedAddress(organizationId, survivor.id, testDb.db)
    ).toBe(false)
  })

  it('is true once the person has a web identity — the only proxy this platform has for a verified email', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgWithCourse(testDb.db)
    const survivor = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'web', externalId: 'account-1' },
      testDb.db
    )

    expect(
      people.hasVerifiedAddress(organizationId, survivor.id, testDb.db)
    ).toBe(true)
  })

  it('refuses a personId belonging to another organization (TEN-2)', () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrgWithCourse(testDb.db)
    const { organizationId: orgB } = seedOrgWithCourse(testDb.db)
    const personInB = people.createPerson(orgB, {}, testDb.db)

    expect(
      people.hasVerifiedAddress(orgA, personInB.id, testDb.db)
    ).toBeUndefined()
  })
})
