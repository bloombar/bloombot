/**
 * WEB-21, end to end: an instructor imports a roster CSV entirely through
 * the panel — a large drop zone with the format stated on screen, progress
 * while the job runs, and a finished report naming an unparseable row by
 * its own line number. Re-importing the identical roster a second time
 * admits nobody twice.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `course-knowledge-files.spec.ts`'s own module comment holds itself to,
 * for the identical "no live `apps/worker` process in this harness"
 * reason):
 *
 *  - Real: the browser (`pages/CourseEditor.tsx`, `components/RosterImport.tsx`),
 *    a real `apps/api`, a real throwaway SQLite database, and every action
 *    this UI drives — `courses.save`, `roster.import`, `jobs.get` — reached
 *    exactly the way any other caller reaches them.
 *  - Real: `apps/worker`'s own `createRosterImportHandler` and
 *    `@bloombot/jobs`'s own `runNextJob` — the actual claim/run machinery,
 *    unmodified, run against the same database file the browser and
 *    `apps/api` just wrote to.
 *  - **Not real, and this is the harness's own stand-in, not `apps/worker`'s**:
 *    no `apps/worker` *process* runs continuously in this harness — this
 *    spec claims and runs the `roster.import` job itself, the same device
 *    `course-knowledge-files.spec.ts` already uses for
 *    `courseAttachments.attach`/`.detach`.
 *  - **Not real**: Discord itself. `e2e/support/fake-discord-guild-server.ts`
 *    is a loopback fake of the guild-management and member-list endpoints
 *    the handler calls — no Discord call happens anywhere in this run
 *    (QA-3's own "no network beyond loopback"). The Discord server binding
 *    this test needs is inserted directly with
 *    `discordServers.claimDiscordServerBinding`, the same repository
 *    function TEN-4's real install flow calls — `course-configuration.spec.ts`'s
 *    own module comment already explains why a real OAuth consent screen
 *    cannot be automated here.
 *
 * So this test proves: a roster CSV chosen through the panel's own drop
 * zone is parsed, enrols the rows that resolve and reports the one that
 * does not with its own line number, and importing the identical file a
 * second time enrols nobody a second time — read back from the enrolment
 * rows themselves, not the report's own wording.
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
  projects,
  type Database,
} from '@bloombot/db'
import {
  createDiscordRestClient,
  type DiscordRestClient,
} from '@bloombot/discord-rest'
import { HandlerRegistry, runNextJob, type RetryPolicy } from '@bloombot/jobs'

import { createRosterImportHandler } from '../apps/worker/src/handlers/roster-import.js'
import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { FakeDiscordGuildServer } from './support/fake-discord-guild-server.js'
import { readSignInToken } from './support/read-sign-in-token.js'

const RETRY_POLICY: RetryPolicy = { baseDelayMs: 1000, backoffFactor: 2 }

/**
 * Claims and runs exactly one `roster.import` job — this spec's own
 * stand-in for a live `apps/worker` process (this file's own module
 * comment has the full reasoning). Retries a few times, a short real delay
 * apart, the same "poll until something is there" device
 * `course-knowledge-files.spec.ts`'s own `claimAndRunJob` already uses, for
 * the identical race: the browser's own enqueue can resolve a few
 * milliseconds before this test process's next line runs.
 */
async function claimAndRunRosterImportJob(
  db: Database,
  discordServer: FakeDiscordGuildServer
) {
  const discordRestClient: DiscordRestClient = createDiscordRestClient({
    clientId: 'unused',
    clientSecret: 'unused',
    apiBase: discordServer.baseUrl,
    oauthBase: discordServer.baseUrl,
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
  throw new Error(
    'claimAndRunRosterImportJob: no eligible job appeared within 2s'
  )
}

test('an instructor imports a roster through the panel; an unparseable row is reported with its own line number, and re-importing admits nobody twice (WEB-21, ROST-9..12)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web21-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Web Design — ${suffix}`
  const categoryName = `${courseTitle} - STUDENTS 01`

  const discordServer = await FakeDiscordGuildServer.start()
  try {
    // 1. Sign in, create a project and a course — the same panel-only path
    //    `course-configuration.spec.ts` already proves for CFG-2..4, with
    //    one numbered student category (CFG-4) for the roster's own
    //    channels to land in.
    await page.goto('/')
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
    await expect(page.getByTestId('link-requested')).toContainText(email)
    const token = await readSignInToken(email)
    await page.goto(`/sign-in/${token}`)
    await expect(page.getByTestId('organization-switcher')).toBeVisible()

    await navigateTo(page, 'Projects')
    // WEB-27: "New project" opens a modal that asks for the name.
    await page.getByRole('button', { name: 'New project' }).click()
    const newProjectDialog = page.getByRole('dialog', { name: 'New project' })
    await newProjectDialog.getByLabel('Project name').fill(projectName)
    await newProjectDialog.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: projectName, exact: true }).click()

    await page.getByRole('button', { name: 'New course' }).click()
    await page.getByLabel('Title').fill(courseTitle)
    await page.getByLabel('File prefix').fill(`wd-${suffix}`)
    await page.getByLabel('Admins role').fill(`admins-wd-${suffix}`)
    await page.getByLabel('Students role').fill(`students-wd-${suffix}`)
    await page.getByRole('button', { name: 'Add category' }).click()
    await page.getByLabel('Category name').fill(categoryName)
    await page.getByRole('button', { name: 'Save course' }).click()
    await expect(page.getByRole('heading', { name: 'Roster' })).toBeVisible()

    // 2. Bind a Discord server directly (`course-configuration.spec.ts`'s
    //    own module comment: TEN-4's real OAuth consent screen cannot be
    //    automated here), and seed the fake guild with the category this
    //    course just declared — standing in for an earlier
    //    `discordServers.scaffold` run.
    const db = openDatabase(E2E_DATABASE_PATH)
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

    const guildId = `e2e-guild-${suffix}`
    const claimed = discordServers.claimDiscordServerBinding(
      organizationId,
      { serverId: guildId, installedByAccountId: account.id },
      db
    )
    if (!claimed) throw new Error('setup failed: could not bind guild')
    discordServer.setGuildChannels(guildId, [
      { id: 'cat-1', type: 4, name: categoryName, parent_id: null },
    ])
    discordServer.setGuildRoles(guildId, [
      { id: 'role-admins', name: `admins-wd-${suffix}` },
      { id: 'role-students', name: `students-wd-${suffix}` },
    ])
    closeDatabase(db)

    // 3. WEB-21: the drop zone, its own format description, and a CSV with
    //    one good row and one row whose Email has no "@" — ROST-9's own
    //    "reported with its line rather than skipped in silence."
    await expect(page.getByText('Roster file format')).toBeVisible()
    await expect(
      page.getByText('First,Last,Email,Discord,GitHub')
    ).toBeVisible()

    const csvText = [
      'First,Last,Email,Discord,GitHub',
      `Ada,Lovelace,ada-${suffix}@example.edu,adalovelace-${suffix},`,
      `Alan,Turing,alan-${suffix}-example.edu,alanturing-${suffix},`, // no "@" — malformed
    ].join('\n')

    // The label names the drop zone (a real button, so the keyboard reaches
    // it); the picker behind it is the `input[type=file]`, which is what
    // Playwright sets files on (`course-knowledge-files.spec.ts`'s own
    // comment on this exact device). Scoped to this component's own
    // container (`data-testid="roster-import"`) since `CourseAttachments`'s
    // own drop zone renders a second, identically-shaped `input[type=file]`
    // on the very same course screen.
    await page
      .getByTestId('roster-import')
      .locator('input[type="file"]')
      .setInputFiles({
        name: 'roster.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(csvText),
      })
    await page.getByRole('button', { name: 'Import roster' }).click()
    await expect(page.getByText('Queued…')).toBeVisible()

    // 4. This is where the browser's own part pauses — no live worker
    //    claims the job in this harness; this spec claims and runs it
    //    itself, once, the same handler and runner `apps/worker` itself
    //    uses.
    const workerDb = openDatabase(E2E_DATABASE_PATH)
    try {
      const firstRun = await claimAndRunRosterImportJob(workerDb, discordServer)
      expect(firstRun.outcome).toBe('succeeded')

      // 5. Back in the browser: the panel's own poll picks up the finished
      //    report, naming the malformed row by its own CSV line number.
      const report = page.getByTestId('roster-import-report')
      await expect(report).toBeVisible({ timeout: 10_000 })
      await expect(report).toContainText('Line 3:')
      await expect(report).toContainText('1 added')

      // Read back directly: exactly the one resolvable row was enrolled.
      const enrolledAfterFirstImport = enrolments.listPeopleForCourse(
        organizationId,
        course.id,
        workerDb
      )
      expect(enrolledAfterFirstImport).toHaveLength(1)

      // 6. Re-import the identical file — ROST-9..12's own "a re-import
      //    admits nobody twice," asserted against the enrolment rows
      //    themselves, not the report's own wording.
      await page
        .getByTestId('roster-import')
        .locator('input[type="file"]')
        .setInputFiles({
          name: 'roster.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(csvText),
        })
      await page.getByRole('button', { name: 'Import roster' }).click()
      await expect(page.getByText('Queued…')).toBeVisible()

      const secondRun = await claimAndRunRosterImportJob(
        workerDb,
        discordServer
      )
      expect(secondRun.outcome).toBe('succeeded')
      await expect(page.getByTestId('roster-import-report')).toContainText(
        '1 merged'
      )

      const enrolledAfterSecondImport = enrolments.listPeopleForCourse(
        organizationId,
        course.id,
        workerDb
      )
      expect(enrolledAfterSecondImport).toHaveLength(
        enrolledAfterFirstImport.length
      )
      expect(enrolledAfterSecondImport.map((p) => p.id).sort()).toEqual(
        enrolledAfterFirstImport.map((p) => p.id).sort()
      )
    } finally {
      closeDatabase(workerDb)
    }
  } finally {
    await discordServer.stop()
  }
})
