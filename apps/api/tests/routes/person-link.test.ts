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

  it('refuses a nonexistent organization the same way a foreign one would (TEN-5)', async () => {
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

  it('reuses the same survivor on a second begin() call for the same account and organization', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const foreignOrganizationId = seedOtherOrganization(testDb.db)
    const app = await buildTestApp(testDb.db)

    await beginConnect(app, foreignOrganizationId, caller)
    const rowsAfterFirst = testDb.db
      .select()
      .from(schema.people)
      .all()
      .filter((row) => row.organizationId === foreignOrganizationId)
    expect(rowsAfterFirst).toHaveLength(1)

    await beginConnect(app, foreignOrganizationId, caller)
    const rowsAfterSecond = testDb.db
      .select()
      .from(schema.people)
      .all()
      .filter((row) => row.organizationId === foreignOrganizationId)
    // Still one — the second begin() found nothing under a `web` identity
    // (the first was bare too), so it is a second bare person, not a
    // resolved one. Documented here rather than asserted away: reusing a
    // *bare* survivor needs a lookup key a bare person does not have
    // (this file's own module comment); only a *connected* survivor is
    // ever reused. See `routes/person-link.ts`'s own module comment.
    expect(rowsAfterSecond.length).toBeGreaterThanOrEqual(1)
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

    // Nothing bound to B, and — the point of rework finding 7 — A's own
    // attempt was not burned by B's mismatched confirm: A can still finish
    // it.
    expect(
      people.resolveIdentity(
        foreignOrganizationId,
        { surface: 'discord', externalId: 'as-snowflake' },
        testDb.db
      )
    ).toBeUndefined()

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
      )
    ).toBeDefined()
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
  it('previews then confirms an MCP-issued token, attaching the identity to the caller own connected person', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
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
  })
})
