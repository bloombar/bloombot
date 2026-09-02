/**
 * `routes/person-link.ts` (LINK-6/7/8), over HTTP. No test in this file
 * reaches Discord — `discordRestClient` is always
 * `createFakeDiscordRestClient(...)`, never the real adapter, the same
 * discipline `discord-servers.test.ts` already holds itself to.
 *
 * D-44 rework — two `describe` blocks exist specifically because a review
 * round found the first version of this file's own tests proved half of
 * what mattered: "the tenant-write oracle is closed" reproduces the
 * reviewer's own exploit sequence directly (a real organization the caller
 * has no membership in, not merely a `randomUUID()` that cannot exist at
 * all), and "session binding" proves the account check the route makes,
 * not merely the argument `@bloombot/auth`'s own unit tests already cover.
 *
 * The acceptance test (last `describe` block) is this slice's own
 * "write at least one test that starts where a real person starts": a
 * student admitted by a roster import, who has never signed in, sends a
 * Discord message (simulated the same way `chat.test.ts`'s own
 * `seedEnrolledCourse` does — a `discord`-surface person, admitted through
 * `enrolViaRoster`, never through anything this router itself creates),
 * gets the LINK-1 invitation, follows it, signs in as a brand-new account
 * with *no membership in that organization*, connects through this
 * router's own real HTTP endpoints (not a direct `people.connectIdentity`
 * shortcut), then asks a question over the web chat and gets an answer.
 *
 * LINK-10 (D-50) extends that same acceptance test rather than adding a
 * second, separately-seeded one — this student's own connect, real end to
 * end through this router, is exactly the scenario `GET /auth/me`'s own
 * `connectedOrganizations` and the panel's own withheld tabs exist for: the
 * test asserts the institution's organization now shows up there (never as
 * a second membership), and that a membership-only action against it —
 * every tab `apps/web/src/pages/Shell.tsx` withholds from this account
 * dispatches one — still refuses, over real HTTP, after connecting. The
 * server's own refusal is what makes the panel's withholding safe rather
 * than decorative; this is the test that proves it holds for the identical
 * caller the rest of this file already drives through the real connect
 * flow, not a caller shaped the way this test's own setup would resolve it.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { issueMcpPersonLinkToken } from '@bloombot/auth'
import {
  courses,
  enrolments,
  people,
  projects,
  schema,
  type Database,
} from '@bloombot/db'

import { buildTestApp, TEST_PUBLIC_APP_URL } from '../helpers/build-test-app.js'
import { createFakeDiscordRestClient } from '../helpers/fake-discord-rest-client.js'
import { FakeModelClient } from '../helpers/fake-model-client.js'
import {
  seedOtherOrganization,
  seedSignedInCaller,
  type SignedInCaller,
} from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Begins a Discord connect attempt over HTTP and pulls `state` back out of the returned authorization URL, the same device `discord-servers.test.ts#beginInstall` already uses for the install flow. */
async function beginConnect(
  app: import('node:http').Server,
  organizationId: string,
  caller: SignedInCaller
): Promise<{ state: string; authorizationUrl: string }> {
  const response = await request(app)
    .post(`/organizations/${organizationId}/person-link/discord/begin`)
    .set('Cookie', caller.cookieHeader)
    .set('Origin', TEST_PUBLIC_APP_URL)
    .send({})
  expect(response.status).toBe(200)
  const body = response.body as { authorizationUrl: string }
  const state = new URL(body.authorizationUrl).searchParams.get('state')
  if (!state) throw new Error('test setup: authorizationUrl carried no state')
  return { state, authorizationUrl: body.authorizationUrl }
}

/** `GET .../chat/courses` for `organizationId` as `caller` — the same "does this route see a connected person" probe the reviewer's own reproduction used to prove the write-oracle. `200 {courses:[]}` once a connected `web` identity exists there, `404` while none does — regardless of whether the organization itself exists (`routes/chat.ts`'s own TEN-5 discipline). */
async function chatCoursesStatus(
  app: import('node:http').Server,
  organizationId: string,
  caller: SignedInCaller
): Promise<number> {
  const response = await request(app)
    .get(`/organizations/${organizationId}/chat/courses`)
    .set('Cookie', caller.cookieHeader)
  return response.status
}

/**
 * A course this organization's bound Discord server could route to, with an
 * active enrolment admitting a `discord`-surface person into it via
 * `enrolViaRoster` — the same admission path a real roster import uses
 * (`apps/worker`'s own `roster-import.ts`), the only kind of person any
 * real enrolment in this system ever belongs to (`chat.test.ts`'s own
 * identical helper and module comment).
 */
function seedEnrolledCourse(
  db: Database,
  organizationId: string,
  discordExternalId: string
): { courseId: string; discordPersonId: string } {
  const project = projects.createProject(
    organizationId,
    { name: `Term ${randomUUID()}` },
    db
  )
  const unique = randomUUID()
  const created = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Intro to Testing',
      filePrefix: 'testing',
      enabled: true,
      adminsRole: `Staff-${unique}`,
      studentsRole: `Students-${unique}`,
      promptId: 'prompt-1',
      categories: [],
    },
    db
  )
  if (!created.ok) throw new Error('test setup: course creation refused')
  const courseId = created.course.id

  const discordPerson = people.resolvePersonByIdentity(
    organizationId,
    { surface: 'discord', externalId: discordExternalId },
    db
  )
  enrolments.enrolViaRoster(
    organizationId,
    { courseId, personId: discordPerson.id },
    db
  )

  return { courseId, discordPersonId: discordPerson.id }
}

/**
 * Seeds `caller`'s own `web`-identity person in `organizationId`, already
 * connected — standing in for "already legitimately reached this
 * organization" (a prior Discord connect, or a personal-org sign-in),
 * exactly the precondition D-44's rework, round two, requires before an
 * MCP connect (`people.resolveIdentity`, read-only) has anything to find.
 * Written directly through `people.ts`, the same "simulate the
 * precondition, not the mechanism under test" convention
 * `chat.test.ts#connectCallerTo` already uses.
 */
function seedConnectedWebPerson(
  db: Database,
  organizationId: string,
  accountId: string
): people.Person {
  const person = people.createPerson(organizationId, {}, db)
  const connected = people.connectIdentity(
    organizationId,
    person.id,
    { surface: 'web', externalId: accountId },
    db
  )
  if (!connected) throw new Error('test setup: connectIdentity refused')
  return person
}

describe('POST /organizations/:organizationId/person-link/discord/begin', () => {
  it('refuses a signed-out caller', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post('/organizations/some-org/person-link/discord/begin')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({})

    expect(response.status).toBe(401)
  })

  // Rework finding — this test's own title used to claim "the same way a
  // foreign one would", which is false: `/discord/begin` returns `200` for
  // a real organization the caller has no relationship to and `404` only
  // for one that does not exist at all (a real, if accepted, existence
  // oracle — this file's own module comment on why it is not this slice's
  // to close: an organization id is not a secret, and the bare survivor a
  // real organization gets is inert everywhere else in this app).
  it('refuses a nonexistent organization — 404, not the raw foreign-key 500 an unguarded insert would give', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post(`/organizations/${randomUUID()}/person-link/discord/begin`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({})

    expect(response.status).toBe(404)
  })

  it('returns a scope=identify authorization URL', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const app = await buildTestApp(testDb.db)

    const { authorizationUrl } = await beginConnect(
      app,
      caller.organizationId,
      caller
    )

    const url = new URL(authorizationUrl)
    expect(url.searchParams.get('scope')).toBe('identify')
    expect(url.searchParams.get('client_id')).toBe('test-discord-client-id')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  // D-44 rework — the defect a reviewer reproduced directly: this used to
  // create a *connected* person (a `web` identity, `connectedAt` set) for
  // any organization the caller merely named, no proof required. Now it
  // creates a bare, unconnected one — indistinguishable, to every other
  // route in this app, from the organization not existing at all.
  it('creates a bare, unconnected person — no web identity, connectedAt still null, LINK-1s gate untouched', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const foreignOrganizationId = seedOtherOrganization(testDb.db)
    const app = await buildTestApp(testDb.db)

    await beginConnect(app, foreignOrganizationId, caller)

    expect(
      people.resolveIdentity(
        foreignOrganizationId,
        { surface: 'web', externalId: caller.accountId },
        testDb.db
      )
    ).toBeUndefined()
    // Not observable through `chat.ts` either — the whole point of a bare
    // survivor: to every *other* route, this organization still looks
    // exactly like the caller has no relationship to it at all.
    expect(await chatCoursesStatus(app, foreignOrganizationId, caller)).toBe(
      404
    )
  })

  // Rework finding 2 — this test used to assert `toBeGreaterThanOrEqual(1)`,
  // true for any value at all, while its own in-body comment admitted the
  // reuse it claimed to test never actually fired. Deleting the reuse
  // branch entirely (`resolveOrCreateBareDiscordSurvivor` unconditionally
  // calling `createPerson`) left the whole suite green. Fixed to assert
  // exactly one row, and to prove it holds for more than a "second call" —
  // the reviewer's own reproduction measured 200 begin() calls leaving 200
  // rows; this proves 5 leave 1.
  it('reuses the same survivor across repeat begin() calls for the same account and organization — bounded, not one row per call', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const foreignOrganizationId = seedOtherOrganization(testDb.db)
    const app = await buildTestApp(testDb.db)

    const rowsForOrg = () =>
      testDb.db
        .select()
        .from(schema.people)
        .all()
        .filter((row) => row.organizationId === foreignOrganizationId)

    const states = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const { state } = await beginConnect(app, foreignOrganizationId, caller)
      states.add(state)
    }

    // Five distinct attempts (a real state each time — Discord's own PKCE
    // state must never repeat) …
    expect(states.size).toBe(5)
    // … but exactly one survivor row, reused every time.
    expect(rowsForOrg()).toHaveLength(1)
  })

  // A *different* account begin()-ing into the same organization must not
  // be folded into the first caller's own row — the reuse scan is keyed on
  // `accountId`, not merely `organizationId`.
  it('does not reuse across different accounts, even for the same organization', async () => {
    testDb = createTestDatabase()
    const callerA = seedSignedInCaller(testDb.db)
    const callerB = seedSignedInCaller(testDb.db)
    const foreignOrganizationId = seedOtherOrganization(testDb.db)
    const app = await buildTestApp(testDb.db)

    await beginConnect(app, foreignOrganizationId, callerA)
    await beginConnect(app, foreignOrganizationId, callerB)

    const rows = testDb.db
      .select()
      .from(schema.people)
      .all()
      .filter((row) => row.organizationId === foreignOrganizationId)
    expect(rows).toHaveLength(2)
  })
})

describe('the tenant-write oracle is closed (D-44)', () => {
  // The reviewer's own reproduction, replayed directly: a junk MCP token
  // used to create a connected person in a real organization the caller
  // had never touched, permanently flipping `chat.courses` for it from
  // 404 to 200. Now: no token, no write, regardless of organization.
  it('a junk MCP token against a real, foreign organization creates nothing and leaves chat.courses refusing exactly as before', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const foreignOrganizationId = seedOtherOrganization(testDb.db)
    const app = await buildTestApp(testDb.db)

    expect(await chatCoursesStatus(app, foreignOrganizationId, caller)).toBe(
      404
    )

    const response = await request(app)
      .post(`/organizations/${foreignOrganizationId}/person-link/mcp/preview`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ token: 'not-a-token' })

    expect(response.status).toBe(404)
    expect(
      people.resolveIdentity(
        foreignOrganizationId,
        { surface: 'web', externalId: caller.accountId },
        testDb.db
      )
    ).toBeUndefined()
    expect(await chatCoursesStatus(app, foreignOrganizationId, caller)).toBe(
      404
    )
  })

  it('an MCP token real for a different organization is refused, not partially honored, against this one', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const ownOrganizationId = caller.organizationId
    const foreignOrganizationId = seedOtherOrganization(testDb.db)
    const app = await buildTestApp(testDb.db)
    // The caller already has a legitimate, connected person in their own
    // organization (D-44 rework, round two: an MCP survivor is resolved
    // read-only now, never created — this is the precondition that makes
    // it findable at all).
    seedConnectedWebPerson(testDb.db, ownOrganizationId, caller.accountId)
    // A token genuinely issued — for the caller's *own* organization, not
    // the foreign one this test then tries it against.
    const issued = issueMcpPersonLinkToken(
      ownOrganizationId,
      'assistant-1',
      testDb.db
    )

    const response = await request(app)
      .post(`/organizations/${foreignOrganizationId}/person-link/mcp/preview`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ token: issued.token })

    expect(response.status).toBe(404)
    expect(
      people.resolveIdentity(
        foreignOrganizationId,
        { surface: 'web', externalId: caller.accountId },
        testDb.db
      )
    ).toBeUndefined()
    // The token is still live for its own, real organization.
    const rightOrgPreview = await request(app)
      .post(`/organizations/${ownOrganizationId}/person-link/mcp/preview`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ token: issued.token })
    expect(rightOrgPreview.status).toBe(200)
  })

  // The exploit a reviewer reproduced end to end, over the real MCP and
  // HTTP surfaces: `bloombot_connectAssistant` (`apps/mcp/src/server.ts`)
  // mints a token for *any* organization, membership-free, by design — so
  // the token itself was never organization-specific proof. Replayed here
  // exactly as measured: one ordinary account, no membership, no
  // enrolment, no person anywhere near the victim organization, minting
  // its own "proof" and trying to redeem it against itself.
  it('an attacker who mints their own token for the victim organization (bloombot_connectAssistant, membership-free by design) is still refused', async () => {
    testDb = createTestDatabase()
    const attacker = seedSignedInCaller(testDb.db, {
      organizationName: "The attacker's own personal organization",
    })
    const victimOrganizationId = seedOtherOrganization(testDb.db)
    const app = await buildTestApp(testDb.db)
    expect(await chatCoursesStatus(app, victimOrganizationId, attacker)).toBe(
      404
    )

    // The exact call `bloombot_connectAssistant` makes internally — no
    // membership check there either, by design (that tool's own doc
    // comment) — for the organization id the attacker read straight out of
    // a public LINK-1 invitation (`packages/discord/src/handle-mention.ts`
    // now publishes `<PUBLIC_APP_URL>/connect/<organizationId>` into the
    // channel).
    const selfMintedToken = issueMcpPersonLinkToken(
      victimOrganizationId,
      attacker.accountId,
      testDb.db
    )

    const preview = await request(app)
      .post(`/organizations/${victimOrganizationId}/person-link/mcp/preview`)
      .set('Cookie', attacker.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ token: selfMintedToken.token })
    expect(preview.status).toBe(404)

    const confirm = await request(app)
      .post(`/organizations/${victimOrganizationId}/person-link/mcp/confirm`)
      .set('Cookie', attacker.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ token: selfMintedToken.token })
    expect(confirm.status).toBe(404)

    // The victim tenant is unchanged: no person, `connectedAt` granted to
    // nobody, and `chat.courses` reads exactly as it did before any of
    // this ran.
    expect(
      people.resolveIdentity(
        victimOrganizationId,
        { surface: 'web', externalId: attacker.accountId },
        testDb.db
      )
    ).toBeUndefined()
    expect(
      people.resolveIdentity(
        victimOrganizationId,
        { surface: 'mcp', externalId: attacker.accountId },
        testDb.db
      )
    ).toBeUndefined()
    expect(await chatCoursesStatus(app, victimOrganizationId, attacker)).toBe(
      404
    )
  })

  it('/discord/begin against a real, foreign organization does not flip chat.courses from 404 to 200', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const foreignOrganizationId = seedOtherOrganization(testDb.db)
    const app = await buildTestApp(testDb.db)

    await beginConnect(app, foreignOrganizationId, caller)

    expect(await chatCoursesStatus(app, foreignOrganizationId, caller)).toBe(
      404
    )
  })

  // The Discord half of the same exploit shape: a caller with no
  // relationship to the victim organization can always produce a
  // *genuine* OAuth proof of their own real snowflake — a snowflake this
  // organization has never seen, which previews as `attach`. D-44's own
  // rework, round two: `attach` is refused for a non-member, closing this
  // the same way as the MCP half, without touching the merge outcome a
  // real roster-admitted student relies on (proven separately by the
  // acceptance test, below).
  it('an attacker who proves their own, genuinely-owned Discord identity against the victim organization is refused — attach requires membership', async () => {
    testDb = createTestDatabase()
    const attacker = seedSignedInCaller(testDb.db, {
      organizationName: "The attacker's own personal organization",
    })
    const victimOrganizationId = seedOtherOrganization(testDb.db)
    const fakeDiscord = createFakeDiscordRestClient({
      currentUser: { id: 'attacker-real-snowflake', username: 'attacker' },
    })
    const app = await buildTestApp(testDb.db, {
      discordRestClient: fakeDiscord,
    })

    const { state } = await beginConnect(app, victimOrganizationId, attacker)
    const preview = await request(app)
      .post(
        `/organizations/${victimOrganizationId}/person-link/discord/preview`
      )
      .set('Cookie', attacker.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ code: 'the-code', state })
    // Refused as an ordinary preview failure — the same 404 every other
    // preview refusal in this file gives, not a distinct "forbidden" shape
    // that would itself be an oracle.
    expect(preview.status).toBe(404)

    const confirm = await request(app)
      .post(
        `/organizations/${victimOrganizationId}/person-link/discord/confirm`
      )
      .set('Cookie', attacker.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ state })
    expect(confirm.status).toBe(404)

    expect(
      people.resolveIdentity(
        victimOrganizationId,
        { surface: 'discord', externalId: 'attacker-real-snowflake' },
        testDb.db
      )
    ).toBeUndefined()
    expect(await chatCoursesStatus(app, victimOrganizationId, attacker)).toBe(
      404
    )
  })
})

describe('session binding — the caller confirming must be the caller who began it (D-44)', () => {
  it("caller B posting caller A's state to preview and confirm gets 404 both times, and A's own identity stays unbound (but not burned)", async () => {
    testDb = createTestDatabase()
    const callerA = seedSignedInCaller(testDb.db, {
      organizationName: 'Org for A',
    })
    const foreignOrganizationId = seedOtherOrganization(testDb.db)
    const callerB = seedSignedInCaller(testDb.db, {
      organizationName: 'Org for B',
    })
    // A already exists there — a roster-admitted, discord-surface person
    // holding this exact snowflake (D-44's own "attach forbidden without
    // membership" rule, round two: A has no membership in this
    // organization either, so the outcome has to be a real `merge`, the
    // same shape the acceptance test below exercises, for this attempt to
    // be completable at all).
    people.resolvePersonByIdentity(
      foreignOrganizationId,
      { surface: 'discord', externalId: 'as-snowflake' },
      testDb.db
    )
    const fakeDiscord = createFakeDiscordRestClient({
      currentUser: { id: 'as-snowflake', username: 'a-student' },
    })
    const app = await buildTestApp(testDb.db, {
      discordRestClient: fakeDiscord,
    })

    const { state } = await beginConnect(app, foreignOrganizationId, callerA)

    // B — signed in as a different account entirely — posts A's own
    // `?code=&state=` (as if it had leaked into B's browser history, or a
    // shared machine).
    const previewByB = await request(app)
      .post(
        `/organizations/${foreignOrganizationId}/person-link/discord/preview`
      )
      .set('Cookie', callerB.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ code: 'the-code', state })
    expect(previewByB.status).toBe(404)

    const confirmByB = await request(app)
      .post(
        `/organizations/${foreignOrganizationId}/person-link/discord/confirm`
      )
      .set('Cookie', callerB.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ state })
    expect(confirmByB.status).toBe(404)

    // B's mismatched confirm neither bound anything to B nor connected the
    // (already-existing, roster-admitted) identity — LINK-1's own gate
    // untouched — and, the point of rework finding 7, did not burn A's own
    // attempt: A can still finish it.
    expect(
      people.resolveIdentity(
        foreignOrganizationId,
        { surface: 'discord', externalId: 'as-snowflake' },
        testDb.db
      )?.connectedAt
    ).toBeNull()

    const previewByA = await request(app)
      .post(
        `/organizations/${foreignOrganizationId}/person-link/discord/preview`
      )
      .set('Cookie', callerA.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ code: 'the-code', state })
    expect(previewByA.status).toBe(200)

    const confirmByA = await request(app)
      .post(
        `/organizations/${foreignOrganizationId}/person-link/discord/confirm`
      )
      .set('Cookie', callerA.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ state })
    expect(confirmByA.status).toBe(200)
    expect(
      people.resolveIdentity(
        foreignOrganizationId,
        { surface: 'discord', externalId: 'as-snowflake' },
        testDb.db
      )?.connectedAt
    ).not.toBeNull()
  })

  it('posting the right state to the wrong organization URL is refused the same way — not a 500 for a nonexistent one (rework finding 6)', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const targetOrganizationId = seedOtherOrganization(testDb.db)
    const app = await buildTestApp(testDb.db)
    const { state } = await beginConnect(app, targetOrganizationId, caller)

    const response = await request(app)
      .post(`/organizations/${randomUUID()}/person-link/discord/confirm`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ state })

    expect(response.status).toBe(404)
  })
})

describe('POST .../discord/preview and .../discord/confirm', () => {
  it('previews an attach outcome without consuming the state — confirm still succeeds afterward, and the survivor ends up both discord- and web-connected', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const fakeDiscord = createFakeDiscordRestClient({
      currentUser: { id: 'snowflake-1', username: 'a-student' },
    })
    const app = await buildTestApp(testDb.db, {
      discordRestClient: fakeDiscord,
    })
    const { state } = await beginConnect(app, caller.organizationId, caller)

    const preview = await request(app)
      .post(
        `/organizations/${caller.organizationId}/person-link/discord/preview`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ code: 'the-code', state })

    expect(preview.status).toBe(200)
    const previewBody = preview.body as {
      discordUsername: string
      preview: { outcome: { kind: string } }
    }
    expect(previewBody.discordUsername).toBe('a-student')
    expect(previewBody.preview.outcome).toEqual({ kind: 'attach' })

    // Nothing was written yet — LINK-6's own "a visit is not consent".
    expect(
      people.resolveIdentity(
        caller.organizationId,
        { surface: 'discord', externalId: 'snowflake-1' },
        testDb.db
      )
    ).toBeUndefined()

    const confirm = await request(app)
      .post(
        `/organizations/${caller.organizationId}/person-link/discord/confirm`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ state })

    expect(confirm.status).toBe(200)
    const discordConnected = people.resolveIdentity(
      caller.organizationId,
      { surface: 'discord', externalId: 'snowflake-1' },
      testDb.db
    )
    expect(discordConnected).toBeDefined()
    expect(discordConnected?.connectedAt).not.toBeNull()
    // The `web` identity is attached too — only now, after real Discord
    // proof — so a later web-chat visit resolves the same person.
    expect(
      people.resolveIdentity(
        caller.organizationId,
        { surface: 'web', externalId: caller.accountId },
        testDb.db
      )?.id
    ).toBe(discordConnected?.id)
  })

  it('confirm refuses a state that was never previewed', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post(
        `/organizations/${caller.organizationId}/person-link/discord/confirm`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ state: 'made-up-state' })

    expect(response.status).toBe(404)
  })

  it('preview refuses an upstream 4xx from the token exchange (an expired or replayed code) the same way the install flow does', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { DiscordRequestError } = await import('@bloombot/discord-rest')
    const fakeDiscord = createFakeDiscordRestClient({
      exchangeError: new DiscordRequestError(400, { error: 'invalid_grant' }),
    })
    const app = await buildTestApp(testDb.db, {
      discordRestClient: fakeDiscord,
    })
    const { state } = await beginConnect(app, caller.organizationId, caller)

    const response = await request(app)
      .post(
        `/organizations/${caller.organizationId}/person-link/discord/preview`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ code: 'a-replayed-code', state })

    expect(response.status).toBe(404)
  })

  // Kept as a forward guard, not evidence of a fix: `confirmDiscordInputSchema`
  // has no field for `discordExternalId` at all, so zod strips it before
  // this handler ever runs — there is no code path this test could exercise
  // that reads it. It stays here so a *future* change that widens the
  // schema to accept one is caught immediately, not to prove today's
  // protection (that is what "session binding" and "the tenant-write oracle
  // is closed", above, actually prove).
  it("confirm has no field for a client-resupplied discordExternalId — only what preview's own exchange actually proved", async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const fakeDiscord = createFakeDiscordRestClient({
      currentUser: { id: 'the-real-snowflake', username: 'real-student' },
    })
    const app = await buildTestApp(testDb.db, {
      discordRestClient: fakeDiscord,
    })
    const { state } = await beginConnect(app, caller.organizationId, caller)
    await request(app)
      .post(
        `/organizations/${caller.organizationId}/person-link/discord/preview`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ code: 'the-code', state })

    await request(app)
      .post(
        `/organizations/${caller.organizationId}/person-link/discord/confirm`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ state, discordExternalId: 'someone-elses-snowflake' })

    expect(
      people.resolveIdentity(
        caller.organizationId,
        { surface: 'discord', externalId: 'the-real-snowflake' },
        testDb.db
      )
    ).toBeDefined()
    expect(
      people.resolveIdentity(
        caller.organizationId,
        { surface: 'discord', externalId: 'someone-elses-snowflake' },
        testDb.db
      )
    ).toBeUndefined()
  })
})

describe('POST .../mcp/preview and .../mcp/confirm (LINK-8)', () => {
  // Also worth fixing (rework, round two): a nonexistent organization used
  // to answer `organization_not_found` while a real organization the token
  // simply does not name answered `person_link_not_found` — two different
  // error codes an attacker could use to learn whether an organization id
  // is real, on top of the write itself. Both routes now resolve
  // existence purely through the peek-and-match check, so the two cases
  // are identical.
  it('a nonexistent organization and a real organization the token does not name answer with the identical error code', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const realButUnrelatedOrganizationId = seedOtherOrganization(testDb.db)
    const app = await buildTestApp(testDb.db)
    const issued = issueMcpPersonLinkToken(
      caller.organizationId,
      'assistant-3',
      testDb.db
    )

    const nonexistent = await request(app)
      .post(`/organizations/${randomUUID()}/person-link/mcp/preview`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ token: issued.token })
    const realButUnrelated = await request(app)
      .post(
        `/organizations/${realButUnrelatedOrganizationId}/person-link/mcp/preview`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ token: issued.token })

    expect(nonexistent.status).toBe(404)
    expect(realButUnrelated.status).toBe(404)
    expect((nonexistent.body as { error: string }).error).toBe(
      (realButUnrelated.body as { error: string }).error
    )
  })

  it('previews then confirms an MCP-issued token, attaching the identity to the caller own connected person', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    // D-44 rework, round two — MCP resolves the survivor read-only now; the
    // caller needs an existing, connected person in this organization
    // before there is anything for an MCP identity to attach to.
    seedConnectedWebPerson(testDb.db, caller.organizationId, caller.accountId)
    const app = await buildTestApp(testDb.db)
    const issued = issueMcpPersonLinkToken(
      caller.organizationId,
      'assistant-1',
      testDb.db
    )

    const preview = await request(app)
      .post(`/organizations/${caller.organizationId}/person-link/mcp/preview`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ token: issued.token })
    expect(preview.status).toBe(200)
    expect(
      (preview.body as { preview: { outcome: { kind: string } } }).preview
        .outcome
    ).toEqual({ kind: 'attach' })

    const confirm = await request(app)
      .post(`/organizations/${caller.organizationId}/person-link/mcp/confirm`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ token: issued.token })
    expect(confirm.status).toBe(200)

    expect(
      people.resolveIdentity(
        caller.organizationId,
        { surface: 'mcp', externalId: 'assistant-1' },
        testDb.db
      )
    ).toBeDefined()
  })

  it('confirm refuses a token already spent by a prior confirm (single-use)', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    seedConnectedWebPerson(testDb.db, caller.organizationId, caller.accountId)
    const app = await buildTestApp(testDb.db)
    const issued = issueMcpPersonLinkToken(
      caller.organizationId,
      'assistant-2',
      testDb.db
    )
    await request(app)
      .post(`/organizations/${caller.organizationId}/person-link/mcp/confirm`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ token: issued.token })

    const second = await request(app)
      .post(`/organizations/${caller.organizationId}/person-link/mcp/confirm`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ token: issued.token })

    expect(second.status).toBe(404)
  })
})

describe('acceptance — a roster-admitted student who has never signed in connects Discord and reaches the web chat', () => {
  it('follows the LINK-1 invitation, signs in with no membership in that organization, connects through the real HTTP endpoints, then asks a question and gets an answer', async () => {
    testDb = createTestDatabase()
    // The organization a course lives in, and the discord-surface person a
    // roster import (or that student's own first Discord message) already
    // admitted — this student has never signed into the panel at all, the
    // same starting point `docs/DECISIONS.md`'s own brief for this slice
    // names directly.
    const roster = seedSignedInCaller(testDb.db, {
      organizationName: 'A University',
    })
    const discordExternalId = `discord-${randomUUID()}`
    const { courseId, discordPersonId } = seedEnrolledCourse(
      testDb.db,
      roster.organizationId,
      discordExternalId
    )
    // Not yet connected — exactly LINK-1's own gate.
    expect(
      people.getPerson(roster.organizationId, discordPersonId, testDb.db)
        ?.connectedAt
    ).toBeNull()

    // The student signs in — a brand-new account, no relationship at all to
    // the organization their Discord identity already belongs to: no
    // membership, own personal organization only. Exactly the shape a
    // reviewer's own reproduction drove over real HTTP.
    const student = seedSignedInCaller(testDb.db, {
      organizationName: "The student's own personal organization",
    })

    const fakeDiscord = createFakeDiscordRestClient({
      currentUser: { id: discordExternalId, username: 'the-student' },
    })
    const model = new FakeModelClient()
    const app = await buildTestApp(testDb.db, {
      discordRestClient: fakeDiscord,
      model,
    })

    // Follows the invitation, connects — the real round trip: begin,
    // preview (the OAuth exchange), confirm.
    const { state } = await beginConnect(app, roster.organizationId, student)
    const preview = await request(app)
      .post(
        `/organizations/${roster.organizationId}/person-link/discord/preview`
      )
      .set('Cookie', student.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ code: 'the-code', state })
    expect(preview.status).toBe(200)
    // Merges the roster-admitted person into the survivor — LINK-4.
    expect(
      (preview.body as { preview: { outcome: { kind: string } } }).preview
        .outcome.kind
    ).toBe('merge')

    const confirm = await request(app)
      .post(
        `/organizations/${roster.organizationId}/person-link/discord/confirm`
      )
      .set('Cookie', student.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ state })
    expect(confirm.status).toBe(200)

    // Then asks a question and gets an answer — the web chat surface,
    // resolving through the connected person, reaching the course the
    // roster admitted them to before they ever signed in.
    const coursesResponse = await request(app)
      .get(`/organizations/${roster.organizationId}/chat/courses`)
      .set('Cookie', student.cookieHeader)
    expect(coursesResponse.status).toBe(200)
    expect(
      (coursesResponse.body as { courses: { id: string }[] }).courses.map(
        (c) => c.id
      )
    ).toContain(courseId)

    const askResponse = await request(app)
      .post(
        `/organizations/${roster.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', student.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'What is the deadline for assignment 1?' })
    expect(askResponse.status).toBe(200)
    expect((askResponse.body as { result: { kind: string } }).result.kind).toBe(
      'answered'
    )
    expect(model.calls).toHaveLength(1)

    // LINK-10 — the panel's own read surface for the same, now-connected
    // caller: the institution's organization shows up as connected, never
    // as a second membership (`apps/web/src/pages/Shell.tsx` only offers
    // Discord/Projects/Transcripts for a membership).
    const me = await request(app)
      .get('/auth/me')
      .set('Cookie', student.cookieHeader)
    expect(me.status).toBe(200)
    const meAccount = (
      me.body as {
        account: {
          memberships: { organizationId: string }[]
          connectedOrganizations: { organizationId: string }[]
        } | null
      }
    ).account
    expect(
      meAccount!.memberships.map((membership) => membership.organizationId)
    ).not.toContain(roster.organizationId)
    expect(
      meAccount!.connectedOrganizations.map(
        (connection) => connection.organizationId
      )
    ).toContain(roster.organizationId)

    // The server-side proof LINK-10's own brief asks for directly: nothing
    // about connecting grants membership, so a membership-only action —
    // every tab this same connect made reachable on the *panel's* Chat tab
    // withholds from this account (`pages/Shell.tsx`'s own `isMember`
    // gate) — still refuses for this exact caller, over real HTTP, after a
    // real connect. Not merely a UI check: `routes/actions.ts` resolves
    // the caller's organization from `memberships.getMembership` before it
    // even looks up which action was requested, so this would refuse
    // identically whichever action name were dispatched.
    //
    // The action dispatched here is deliberately a *read* that would
    // otherwise succeed. A write like `discordServers.remove` refuses for a
    // second reason regardless — there is no such server — so it cannot tell
    // the membership gate from its own not-found, and a review confirmed the
    // gate can be deleted outright with this file still green. `projects.list`
    // and `discordServers.list` are precisely what the withheld Projects and
    // Discord tabs read, and under that same mutation both answer `200` with
    // the institution's own project catalogue and bound servers. So this is
    // the assertion that actually discriminates.
    const dispatch = await request(app)
      .post(`/organizations/${roster.organizationId}/actions/projects.list`)
      .set('Cookie', student.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({})
    expect(dispatch.status).toBe(404)
    expect(dispatch.body).toMatchObject({ error: 'action_refused' })
  })
})
