/**
 * QA-8: "the product's central claim is tested end to end." Phase 7's own
 * point, from `docs/ROADMAP.md`: "a tenant creates a project, defines a
 * course in it, and the bot answers in their server without anyone editing
 * a file in this repository." This spec drives every step of that sentence
 * except the very last hop.
 *
 * **What is real, and what is a harness stand-in — read this before trusting
 * what this test proves:**
 *
 *  - Real: the browser (`pages/Projects.tsx`, `pages/Courses.tsx`,
 *    `pages/CourseEditor.tsx`), a real `apps/api` (`e2e/support/start-api.ts`),
 *    a real throwaway SQLite database, and every action this UI drives —
 *    `projects.create`, `courses.save`, `courses.enable` — reached exactly
 *    the way any other caller reaches them (WEB-7/PROJ-5's own point).
 *  - Real: `@bloombot/discord`'s own `handleMention` (SURF-1..6) and
 *    `@bloombot/core`'s `answerQuestion`/`routeMessage` underneath it — the
 *    actual routing and answering pipeline, unmodified, running against the
 *    same database file the browser and `apps/api` just wrote to.
 *  - **Not real, and this is the harness's own stand-in, not `apps/bot`'s**:
 *    there is no discord.js client anywhere in this spec, no gateway
 *    connection, and no Discord server was ever created. The Discord server
 *    binding this test needs is inserted directly with
 *    `discordServers.claimDiscordServerBinding` — the same repository
 *    function TEN-4's real install flow calls, just invoked here instead of
 *    walked through Discord's own OAuth consent screen, which this harness
 *    has no way to automate. The "message arriving in Discord" is a plain
 *    `InboundMention` object this spec constructs by hand
 *    (`e2e/support/fake-reply-port.ts`'s own module comment has the same
 *    caveat) and hands to `handleMention` *in this test process*, not
 *    posted to any real channel.
 *  - **Not real**: the model. `e2e/support/fake-model-client.ts` answers
 *    with a fixed string — no OpenAI call happens anywhere in this run
 *    (QA-3's own "no network beyond loopback").
 *
 * So this test proves: a course defined entirely through the panel's own
 * screens, with no file in this repository touched and no process
 * restarted, is exactly the configuration `handleMention` routes and
 * answers a matching message with — the database round trip the whole
 * migration exists to make true. It does not prove discord.js itself wires
 * correctly to `handleMention` (`apps/bot`, untouched by this slice) or that
 * a real OpenAI call succeeds (`packages/openai`, also untouched).
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  conversations,
  courses,
  discordServers,
  memberships,
  openDatabase,
  people,
  projects,
} from '@bloombot/db'
import { handleMention, type InboundMention } from '@bloombot/discord'

import { E2E_DATABASE_PATH } from './support/env.js'
import { createFakeLogger } from './support/fake-logger.js'
import { FakeModelClient } from './support/fake-model-client.js'
import { FakeReplyPort } from './support/fake-reply-port.js'
import { readSignInToken } from './support/read-sign-in-token.js'

test('a project and course defined entirely in the panel route and answer a matching message (QA-8)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `qa8-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Web Design — ${suffix}`
  const categoryName = `Web Design - GLOBAL - ${suffix}`
  const studentsRole = `students-wd-${suffix}`
  const adminsRole = `admins-wd-${suffix}`
  const courseInstructions =
    'Answer student questions about the course clearly and concisely.'

  // 1. Sign in — the same emailed-link flow `auth-flow.spec.ts` exercises,
  //    which also creates this account's own personal organization (TEN-1).
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(email)
  const token = await readSignInToken(email)
  await page.goto(`/sign-in/${token}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // 2. Create a project (WEB-7/PROJ-1), through the panel alone.
  await page.getByRole('button', { name: 'Projects' }).click()
  await page.getByLabel('New project name').fill(projectName)
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('button', { name: projectName }).click()

  // 3. Define a course in it (WEB-8): title, roles (CFG-3), one category
  //    (CFG-4) — the two names that decide routing (WEB-9) — instructions
  //    (CFG-2: D-3's escape hatch — a course with neither `instructions` nor
  //    `promptId` set answers nothing at all, `answerQuestion`'s own
  //    "not-configured" result) — and enable it.
  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(courseTitle)
  await page.getByLabel('File prefix').fill(`wd-${suffix}`)
  await page.getByLabel('Admins role').fill(adminsRole)
  await page.getByLabel('Students role').fill(studentsRole)
  await page.getByRole('button', { name: 'Add category' }).click()
  await page.getByLabel('Category name').fill(categoryName)
  await page.getByLabel('Instructions').fill(courseInstructions)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()

  // The save succeeded once the dedicated enable/disable control appears —
  // it only renders once `courseId` is set, i.e. once `courses.save`
  // actually returned a saved course rather than a refusal.
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible()

  // 4. This is where the browser's own part ends. Everything from here
  //    reads back the same database `apps/api` just wrote to, and drives
  //    `@bloombot/discord`'s real `handleMention` directly (this module's
  //    own comment: no discord.js, no gateway, no OpenAI call).
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const account = accounts.getAccountByEmail(email, db)
    if (!account) throw new Error('setup failed: account not found')
    const [membership] = memberships.listMembershipsForAccount(account.id, db)
    if (!membership) throw new Error('setup failed: membership not found')
    const organizationId = membership.organizationId

    const project = projects
      .listProjects(organizationId, db)
      .find((candidate) => candidate.name === projectName)
    if (!project) throw new Error('setup failed: project not found')
    const course = courses
      .listCourses(organizationId, db, { projectId: project.id })
      .find((candidate) => candidate.title === courseTitle)
    if (!course) throw new Error('setup failed: course not found')
    expect(course.enabled).toBe(true)

    // Bind a Discord server directly (see this file's own module comment
    // for why: TEN-4's real OAuth consent screen cannot be automated here) —
    // the same repository function the real install flow calls.
    const guildId = `e2e-guild-${suffix}`
    const claimed = discordServers.claimDiscordServerBinding(
      organizationId,
      { serverId: guildId, installedByAccountId: account.id },
      db
    )
    if (!claimed) throw new Error('setup failed: could not bind guild')

    const model = new FakeModelClient('The midterm is on the 14th.')
    const reply = new FakeReplyPort()
    const logger = createFakeLogger()
    const botId = 'e2e-bot'
    const studentDiscordId = `e2e-student-${suffix}`

    // LINK-1 — an unconnected identity is invited to connect, not answered;
    // this test is proving CORE-2/CORE-1's routing and answering pipeline
    // (QA-8's own scope, this file's own module comment), not LINK-1 itself,
    // so the student is connected the same way a real proof would leave
    // them (`@bloombot/db`'s `people.ts#mergePeople`, called by
    // `@bloombot/auth`'s `person-link.ts` once a real proof succeeds) —
    // merging a second, throwaway identity onto the Discord one this
    // mention is about to arrive under.
    const student = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'discord', externalId: studentDiscordId },
      db
    )
    const other = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'web', externalId: `e2e-web-${suffix}` },
      db
    )
    const merged = people.mergePeople(organizationId, student.id, other.id, db)
    if (!merged)
      throw new Error('setup failed: could not connect the e2e student')

    // authorRoleNames is deliberately empty: the requirement under test is
    // that a message in *this course's own category* is routed to it, and
    // `handleMention` falls back to role names only when the category
    // matches no course (`packages/discord/src/dto.ts`'s own comment on
    // `authorRoleNames`) — leaving the role populated let it carry the whole
    // route while the category the instructor typed went unchecked (finding
    // 1 of the WEB-7 rework).
    const mention: InboundMention = {
      guildId,
      channelName: 'announcements',
      categoryName,
      authorId: studentDiscordId,
      authorDisplayName: 'QA Student',
      authorRoleNames: [],
      text: `<@${botId}> When is the midterm?`,
      botId,
      authorIsBot: false,
      repliesToBot: false,
    }

    const result = await handleMention(mention, {
      db,
      model,
      logger,
      reply,
      day: '2026-09-01',
      connectUrl: 'https://e2e.bloombot.test',
    })

    // Routed to, and answered by, exactly the course this test just defined
    // through the panel — nothing here is a fixture or a seed script.
    expect(result.kind).toBe('answered')
    if (result.kind !== 'answered') {
      throw new Error(`expected "answered", got "${result.kind}"`)
    }
    expect(model.calls).toHaveLength(1)
    // The instructions the model was asked with are the ones the instructor
    // typed into the panel, not merely *some* non-null value — proves the
    // saved course's own configuration reached `handleMention`, not a
    // default (finding 1 of the WEB-7 rework).
    expect(model.calls[0]?.instructions).toBe(courseInstructions)
    expect(reply.sent).toEqual(['The midterm is on the 14th.'])

    // Both directions are in the transcript (CONV-2).
    const transcript = conversations.getTranscript(
      organizationId,
      result.conversationId,
      db
    )
    expect(transcript.map((message) => message.direction)).toEqual([
      'from_person',
      'to_person',
    ])
    expect(transcript[0]?.content).toContain('When is the midterm?')
    expect(transcript[1]?.content).toBe('The midterm is on the 14th.')
  } finally {
    closeDatabase(db)
  }
})
