/**
 * ROST-21 / WEB-82 — `repos/course-invitations.ts`: an invitation for an email
 * address, accepted by the account that proved it.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  accounts,
  courseInvitations,
  courseJoinLinks,
  courses,
  deletions,
  enrolments,
  organizations,
  people,
  projects,
} from '@bloombot/db'

import { courseInvitations as schemaInvitations } from '../src/schema.js'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** An organization with one project and one course without Discord. */
function seed(db: TestDatabase) {
  const orgId = randomUUID()
  organizations.createOrganization(
    orgId,
    { name: 'Org', isPersonal: false },
    db.db
  )
  const owner = accounts.createAccount(
    orgId,
    {
      email: `owner-${orgId}@example.edu`,
      displayName: 'Owner',
      role: 'owner',
    },
    db.db
  )
  const project = projects.createProject(orgId, { name: 'Fall' }, db.db)
  const saved = courses.createCourse(
    orgId,
    {
      projectId: project.id,
      title: 'Web',
      enabled: true,
      adminsRole: null,
      studentsRole: null,
      categories: [],
      discordEnabled: false,
    },
    db.db
  )
  if (!saved || !saved.ok) throw new Error('course not created')
  return { orgId, owner, project, course: saved.course }
}

/** A student account (in a personal org of its own, as sign-in makes one). */
function student(db: TestDatabase, email: string) {
  const personalOrg = randomUUID()
  organizations.createOrganization(
    personalOrg,
    { name: email, isPersonal: true },
    db.db
  )
  return accounts.createAccount(
    personalOrg,
    { email, displayName: email, role: 'owner' },
    db.db
  )
}

function invite(
  db: TestDatabase,
  orgId: string,
  courseId: string,
  email: string,
  names: { firstName?: string; lastName?: string } = {}
) {
  const result = courseInvitations.upsertInvitation(
    orgId,
    { courseId, email, ...names },
    db.db
  )
  if (!result) throw new Error('invitation refused')
  return result
}

function webPerson(db: TestDatabase, orgId: string, accountId: string) {
  return people.resolveIdentity(
    orgId,
    { surface: 'web', externalId: accountId },
    db.db
  )
}

describe('course-invitations repo — upsert, list, revoke', () => {
  it('creates an invitation with a lower-cased, trimmed email', () => {
    testDb = createTestDatabase()
    const { orgId, course } = seed(testDb)

    const { invitation, created } = invite(
      testDb,
      orgId,
      course.id,
      '  Ada@Example.EDU ',
      { firstName: 'Ada', lastName: 'Lovelace' }
    )

    expect(created).toBe(true)
    expect(invitation.email).toBe('ada@example.edu')
    expect(invitation.firstName).toBe('Ada')
  })

  it('updates the open invitation for the same course and email instead of duplicating', () => {
    testDb = createTestDatabase()
    const { orgId, course } = seed(testDb)
    const first = invite(testDb, orgId, course.id, 'ada@example.edu', {
      firstName: 'Ad',
    })

    const second = invite(testDb, orgId, course.id, 'ADA@example.edu', {
      firstName: 'Ada',
    })

    expect(second.created).toBe(false)
    expect(second.invitation.id).toBe(first.invitation.id)
    expect(second.invitation.firstName).toBe('Ada')
    expect(
      courseInvitations.listOpenInvitationsForCourse(
        orgId,
        course.id,
        testDb.db
      )
    ).toHaveLength(1)
  })

  it('refuses a course of another organization', () => {
    testDb = createTestDatabase()
    const { course } = seed(testDb)
    const other = seed(testDb)

    expect(
      courseInvitations.upsertInvitation(
        other.orgId,
        { courseId: course.id, email: 'a@example.edu' },
        testDb.db
      )
    ).toBeUndefined()
  })

  it('removes only an open invitation, and not one of another organization', () => {
    testDb = createTestDatabase()
    const { orgId, owner, course } = seed(testDb)
    const other = seed(testDb)
    const { invitation } = invite(testDb, orgId, course.id, 'ada@example.edu')

    expect(
      courseInvitations.revokeInvitation(
        other.orgId,
        invitation.id,
        owner.id,
        testDb.db
      )
    ).toBeUndefined()
    const revoked = courseInvitations.revokeInvitation(
      orgId,
      invitation.id,
      owner.id,
      testDb.db
    )
    expect(revoked?.revokedByAccountId).toBe(owner.id)
    expect(
      courseInvitations.listOpenInvitationsForCourse(
        orgId,
        course.id,
        testDb.db
      )
    ).toEqual([])
    // Already removed: not found a second time.
    expect(
      courseInvitations.revokeInvitation(
        orgId,
        invitation.id,
        owner.id,
        testDb.db
      )
    ).toBeUndefined()
  })

  it('does not remove an accepted invitation', () => {
    testDb = createTestDatabase()
    const { orgId, owner, course } = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    const { invitation } = invite(testDb, orgId, course.id, 'ada@example.edu')
    courseInvitations.claimInvitationsForAccount(ada.id, testDb.db)

    expect(
      courseInvitations.revokeInvitation(
        orgId,
        invitation.id,
        owner.id,
        testDb.db
      )
    ).toBeUndefined()
  })

  it('opens a fresh invitation after the earlier one was removed', () => {
    testDb = createTestDatabase()
    const { orgId, owner, course } = seed(testDb)
    const first = invite(testDb, orgId, course.id, 'ada@example.edu')
    courseInvitations.revokeInvitation(
      orgId,
      first.invitation.id,
      owner.id,
      testDb.db
    )

    const again = invite(testDb, orgId, course.id, 'ada@example.edu')

    expect(again.created).toBe(true)
    expect(again.invitation.id).not.toBe(first.invitation.id)
  })
})

describe('course-invitations repo — claimInvitationsForAccount (ROST-21)', () => {
  it('enrols a new person for the account, connecting its web identity, with source roster', () => {
    testDb = createTestDatabase()
    const { orgId, course } = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    const { invitation } = invite(testDb, orgId, course.id, 'Ada@example.edu')

    const claimed = courseInvitations.claimInvitationsForAccount(
      ada.id,
      testDb.db
    )

    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.outcome).toBe('enrolled')
    const person = webPerson(testDb, orgId, ada.id)
    expect(person?.connectedAt).not.toBeNull()
    const enrolment = enrolments.getActiveEnrolment(
      orgId,
      course.id,
      person?.id ?? '',
      testDb.db
    )
    expect(enrolment?.source).toBe('roster')
    const stored = courseInvitations.listOpenInvitationsForCourse(
      orgId,
      course.id,
      testDb.db
    )
    expect(stored).toEqual([])
    expect(claimed[0]?.invitationId).toBe(invitation.id)
  })

  it('reuses the web person the account already has in the organization', () => {
    testDb = createTestDatabase()
    const { orgId, owner, project, course } = seed(testDb)
    const other = courses.createCourse(
      orgId,
      {
        projectId: project.id,
        title: 'Other',
        enabled: true,
        adminsRole: null,
        studentsRole: null,
        categories: [],
        discordEnabled: false,
      },
      testDb.db
    )
    if (!other || !other.ok) throw new Error('course not created')
    const ada = student(testDb, 'ada@example.edu')
    courseJoinLinks.createJoinLink(
      orgId,
      {
        courseId: other.course.id,
        secretHash: 'h',
        createdByAccountId: owner.id,
      },
      testDb.db
    )
    courseJoinLinks.redeemJoinLinkForWebAccount(
      'h',
      ada.id,
      Date.now(),
      testDb.db
    )
    const before = webPerson(testDb, orgId, ada.id)
    invite(testDb, orgId, course.id, 'ada@example.edu')

    courseInvitations.claimInvitationsForAccount(ada.id, testDb.db)

    expect(webPerson(testDb, orgId, ada.id)?.id).toBe(before?.id)
    expect(
      enrolments.getActiveEnrolment(
        orgId,
        course.id,
        before?.id ?? '',
        testDb.db
      )
    ).toBeDefined()
  })

  it('reports already_enrolled for a person already actively enrolled, and changes nothing', () => {
    testDb = createTestDatabase()
    const { orgId, owner, course } = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    courseJoinLinks.createJoinLink(
      orgId,
      { courseId: course.id, secretHash: 'h', createdByAccountId: owner.id },
      testDb.db
    )
    courseJoinLinks.redeemJoinLinkForWebAccount(
      'h',
      ada.id,
      Date.now(),
      testDb.db
    )
    invite(testDb, orgId, course.id, 'ada@example.edu')

    const claimed = courseInvitations.claimInvitationsForAccount(
      ada.id,
      testDb.db
    )

    expect(claimed[0]?.outcome).toBe('already_enrolled')
    const person = webPerson(testDb, orgId, ada.id)
    // Still the join-link enrolment, not a second one.
    expect(
      enrolments.getActiveEnrolment(
        orgId,
        course.id,
        person?.id ?? '',
        testDb.db
      )?.source
    ).toBe('join_link')
  })

  it("refuses to revive the person's own ended enrolment", () => {
    testDb = createTestDatabase()
    const { orgId, owner, course } = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    courseJoinLinks.createJoinLink(
      orgId,
      { courseId: course.id, secretHash: 'h', createdByAccountId: owner.id },
      testDb.db
    )
    const joined = courseJoinLinks.redeemJoinLinkForWebAccount(
      'h',
      ada.id,
      Date.now(),
      testDb.db
    )
    enrolments.endEnrolment(orgId, joined?.enrolment.id ?? '', testDb.db)
    invite(testDb, orgId, course.id, 'ada@example.edu')

    const claimed = courseInvitations.claimInvitationsForAccount(
      ada.id,
      testDb.db
    )

    expect(claimed[0]?.outcome).toBe('refused_ended')
    const person = webPerson(testDb, orgId, ada.id)
    expect(
      enrolments.getActiveEnrolment(
        orgId,
        course.id,
        person?.id ?? '',
        testDb.db
      )
    ).toBeUndefined()
  })

  it('refuses when the address names a person already removed from the course and the account has no person yet', () => {
    testDb = createTestDatabase()
    const { orgId, course } = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    // A Discord-side person, found by the verified address, ended earlier.
    const removed = people.createPerson(
      orgId,
      { email: 'ada@example.edu' },
      testDb.db
    )
    const enrolment = enrolments.enrolViaRoster(
      orgId,
      { courseId: course.id, personId: removed.id },
      testDb.db
    )
    enrolments.endEnrolment(orgId, enrolment?.id ?? '', testDb.db)
    invite(testDb, orgId, course.id, 'ada@example.edu')

    const claimed = courseInvitations.claimInvitationsForAccount(
      ada.id,
      testDb.db
    )

    expect(claimed[0]?.outcome).toBe('refused_ended')
    // No second person was minted for the account.
    expect(webPerson(testDb, orgId, ada.id)).toBeUndefined()
  })

  it('skips an invitation to a soft-deleted course', () => {
    testDb = createTestDatabase()
    const { orgId, owner, course } = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    invite(testDb, orgId, course.id, 'ada@example.edu')
    courses.softDeleteCourse(orgId, course.id, owner.id, testDb.db)

    expect(
      courseInvitations.claimInvitationsForAccount(ada.id, testDb.db)
    ).toEqual([])
  })

  it('skips an invitation to a course in a soft-deleted project', () => {
    testDb = createTestDatabase()
    const { orgId, owner, project, course } = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    invite(testDb, orgId, course.id, 'ada@example.edu')
    projects.softDeleteProject(orgId, project.id, owner.id, testDb.db)

    expect(
      courseInvitations.claimInvitationsForAccount(ada.id, testDb.db)
    ).toEqual([])
  })

  it('does not claim a removed or already accepted invitation again', () => {
    testDb = createTestDatabase()
    const { orgId, owner, course } = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    const bob = student(testDb, 'bob@example.edu')
    const removed = invite(testDb, orgId, course.id, 'bob@example.edu')
    courseInvitations.revokeInvitation(
      orgId,
      removed.invitation.id,
      owner.id,
      testDb.db
    )
    invite(testDb, orgId, course.id, 'ada@example.edu')

    expect(
      courseInvitations.claimInvitationsForAccount(bob.id, testDb.db)
    ).toEqual([])
    expect(
      courseInvitations.claimInvitationsForAccount(ada.id, testDb.db)
    ).toHaveLength(1)
    expect(
      courseInvitations.claimInvitationsForAccount(ada.id, testDb.db)
    ).toEqual([])
  })

  it('ignores invitations for another address', () => {
    testDb = createTestDatabase()
    const { orgId, course } = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    invite(testDb, orgId, course.id, 'someone-else@example.edu')

    expect(
      courseInvitations.claimInvitationsForAccount(ada.id, testDb.db)
    ).toEqual([])
  })

  it('claims invitations in each organization within that organization', () => {
    testDb = createTestDatabase()
    const a = seed(testDb)
    const b = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    invite(testDb, a.orgId, a.course.id, 'ada@example.edu')
    invite(testDb, b.orgId, b.course.id, 'ada@example.edu')

    const claimed = courseInvitations.claimInvitationsForAccount(
      ada.id,
      testDb.db
    )

    expect(claimed.map((c) => c.outcome)).toEqual(['enrolled', 'enrolled'])
    const personA = webPerson(testDb, a.orgId, ada.id)
    const personB = webPerson(testDb, b.orgId, ada.id)
    expect(personA?.organizationId).toBe(a.orgId)
    expect(personB?.organizationId).toBe(b.orgId)
    expect(personA?.id).not.toBe(personB?.id)
    expect(
      enrolments.getActiveEnrolment(
        a.orgId,
        a.course.id,
        personA?.id ?? '',
        testDb.db
      )
    ).toBeDefined()
    expect(
      enrolments.getActiveEnrolment(
        b.orgId,
        b.course.id,
        personB?.id ?? '',
        testDb.db
      )
    ).toBeDefined()
  })

  it("writes the roster's names onto the person over an earlier name, and fills the email (ROST-18)", () => {
    testDb = createTestDatabase()
    const { orgId, course } = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    accounts.setAccountNames(
      ada.id,
      { firstName: 'A.', lastName: 'L.' },
      testDb.db
    )
    invite(testDb, orgId, course.id, 'ada@example.edu', {
      firstName: 'Ada',
      lastName: 'Lovelace',
    })

    courseInvitations.claimInvitationsForAccount(ada.id, testDb.db)

    const person = webPerson(testDb, orgId, ada.id)
    expect(person?.firstName).toBe('Ada')
    expect(person?.lastName).toBe('Lovelace')
    expect(person?.email).toBe('ada@example.edu')
  })

  it('leaves a blank roster name alone', () => {
    testDb = createTestDatabase()
    const { orgId, course } = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    accounts.setAccountNames(ada.id, { firstName: 'Ada' }, testDb.db)
    invite(testDb, orgId, course.id, 'ada@example.edu', {
      lastName: 'Lovelace',
    })

    courseInvitations.claimInvitationsForAccount(ada.id, testDb.db)

    const person = webPerson(testDb, orgId, ada.id)
    expect(person?.firstName).toBe('Ada')
    expect(person?.lastName).toBe('Lovelace')
  })

  it('claims nothing for an account that does not exist or is deleted', () => {
    testDb = createTestDatabase()
    const { orgId, owner, course } = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    invite(testDb, orgId, course.id, 'ada@example.edu')

    expect(
      courseInvitations.claimInvitationsForAccount(randomUUID(), testDb.db)
    ).toEqual([])
    accounts.softDeleteAccount(ada.id, owner.id, testDb.db)
    expect(
      courseInvitations.claimInvitationsForAccount(ada.id, testDb.db)
    ).toEqual([])
  })
})

describe('course-invitations repo — nothing blocks a deletion (TEN-10, DATA-8, PROJ-8)', () => {
  it('a course hard-delete removes its open and accepted invitations', () => {
    testDb = createTestDatabase()
    const { orgId, owner, course } = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    invite(testDb, orgId, course.id, 'ada@example.edu')
    invite(testDb, orgId, course.id, 'bob@example.edu')
    courseInvitations.claimInvitationsForAccount(ada.id, testDb.db)

    const result = deletions.deleteCourse(
      orgId,
      course.id,
      { deletedByAccountId: owner.id },
      testDb.db
    )

    expect(result).toBeDefined()
    expect(testDb.db.select().from(schemaInvitations).all()).toEqual([])
  })

  it('an organization delete removes its invitations', () => {
    testDb = createTestDatabase()
    const { orgId, course } = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    invite(testDb, orgId, course.id, 'ada@example.edu')
    courseInvitations.claimInvitationsForAccount(ada.id, testDb.db)
    invite(testDb, orgId, course.id, 'bob@example.edu')

    expect(organizations.deleteOrganizationData(orgId, testDb.db)).toBeDefined()
    expect(testDb.db.select().from(schemaInvitations).all()).toEqual([])
  })

  it('permanently deleting the accepting person or the removing account keeps the invitation', () => {
    testDb = createTestDatabase()
    const { orgId, owner, course } = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    invite(testDb, orgId, course.id, 'ada@example.edu')
    const [claimed] = courseInvitations.claimInvitationsForAccount(
      ada.id,
      testDb.db
    )
    const removedByOwner = invite(testDb, orgId, course.id, 'bob@example.edu')
    courseInvitations.revokeInvitation(
      orgId,
      removedByOwner.invitation.id,
      owner.id,
      testDb.db
    )

    expect(
      people.permanentlyDeletePerson(orgId, claimed?.personId ?? '', testDb.db)
    ).toBeDefined()
    expect(accounts.permanentlyDeleteAccount(owner.id, testDb.db)).toBeDefined()

    const rows = testDb.db.select().from(schemaInvitations).all()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.acceptedPersonId === null)).toBe(true)
    expect(rows.every((r) => r.revokedByAccountId === null)).toBe(true)
  })
})

describe('course-invitations repo — rework round 1', () => {
  it('a scoped claim touches only its own organization and course (TEN-2)', () => {
    testDb = createTestDatabase()
    const a = seed(testDb)
    const b = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    invite(testDb, a.orgId, a.course.id, 'ada@example.edu')
    invite(testDb, b.orgId, b.course.id, 'ada@example.edu')

    const claimed = courseInvitations.claimInvitationsForAccount(
      ada.id,
      testDb.db,
      { organizationId: a.orgId, courseId: a.course.id }
    )

    expect(claimed.map((c) => c.organizationId)).toEqual([a.orgId])
    expect(webPerson(testDb, b.orgId, ada.id)).toBeUndefined()
    expect(
      courseInvitations.listOpenInvitationsForCourse(
        b.orgId,
        b.course.id,
        testDb.db
      )
    ).toHaveLength(1)
  })

  it('does not throw when a claim fails, leaves the invitation open and reports it by ids', () => {
    testDb = createTestDatabase()
    const { orgId, owner, course } = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    // The account's web person here was soft-deleted and still holds the
    // identity, so making a new one is refused.
    const old = people.createPerson(orgId, {}, testDb.db)
    people.connectIdentity(
      orgId,
      old.id,
      { surface: 'web', externalId: ada.id },
      testDb.db
    )
    people.softDeletePerson(orgId, old.id, owner.id, testDb.db)
    invite(testDb, orgId, course.id, 'ada@example.edu')
    const errors: unknown[][] = []

    const claimed = courseInvitations.claimInvitationsForAccount(
      ada.id,
      testDb.db,
      { onError: (error, ids) => errors.push([error, ids]) }
    )

    expect(claimed).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]?.[1]).toMatchObject({ organizationId: orgId })
    expect(
      courseInvitations.listOpenInvitationsForCourse(
        orgId,
        course.id,
        testDb.db
      )
    ).toHaveLength(1)
  })

  it('a claim scoped to an organization alone claims all its courses and nothing elsewhere', () => {
    testDb = createTestDatabase()
    const a = seed(testDb)
    const b = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    invite(testDb, a.orgId, a.course.id, 'ada@example.edu')
    invite(testDb, b.orgId, b.course.id, 'ada@example.edu')

    const claimed = courseInvitations.claimInvitationsForAccount(
      ada.id,
      testDb.db,
      { organizationId: a.orgId }
    )

    expect(claimed.map((c) => c.organizationId)).toEqual([a.orgId])
  })

  it('rolls an invitation back when it stops being open while it is being accepted', () => {
    testDb = createTestDatabase()
    const { orgId, course } = seed(testDb)
    const ada = student(testDb, 'ada@example.edu')
    invite(testDb, orgId, course.id, 'ada@example.edu')
    // A concurrent removal, simulated: it lands the moment the claim makes
    // the account's person, before the claim marks the invitation accepted.
    testDb.db.$client.exec(`
      CREATE TRIGGER remove_during_claim AFTER INSERT ON people
      BEGIN
        UPDATE course_invitations SET accepted_at = 1;
      END`)

    const claimed = courseInvitations.claimInvitationsForAccount(
      ada.id,
      testDb.db
    )

    // Nothing is left half done: no person, no enrolment.
    expect(claimed).toEqual([])
    expect(webPerson(testDb, orgId, ada.id)).toBeUndefined()
  })

  describe('a placeholder from the earlier discord-off roster path', () => {
    function placeholder(orgId: string, courseId: string, email: string) {
      const person = people.resolvePersonByIdentity(
        orgId,
        { surface: 'discord', externalId: 'handle:ada' },
        testDb.db
      )
      people.mergeRosterFields(orgId, person.id, { email }, testDb.db)
      enrolments.enrolViaRoster(
        orgId,
        { courseId, personId: person.id },
        testDb.db
      )
      return person
    }

    it('has its enrolment ended when the real person is enrolled', () => {
      testDb = createTestDatabase()
      const { orgId, course } = seed(testDb)
      const ada = student(testDb, 'ada@example.edu')
      const stub = placeholder(orgId, course.id, 'ada@example.edu')
      invite(testDb, orgId, course.id, 'ada@example.edu')

      const claimed = courseInvitations.claimInvitationsForAccount(
        ada.id,
        testDb.db
      )

      expect(claimed[0]?.outcome).toBe('enrolled')
      expect(
        enrolments.getActiveEnrolment(orgId, course.id, stub.id, testDb.db)
      ).toBeUndefined()
      const real = webPerson(testDb, orgId, ada.id)
      expect(
        enrolments.getActiveEnrolment(
          orgId,
          course.id,
          real?.id ?? '',
          testDb.db
        )
      ).toBeDefined()
      // Ending the stand-in does not read as "removed" to a re-import.
      expect(
        courseInvitations.wasRemovedFromCourse(
          orgId,
          course.id,
          'ada@example.edu',
          testDb.db
        )
      ).toBe(false)
    })

    it('never touches a person marked connected, even with only handle identities', () => {
      testDb = createTestDatabase()
      const { orgId, course } = seed(testDb)
      const ada = student(testDb, 'ada@example.edu')
      const stub = placeholder(orgId, course.id, 'ada@example.edu')
      testDb.db.$client
        .prepare('UPDATE people SET connected_at = 1 WHERE id = ?')
        .run(stub.id)
      invite(testDb, orgId, course.id, 'ada@example.edu')

      courseInvitations.claimInvitationsForAccount(ada.id, testDb.db)

      expect(
        enrolments.getActiveEnrolment(orgId, course.id, stub.id, testDb.db)
      ).toBeDefined()
    })

    it('never touches a person who has a connected identity', () => {
      testDb = createTestDatabase()
      const { orgId, course } = seed(testDb)
      const ada = student(testDb, 'ada@example.edu')
      const discordAda = placeholder(orgId, course.id, 'ada@example.edu')
      people.connectIdentity(
        orgId,
        discordAda.id,
        { surface: 'discord', externalId: '1234567890' },
        testDb.db
      )
      invite(testDb, orgId, course.id, 'ada@example.edu')

      courseInvitations.claimInvitationsForAccount(ada.id, testDb.db)

      expect(
        enrolments.getActiveEnrolment(
          orgId,
          course.id,
          discordAda.id,
          testDb.db
        )
      ).toBeDefined()
    })
  })

  describe('upsertInvitations', () => {
    it('reports an address removed from the course and makes no invitation for it', () => {
      testDb = createTestDatabase()
      const { orgId, course } = seed(testDb)
      const gone = people.createPerson(
        orgId,
        { email: 'gone@example.edu' },
        testDb.db
      )
      const enrolment = enrolments.enrolViaRoster(
        orgId,
        { courseId: course.id, personId: gone.id },
        testDb.db
      )
      enrolments.endEnrolment(orgId, enrolment?.id ?? '', testDb.db)

      const results = courseInvitations.upsertInvitations(
        orgId,
        course.id,
        [{ email: 'Gone@example.edu' }, { email: 'new@example.edu' }],
        testDb.db
      )

      expect(results?.map((r) => r.status)).toEqual([
        'previously_removed',
        'created',
      ])
      expect(
        courseInvitations
          .listOpenInvitationsForCourse(orgId, course.id, testDb.db)
          .map((i) => i.email)
      ).toEqual(['new@example.edu'])
    })

    it('is not fooled when the same address is also actively enrolled', () => {
      testDb = createTestDatabase()
      const { orgId, course } = seed(testDb)
      const email = 'ada@example.edu'
      const old = people.createPerson(orgId, { email }, testDb.db)
      const oldEnrolment = enrolments.enrolViaRoster(
        orgId,
        { courseId: course.id, personId: old.id },
        testDb.db
      )
      enrolments.endEnrolment(orgId, oldEnrolment?.id ?? '', testDb.db)
      const current = people.createPerson(orgId, { email }, testDb.db)
      enrolments.enrolViaRoster(
        orgId,
        { courseId: course.id, personId: current.id },
        testDb.db
      )

      const results = courseInvitations.upsertInvitations(
        orgId,
        course.id,
        [{ email }],
        testDb.db
      )

      expect(results?.[0]?.status).toBe('created')
    })

    it('refuses a course of another organization', () => {
      testDb = createTestDatabase()
      const { course } = seed(testDb)
      const other = seed(testDb)

      expect(
        courseInvitations.upsertInvitations(
          other.orgId,
          course.id,
          [{ email: 'a@example.edu' }],
          testDb.db
        )
      ).toBeUndefined()
    })
  })
})
