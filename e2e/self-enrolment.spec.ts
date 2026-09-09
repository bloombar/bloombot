/**
 * ENRL-13, end to end: the headline flow the SPEC text itself leads with —
 * "a student who messages the bot in a channel that routes to this course
 * and then connects their account ... becomes enrolled in it." A course
 * with `selfEnrolFromDiscord` on, a genuinely unconnected student's first
 * message, then connecting, then the People panel (WEB-22) showing them
 * enrolled — the same "define it in the panel, watch it take effect
 * against the real pipeline" shape `course-configuration.spec.ts` already
 * proves for CORE-1/CORE-2.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline every other spec
 * in this directory holds itself to):
 *
 *  - Real: the browser (`pages/CourseEditor.tsx`'s new ENRL-13/ENRL-14
 *    checkboxes, `components/CoursePeople.tsx`), a real `apps/api`
 *    (`routes/actions.ts`, unmodified), a real throwaway SQLite database,
 *    and `courses.save` writing `selfEnrolFromDiscord` exactly the way any
 *    other caller reaches it.
 *  - Real: `@bloombot/discord`'s own `handleMention` (SURF-1..6) and the
 *    ENRL-13 admission/intent logic inside it, and `@bloombot/db`'s
 *    `repos/self-enrolment.ts#redeemSelfEnrolmentIntents` — the actual
 *    production code, unmodified, run against the same database file the
 *    browser and `apps/api` just wrote to.
 *  - **Not real, and this is the harness's own stand-in, not `apps/bot`'s
 *    or `apps/api`'s**: there is no discord.js client and no Discord OAuth
 *    consent screen anywhere in this harness (`e2e/support/start-api.ts`'s
 *    own module comment: the API's Discord config points at unreachable
 *    loopback addresses on purpose) — `course-configuration.spec.ts`
 *    already establishes that a Discord server binding is inserted
 *    directly (`discordServers.claimDiscordServerBinding`) rather than
 *    walked through Discord's own consent screen, and that connecting an
 *    identity is simulated the way a real proof would leave it
 *    (`people.mergePeople`, the same primitive `@bloombot/auth`'s
 *    `person-link.ts#completeDiscordPersonLink` calls once a real OAuth
 *    proof succeeds). This spec reuses both devices, and adds one more:
 *    `selfEnrolment.redeemSelfEnrolmentIntents` is called directly,
 *    immediately after the merge — the exact same two calls, in the exact
 *    same order, `routes/person-link.ts#buildPersonLinkRouter`'s real
 *    `/discord/confirm` handler makes once Discord's own OAuth genuinely
 *    completes (`attachWebIdentityOrMerge` then
 *    `redeemSelfEnrolmentIntentsSafely`) — just invoked here instead of
 *    reached over HTTP through a browser that cannot reach discord.com.
 *  - **Not real**: the model — nothing here asks the course a question;
 *    this spec is about admission, not answering.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  courses,
  discordServers,
  enrolments,
  memberships,
  openDatabase,
  people,
  projects,
  selfEnrolment,
} from '@bloombot/db'
import { handleMention, type InboundMention } from '@bloombot/discord'

import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { createFakeLogger } from './support/fake-logger.js'
import { FakeModelClient } from './support/fake-model-client.js'
import { FakeReplyPort } from './support/fake-reply-port.js'
import { signIn } from './support/sign-in.js'

test('a student who messages a self-enrolling course, then connects, ends up enrolled (ENRL-13)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `enrl13-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Intro to Testing — ${suffix}`
  const categoryName = `Intro to Testing - GLOBAL - ${suffix}`

  // 1. Sign in, define a course, and turn on ENRL-13's own checkbox —
  //    everything through the panel alone, the same as
  //    `course-configuration.spec.ts`'s own steps 1-3.
  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await navigateTo(page, 'Projects')
  await page.getByRole('button', { name: 'New project' }).click()
  const newProjectDialog = page.getByRole('dialog', { name: 'New project' })
  await newProjectDialog.getByLabel('Project name').fill(projectName)
  await newProjectDialog.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: projectName, exact: true }).click()

  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(courseTitle)
  await page.getByLabel('Admins role').fill(`admins-${suffix}`)
  await page.getByLabel('Students role').fill(`students-${suffix}`)
  await page.getByRole('button', { name: 'Add category' }).click()
  await page.getByLabel('Category name').fill(categoryName)
  await page.getByLabel('Enabled').check()
  await page
    .getByLabel('Students can enrol themselves by messaging this course')
    .check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()
  await expect(
    page.getByLabel('Students can enrol themselves by messaging this course')
  ).toBeChecked()

  // CFG-2/D-3 — a course with neither `instructions` nor `promptId` set
  // answers nothing at all (`answerQuestion`'s own "not-configured" result,
  // checked *before* LINK-1's own "not connected" gate — this test needs
  // to reach that gate, not `not-configured`), so instructions are saved
  // the same way `course-configuration.spec.ts`'s own step 3 does.
  await page.getByRole('tab', { name: 'AI' }).click()
  await page
    .getByLabel('Instructions')
    .fill('Answer student questions about the course clearly and concisely.')
  await page.getByRole('button', { name: 'Save instructions' }).click()
  await expect(page.getByText('Current')).toBeVisible()

  // 2. WEB-22: before anyone has asked, People shows the empty state.
  await page.getByRole('tab', { name: 'People' }).click()
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible()
  await expect(page.getByText('Nobody is enrolled yet.')).toBeVisible()

  // 3. This is where the browser's own part pauses. Everything from here
  //    reads back the same database the browser and `apps/api` just wrote
  //    to, and drives `@bloombot/discord`'s real `handleMention` directly
  //    (this file's own module comment: no discord.js, no gateway, no
  //    OpenAI call).
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
    expect(course.selfEnrolFromDiscord).toBe(true)

    // Bind a Discord server directly — `course-configuration.spec.ts`'s
    // own module comment on why TEN-4's real OAuth consent screen cannot
    // be automated here.
    const guildId = `e2e-guild-${suffix}`
    const claimed = discordServers.claimDiscordServerBinding(
      organizationId,
      { serverId: guildId, installedByAccountId: account.id },
      db
    )
    if (!claimed) throw new Error('setup failed: could not bind guild')

    const model = new FakeModelClient('unused — no question is asked')
    const reply = new FakeReplyPort()
    const logger = createFakeLogger()
    const botId = 'e2e-bot'
    const studentDiscordId = `e2e-student-${suffix}`

    // 4. The unenrolled student's Discord message — genuinely unconnected
    //    (LINK-1's own gate), so ENRL-13 records an intent, not an
    //    enrolment, and the reply is the ordinary connect invitation.
    const mention: InboundMention = {
      guildId,
      channelName: 'general',
      categoryName,
      authorId: studentDiscordId,
      authorDisplayName: 'QA Student',
      authorRoleNames: [],
      text: `<@${botId}> Hi!`,
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
    expect(result.kind).toBe('invited-to-connect')

    const studentPerson = people.resolveIdentity(
      organizationId,
      { surface: 'discord', externalId: studentDiscordId },
      db
    )
    if (!studentPerson) throw new Error('setup failed: student not resolved')
    // Not enrolled yet — only an intent, waiting on the connect that comes
    // next.
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        studentPerson.id,
        db
      )
    ).toBeUndefined()

    // 5. Connecting — simulated the same way `course-configuration.spec.ts`
    //    already simulates a real proof (`people.mergePeople`), immediately
    //    followed by the same call `routes/person-link.ts`'s real
    //    `/discord/confirm` handler makes right after
    //    (`redeemSelfEnrolmentIntentsSafely`, this file's own module
    //    comment).
    const throwawayWebIdentity = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'web', externalId: `e2e-web-${suffix}` },
      db
    )
    const merged = people.mergePeople(
      organizationId,
      studentPerson.id,
      throwawayWebIdentity.id,
      db
    )
    if (!merged) throw new Error('setup failed: could not connect the student')
    selfEnrolment.redeemSelfEnrolmentIntents(
      organizationId,
      studentPerson.id,
      db
    )

    // Read back directly — genuinely enrolled, through ENRL-13's own
    // source, before the browser ever looks again.
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        studentPerson.id,
        db
      )
    ).toMatchObject({ source: 'self_enrolment' })
  } finally {
    closeDatabase(db)
  }

  // 6. Back in the browser: the People panel now shows the student
  //    enrolled — WEB-22/ENRL-13 end to end.
  await page.reload()
  await page.getByRole('tab', { name: 'People' }).click()
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible()
  await expect(page.getByText('Enrolled (1)')).toBeVisible()
  await expect(page.getByText(/Self-enrolled — admitted/)).toBeVisible()
})
