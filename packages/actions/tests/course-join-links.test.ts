/**
 * ENRL-3, ENRL-4: `courseJoinLinks.create`/`.revoke` (dispatched actions)
 * and `redeemCourseJoinLink` (a plain function — see that file's own module
 * comment for why it is not dispatched). ENRL-12's own `courseJoinLinks.reveal`
 * is below, in its own `describe` block.
 */

import {
  accounts,
  courseJoinLinks as courseJoinLinksRepo,
  enrolments,
  people,
} from '@bloombot/db'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createCourseJoinLinkAction,
  createRevealCourseJoinLinkAction,
  listCourseJoinLinksAction,
  redeemCourseJoinLink,
  redeemCourseJoinLinkForWebAccount,
  revokeCourseJoinLinkAction,
} from '../src/actions/course-join-links.js'
import { dispatch } from '../src/dispatch.js'
import { ActionRefusedError } from '../src/errors.js'
import { seedOrganizationWithCourse } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('courseJoinLinks.create/.revoke, redeemCourseJoinLink (ENRL-3, ENRL-4)', () => {
  it('creating returns the secret once, and the stored row never carries it', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )

    const created = await dispatch(
      createCourseJoinLinkAction(),
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(created.secret).toBeTruthy()
    expect(JSON.stringify(created)).toContain(created.secret)
    // The row this action wrote never contains the plaintext — its own
    // SHA-256 hash instead. Cheap-fix 8: asserting only `not.toBe(created.secret)`
    // (the previous version of this test) passes for *any* transformation of
    // the secret, including `secret + '!'` — comparing against the real hash
    // is what actually pins down what `hashSecret` (module-private in
    // `../src/actions/course-join-links.js`) computes.
    const stored = testDb.db.$client
      .prepare(
        'select secret_hash as secretHash from course_join_links where id = ?'
      )
      .get(created.linkId) as { secretHash: string } | undefined
    expect(stored?.secretHash).toBe(
      createHash('sha256').update(created.secret).digest('hex')
    )
  })

  it('redeeming the secret this action returned enrols the redeemer', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const person = people.createPerson(organizationId, {}, testDb.db)

    const created = await dispatch(
      createCourseJoinLinkAction(),
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    const enrolment = redeemCourseJoinLink(created.secret, person.id, testDb.db)

    expect(enrolment?.source).toBe('join_link')
  })

  // Cheap-fix 9: a join link is deliberately multi-use — "one link, a whole
  // class" (this file's own module comment on ENRL-3) — so two different
  // people redeeming the same still-live link must each be admitted
  // independently, not just the first.
  it('a live link admits more than one person, each independently', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const first = people.createPerson(organizationId, {}, testDb.db)
    const second = people.createPerson(organizationId, {}, testDb.db)

    const created = await dispatch(
      createCourseJoinLinkAction(),
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    const firstEnrolment = redeemCourseJoinLink(
      created.secret,
      first.id,
      testDb.db
    )
    const secondEnrolment = redeemCourseJoinLink(
      created.secret,
      second.id,
      testDb.db
    )

    expect(firstEnrolment?.personId).toBe(first.id)
    expect(secondEnrolment?.personId).toBe(second.id)
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        first.id,
        testDb.db
      )
    ).toBeDefined()
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        second.id,
        testDb.db
      )
    ).toBeDefined()
  })

  // Rework finding 7: a link created already expired reports success but
  // can never be redeemed — refused up front instead. Fails without the
  // fix: before `createInputSchema`'s own `.refine`, this call succeeded.
  it('refuses creating a join link whose expiresAt is already in the past', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )

    await expect(
      dispatch(
        createCourseJoinLinkAction(),
        { courseId: course.id, expiresAt: Date.now() - 1000 },
        { organizationId, db: testDb.db, accountId: ownerId }
      )
    ).rejects.toThrow()
  })

  it('revoking stops the link admitting anyone new, but does not un-enrol somebody it already admitted', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const alreadyJoined = people.createPerson(organizationId, {}, testDb.db)
    const tooLate = people.createPerson(organizationId, {}, testDb.db)

    const created = await dispatch(
      createCourseJoinLinkAction(),
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    redeemCourseJoinLink(created.secret, alreadyJoined.id, testDb.db)

    await dispatch(
      revokeCourseJoinLinkAction,
      { linkId: created.linkId },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(
      redeemCourseJoinLink(created.secret, tooLate.id, testDb.db)
    ).toBeUndefined()
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        alreadyJoined.id,
        testDb.db
      )
    ).toBeDefined()
  })

  // ENRL-8: `redeemCourseJoinLinkForWebAccount` composes `hashSecret` with
  // `redeemJoinLinkForWebAccount` the same way `redeemCourseJoinLink` (above)
  // already composes it with `redeemJoinLink` — this pins down that the
  // secret this action returns actually redeems through the account-based
  // entry point too, not only the person-id one.
  it('redeeming the secret this action returned enrols a web account, creating its person', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const accountId = randomUUID()

    const created = await dispatch(
      createCourseJoinLinkAction(),
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    const result = redeemCourseJoinLinkForWebAccount(
      created.secret,
      accountId,
      testDb.db
    )

    expect(result?.enrolment.source).toBe('join_link')
    const person = people.resolveIdentity(
      organizationId,
      { surface: 'web', externalId: accountId },
      testDb.db
    )
    expect(person?.connectedAt).not.toBeNull()
  })

  // WEB-20: the list a panel's own join-links screen reads. Fails without
  // the fix: `courseJoinLinks.list` did not exist at all before this slice.
  describe('courseJoinLinks.list (WEB-20)', () => {
    it('lists a course own join links, and never carries a secretHash field', async () => {
      testDb = createTestDatabase()
      const { organizationId, ownerId, course } = seedOrganizationWithCourse(
        testDb.db
      )
      await dispatch(
        createCourseJoinLinkAction(),
        { courseId: course.id },
        { organizationId, db: testDb.db, accountId: ownerId }
      )

      const listed = await dispatch(
        listCourseJoinLinksAction,
        { courseId: course.id },
        { organizationId, db: testDb.db, accountId: ownerId }
      )

      expect(listed).toHaveLength(1)
      // Cheap-fix-8-style precision: assert against the actual serialized
      // shape, not merely `.secretHash` being `undefined` on the object —
      // a caller that spread extra fields through would still fail this.
      expect(JSON.stringify(listed)).not.toContain('secretHash')
      expect(JSON.stringify(listed)).not.toMatch(/secret_hash/)
      // ENRL-12: created with no key, so nothing was ever encrypted to show
      // again — `revealable` says so up front, without a caller having to
      // attempt `.reveal` and read a refusal to find out.
      expect(listed[0]).toMatchObject({
        courseId: course.id,
        revokedAt: null,
        revealable: false,
      })
    })

    // ENRL-12: the one field this listing adds — capability metadata, never
    // secret material (this file's own `CourseJoinLinkSummary` doc comment).
    it('revealable is true only for a link that was created with an encryption key configured', async () => {
      testDb = createTestDatabase()
      const { organizationId, ownerId, course } = seedOrganizationWithCourse(
        testDb.db
      )
      const key = randomBytes(32)

      await dispatch(
        createCourseJoinLinkAction(key),
        { courseId: course.id },
        { organizationId, db: testDb.db, accountId: ownerId }
      )
      await dispatch(
        createCourseJoinLinkAction(),
        { courseId: course.id },
        { organizationId, db: testDb.db, accountId: ownerId }
      )

      const listed = await dispatch(
        listCourseJoinLinksAction,
        { courseId: course.id },
        { organizationId, db: testDb.db, accountId: ownerId }
      )

      expect(listed).toHaveLength(2)
      const revealableFlags = listed.map((entry) => entry.revealable).sort()
      expect(revealableFlags).toEqual([false, true])
    })

    it("does not list another organization's course join links, refusing not-found-shaped", async () => {
      testDb = createTestDatabase()
      const { organizationId: orgA } = seedOrganizationWithCourse(testDb.db)
      const {
        organizationId: orgB,
        ownerId: ownerB,
        course: courseB,
      } = seedOrganizationWithCourse(testDb.db)
      await dispatch(
        createCourseJoinLinkAction(),
        { courseId: courseB.id },
        { organizationId: orgB, db: testDb.db, accountId: ownerB }
      )

      await expect(
        dispatch(
          listCourseJoinLinksAction,
          { courseId: courseB.id },
          { organizationId: orgA, db: testDb.db }
        )
      ).rejects.toThrow(ActionRefusedError)
    })
  })

  it("revoking refuses another organization's link, identically to a missing one", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithCourse(testDb.db)
    const {
      organizationId: orgB,
      ownerId: ownerB,
      course: courseB,
    } = seedOrganizationWithCourse(testDb.db)

    const created = await dispatch(
      createCourseJoinLinkAction(),
      { courseId: courseB.id },
      { organizationId: orgB, db: testDb.db, accountId: ownerB }
    )

    await expect(
      dispatch(
        revokeCourseJoinLinkAction,
        { linkId: created.linkId },
        { organizationId: orgA, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })
})

describe('courseJoinLinks.reveal (ENRL-12)', () => {
  // A live link's secret is recoverable by the instructors of its own
  // organization — proved by *redeeming* the revealed secret, not merely by
  // comparing it against the one `.create` returned: a reveal that decrypted
  // to the wrong bytes but happened to satisfy a naive string check would
  // still pass a weaker assertion.
  it("reveals a live link's secret again, and the revealed secret actually redeems", async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const key = randomBytes(32)
    const person = people.createPerson(organizationId, {}, testDb.db)

    const created = await dispatch(
      createCourseJoinLinkAction(key),
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    const revealed = await dispatch(
      createRevealCourseJoinLinkAction(key),
      { linkId: created.linkId },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(revealed.secret).toBe(created.secret)
    const enrolment = redeemCourseJoinLink(
      revealed.secret,
      person.id,
      testDb.db
    )
    expect(enrolment?.personId).toBe(person.id)
  })

  // Mutation this pins down: putting the ciphertext (or its nonce/tag) in
  // `toSummary` would leak a live bearer secret's own encrypted form into
  // every list response for a course's links, not only the one just
  // created — checked against the actual serialized body, not merely that
  // the parsed object lacks the field (`toHaveProperty` would miss a caller
  // that spread the raw row through under a different key).
  it('listing never carries secretCiphertext, secretNonce or secretAuthTag, even with a key configured', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const key = randomBytes(32)

    await dispatch(
      createCourseJoinLinkAction(key),
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    const listed = await dispatch(
      listCourseJoinLinksAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(listed).toHaveLength(1)
    const serialized = JSON.stringify(listed)
    expect(serialized).not.toContain('secretCiphertext')
    expect(serialized).not.toContain('secretNonce')
    expect(serialized).not.toContain('secretAuthTag')
    expect(serialized).not.toMatch(/secret_(ciphertext|nonce|auth_tag)/)
  })

  it('a revoked link refuses to reveal its secret — "no reason to hand back a secret that admits nobody"', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const key = randomBytes(32)

    const created = await dispatch(
      createCourseJoinLinkAction(key),
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    await dispatch(
      revokeCourseJoinLinkAction,
      { linkId: created.linkId },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    await expect(
      dispatch(
        createRevealCourseJoinLinkAction(key),
        { linkId: created.linkId },
        { organizationId, db: testDb.db, accountId: ownerId }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('an expired link refuses to reveal its secret', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const key = randomBytes(32)

    const created = await dispatch(
      createCourseJoinLinkAction(key),
      { courseId: course.id, expiresAt: Date.now() + 1000 },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    // The row this test needs (expired, but not revoked) cannot be produced
    // through the dispatched action alone — `createInputSchema`'s own
    // `.refine` (this file's own "refuses ... already in the past" test)
    // means only a value already past by the time it is read back gets
    // this row here, so the expiry is written directly, the same "seed
    // exactly the state under test, through the repo, not the action"
    // convention `docs/DECISIONS.md`'s migration tests already use.
    testDb.db.$client
      .prepare('update course_join_links set expires_at = ? where id = ?')
      .run(Date.now() - 1000, created.linkId)

    await expect(
      dispatch(
        createRevealCourseJoinLinkAction(key),
        { linkId: created.linkId },
        { organizationId, db: testDb.db, accountId: ownerId }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  // ENRL-12's own deployment-compatibility promise: no key configured is
  // not a failure to start, and never blocks creation or the one-time
  // reveal `.create` already gives — only asking to see the secret *again*
  // is refused.
  it('with no encryption key configured, creation still returns the secret once, and reveal is refused', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )

    const created = await dispatch(
      createCourseJoinLinkAction(),
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    expect(created.secret).toBeTruthy()

    await expect(
      dispatch(
        createRevealCourseJoinLinkAction(),
        { linkId: created.linkId },
        { organizationId, db: testDb.db, accountId: ownerId }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  // A row from before this shipped has no ciphertext at all — redemption is
  // unaffected (the hash is untouched), and reveal is refused exactly like
  // any other link with nothing encrypted to show, even when a key is
  // configured *now*.
  it('a link created before this shipped (no ciphertext) still redeems, and its reveal is refused', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const key = randomBytes(32)
    const person = people.createPerson(organizationId, {}, testDb.db)
    const secret = 'pre-existing-link-secret'

    const link = courseJoinLinksRepo.createJoinLink(
      organizationId,
      {
        courseId: course.id,
        secretHash: createHash('sha256').update(secret).digest('hex'),
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    await expect(
      dispatch(
        createRevealCourseJoinLinkAction(key),
        { linkId: link.id },
        { organizationId, db: testDb.db, accountId: ownerId }
      )
    ).rejects.toThrow(ActionRefusedError)
    const enrolment = redeemCourseJoinLink(secret, person.id, testDb.db)
    expect(enrolment?.personId).toBe(person.id)
  })

  // Authenticated encryption's whole point: a tampered ciphertext is
  // rejected outright, never silently decrypted into garbage a caller could
  // mistake for the real secret — and the refusal this throws carries
  // nothing that could leak the real one either.
  it('tampered ciphertext is rejected rather than decrypted to garbage', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const key = randomBytes(32)

    const created = await dispatch(
      createCourseJoinLinkAction(key),
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    const stored = testDb.db.$client
      .prepare(
        'select secret_auth_tag as secretAuthTag from course_join_links where id = ?'
      )
      .get(created.linkId) as { secretAuthTag: string }
    // Flip one bit of the tag's own decoded bytes, then re-encode — decoded,
    // not the base64 text itself, so the tampered value stays valid base64
    // of the same 16-byte length; any single-bit change is enough for GCM's
    // authentication check to fail.
    const tagBytes = Buffer.from(stored.secretAuthTag, 'base64')
    tagBytes[0] = (tagBytes[0] ?? 0) ^ 0xff
    const tampered = tagBytes.toString('base64')
    testDb.db.$client
      .prepare('update course_join_links set secret_auth_tag = ? where id = ?')
      .run(tampered, created.linkId)

    let caught: unknown
    try {
      await dispatch(
        createRevealCourseJoinLinkAction(key),
        { linkId: created.linkId },
        { organizationId, db: testDb.db, accountId: ownerId }
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ActionRefusedError)
    // The real secret never appears anywhere in what this throws — the
    // plaintext must not leak into an error body even on the path that
    // exists precisely because decryption failed.
    expect(JSON.stringify(caught)).not.toContain(created.secret)
    expect((caught as Error).message).not.toContain(created.secret)
  })

  it("revealing refuses another organization's link, identically to a missing one", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithCourse(testDb.db)
    const {
      organizationId: orgB,
      ownerId: ownerB,
      course: courseB,
    } = seedOrganizationWithCourse(testDb.db)
    const key = randomBytes(32)

    const created = await dispatch(
      createCourseJoinLinkAction(key),
      { courseId: courseB.id },
      { organizationId: orgB, db: testDb.db, accountId: ownerB }
    )

    await expect(
      dispatch(
        createRevealCourseJoinLinkAction(key),
        { linkId: created.linkId },
        { organizationId: orgA, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  // Pins the settled (not merely inferred) authorization decision this
  // action's own doc comment records: `.reveal` shares `.revoke`'s policy
  // verbatim, so an `assistant` — already able to `.create`/`.list`/`.revoke`
  // a course's join links, un-role-differentiated — can reveal one too.
  // Fails if `.reveal` is ever narrowed to `owner`/`instructor` without this
  // test being updated deliberately.
  it('an assistant — not only an owner — can reveal a live link, matching .create/.list/.revoke', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const assistant = accounts.createAccount(
      organizationId,
      {
        email: 'assistant@example.edu',
        displayName: 'Assistant',
        role: 'assistant',
      },
      testDb.db
    )
    const key = randomBytes(32)

    const created = await dispatch(
      createCourseJoinLinkAction(key),
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    const revealed = await dispatch(
      createRevealCourseJoinLinkAction(key),
      { linkId: created.linkId },
      { organizationId, db: testDb.db, accountId: assistant.id }
    )

    expect(revealed.secret).toBe(created.secret)
  })
})
