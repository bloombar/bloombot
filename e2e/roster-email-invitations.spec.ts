/**
 * ROST-21 and WEB-82, end to end: a roster for a course without Discord
 * invites students by email; signing in with that email accepts.
 *
 * The instructor creates a "No Discord" course and uploads a roster with no
 * Discord column naming three students:
 *
 *  - B has already signed in, so B is enrolled the moment the import runs and
 *    the course appears in B's web chat;
 *  - A has no account yet, so A appears under "Invited — not signed in yet",
 *    and signing in by emailed link enrols A (the course appears in A's chat);
 *  - C is also invited, then removed by the instructor, and disappears.
 *
 * **What is real, and what is a harness stand-in** (the discipline
 * `roster-import-panel.spec.ts` holds itself to): the browser, the real
 * `apps/api`, a real throwaway SQLite database, the real sign-in round trip,
 * and `apps/worker`'s own `createRosterImportHandler` run through
 * `@bloombot/jobs`'s own `runNextJob`. There is no live worker process in this
 * harness, so the spec claims and runs the `roster.import` job itself. No
 * Discord is involved at all: the handler is given a client that points
 * nowhere, which is itself part of the proof (a discord-off import makes no
 * Discord call).
 */

import { randomUUID } from 'node:crypto'

import { expect, test, type Page } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  courseApproval,
  courseInvitations,
  courses,
  enrolments,
  memberships,
  openDatabase,
  organizations,
  people,
  projects,
  type Database,
} from '@bloombot/db'
import { createDiscordRestClient } from '@bloombot/discord-rest'
import { HandlerRegistry, runNextJob, type RetryPolicy } from '@bloombot/jobs'

import { createRosterImportHandler } from '../apps/worker/src/handlers/roster-import.js'
import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { signIn } from './support/sign-in.js'

const RETRY_POLICY: RetryPolicy = { baseDelayMs: 1000, backoffFactor: 2 }

/** Claims and runs one `roster.import` job — this spec's stand-in for a live `apps/worker` (see the module comment). */
async function claimAndRunRosterImportJob(db: Database) {
  // Never called: a course without Discord touches no guild.
  const discordRestClient = createDiscordRestClient({
    clientId: 'unused',
    clientSecret: 'unused',
    apiBase: 'http://127.0.0.1:9',
    oauthBase: 'http://127.0.0.1:9',
  })
  const handlers = new HandlerRegistry()
  handlers.register(
    'roster.import',
    createRosterImportHandler({ discordRestClient, botToken: 'bot-token' })
  )
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await runNextJob({
      db,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      handlers,
      owner: 'e2e-worker',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      retryPolicy: RETRY_POLICY,
    })
    if (result.outcome !== 'empty') return result
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('no eligible roster.import job appeared within 2s')
}

/** Switches to the instructor's organization (it shows as "connected") and checks the course is in the student's web chat. */
async function expectCourseInChat(
  page: Page,
  organizationName: string,
  courseTitle: string
) {
  await page.reload()
  const switcher = page.getByTestId('organization-switcher')
  await switcher.getByRole('button').click()
  const menu = page.getByRole('group', { name: 'Organizations' })
  await menu
    .getByRole('button', { name: `${organizationName} (connected)` })
    .click()
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()
  await expect(page.getByText(courseTitle)).toBeVisible()
}

test('a roster for a course without Discord invites by email: a signed-in student is enrolled at once, an unsigned one on sign-in, and an invitation can be removed (ROST-21, WEB-82)', async ({
  page,
  browser,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const instructorEmail = `inst-${suffix}@example.edu`
  const emailA = `a-${suffix}@example.edu`
  const emailB = `b-${suffix}@example.edu`
  const emailC = `c-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Web Only — ${suffix}`

  // B has already signed in, so an account exists for B's address.
  const contextB = await browser.newContext()
  const pageB = await contextB.newPage()
  await signIn(pageB, emailB)
  await expect(pageB.getByTestId('organization-switcher')).toBeVisible()

  // 1. The instructor creates a project and a No-Discord course.
  await signIn(page, instructorEmail)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()
  await navigateTo(page, 'Projects')
  await page.getByRole('button', { name: 'New project' }).click()
  const newProjectDialog = page.getByRole('dialog', { name: 'New project' })
  await newProjectDialog.getByLabel('Project name').fill(projectName)
  await newProjectDialog.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: projectName, exact: true }).click()

  await page.getByRole('button', { name: 'New course' }).click()
  await expect(page.getByLabel('Discord server')).toHaveValue('none')
  await page.getByLabel('Title').fill(courseTitle)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()

  // The one fact the panel has no screen for: COST-8 approval, so chat can
  // answer. Also reads the ids the checks below need.
  const setupDb = openDatabase(E2E_DATABASE_PATH)
  let organizationId: string
  let organizationName: string
  let courseId: string
  try {
    const account = accounts.getAccountByEmail(instructorEmail, setupDb)
    if (!account) throw new Error('setup failed: instructor not found')
    const [membership] = memberships.listMembershipsForAccount(
      account.id,
      setupDb
    )
    if (!membership) throw new Error('setup failed: membership not found')
    organizationId = membership.organizationId
    organizationName =
      organizations.getOrganizationById(organizationId, setupDb)?.name ?? ''
    const project = projects
      .listProjects(organizationId, setupDb)
      .find((candidate) => candidate.name === projectName)
    if (!project) throw new Error('setup failed: project not found')
    const course = courses
      .listCourses(organizationId, setupDb, { projectId: project.id })
      .find((candidate) => candidate.title === courseTitle)
    if (!course) throw new Error('setup failed: course not found')
    courseId = course.id
    courseApproval.approveCourse(
      organizationId,
      courseId,
      null,
      'approve',
      Date.now(),
      setupDb
    )
  } finally {
    closeDatabase(setupDb)
  }

  // 2. The Roster tab says only Email is needed, and the CSV has no
  //    Discord column.
  await page.getByRole('tab', { name: 'Roster' }).click()
  await expect(page.getByText('First,Last,Email,GitHub')).toBeVisible()
  await expect(page.getByText('First,Last,Email,Discord,GitHub')).toHaveCount(0)

  const csvText = [
    'First,Last,Email,GitHub',
    `Ada,Lovelace,${emailA},`,
    `Bea,Builder,${emailB},`,
    `Cy,Typo,${emailC},`,
  ].join('\n')
  await page
    .getByTestId('roster-import')
    .locator('input[type="file"]')
    .setInputFiles({
      name: 'roster.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csvText),
    })
  await page.getByRole('checkbox', { name: /Uploading my students/ }).check()
  await page.getByRole('button', { name: 'Import roster' }).click()
  await expect(page.getByText('Queued…')).toBeVisible()

  const workerDb = openDatabase(E2E_DATABASE_PATH)
  try {
    const run = await claimAndRunRosterImportJob(workerDb)
    expect(run.outcome).toBe('succeeded')
  } finally {
    closeDatabase(workerDb)
  }

  // 3. The report counts invitations, and B was enrolled straight away.
  const report = page.getByTestId('roster-import-report')
  await expect(report).toBeVisible({ timeout: 10_000 })
  await expect(report).toContainText('3 invited')
  await expect(report).toContainText('1 enrolled straight away')

  const checkDb = openDatabase(E2E_DATABASE_PATH)
  try {
    const accountB = accounts.getAccountByEmail(emailB, checkDb)
    if (!accountB) throw new Error('verify failed: B has no account')
    const personB = people.resolveIdentity(
      organizationId,
      { surface: 'web', externalId: accountB.id },
      checkDb
    )
    if (!personB) throw new Error('verify failed: B has no person here')
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        courseId,
        personB.id,
        checkDb
      )?.source
    ).toBe('roster')
    expect(
      courseInvitations
        .listOpenInvitationsForCourse(organizationId, courseId, checkDb)
        .map((invitation) => invitation.email)
        .sort()
    ).toEqual([emailA, emailC])
  } finally {
    closeDatabase(checkDb)
  }

  // B's web chat has the course.
  await expectCourseInChat(pageB, organizationName, courseTitle)

  // 4. The People tab lists A and C as invited, and B as enrolled.
  await page.getByRole('tab', { name: 'People' }).click()
  await expect(page.getByText('Invited — not signed in yet (2)')).toBeVisible()
  const invited = page.getByTestId('course-invitations')
  await expect(invited).toContainText('Ada Lovelace')
  await expect(invited).toContainText(emailA)
  await expect(invited).toContainText('Cy Typo')
  await expect(page.getByText('Enrolled (1)')).toBeVisible()
  await expect(page.getByTestId('course-people')).toContainText('Bea Builder')

  // 5. Remove C's mistyped invitation, behind a confirmation.
  await page
    .getByRole('button', { name: 'Remove the invitation for Cy Typo' })
    .click()
  const dialog = page.getByRole('dialog', {
    name: 'Remove the invitation for Cy Typo?',
  })
  await dialog.getByRole('button', { name: 'Remove invitation' }).click()
  await expect(page.getByText('Invited — not signed in yet (1)')).toBeVisible()
  await expect(invited).not.toContainText('Cy Typo')
  await expect(invited).toContainText('Ada Lovelace')

  // 6. A signs in by emailed link; signing in enrols A, and the course is in
  //    A's chat.
  const contextA = await browser.newContext()
  try {
    const pageA = await contextA.newPage()
    await signIn(pageA, emailA)
    // Signing in accepted the invitation, so A now belongs to the
    // instructor's organization as well as their own, and is asked which to
    // open. The instructor's is listed as "connected".
    await expect(
      pageA.getByRole('heading', { name: 'Choose an organization' })
    ).toBeVisible()
    await pageA
      .getByRole('listitem')
      .filter({ hasText: `${organizationName} (connected)` })
      .getByRole('button', { name: 'Choose' })
      .click()
    await expect(pageA.getByRole('heading', { name: 'Chat' })).toBeVisible()
    await expect(pageA.getByText(courseTitle)).toBeVisible()
  } finally {
    await contextA.close()
    await contextB.close()
  }

  // 7. Back on the instructor's panel A has left "Invited" and is enrolled
  //    (as "Roster import"); C never gets in.
  await page.reload()
  await page.getByRole('tab', { name: 'People' }).click()
  await expect(page.getByText('Enrolled (2)')).toBeVisible()
  await expect(page.getByText(/Invited — not signed in yet/)).toHaveCount(0)
  await expect(page.getByTestId('course-people')).toContainText('Roster import')
})
