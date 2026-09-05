/**
 * ADMIN-1/ADMIN-2 and ADMIN-5, end to end: an instructor reads their
 * course's transcript in the panel, and a platform administrator deletes a
 * tenant's data through the confirmed, typed-name prompt. WEB-33's own
 * addresses for the console's screens are covered by the last test in this
 * file — a cold load of an organization's own deep link, panel navigation
 * moving the address bar, and the browser's own Back button returning to
 * the previous console screen, the identical three claims
 * `e2e/routing.spec.ts` already proves for the rest of the panel.
 *
 * **What is real, and what is a harness stand-in — the same caveat
 * `course-configuration.spec.ts`'s own module comment gives, read before
 * trusting what this spec proves:**
 *
 *  - Real: the browser (`pages/Transcripts.tsx`, `pages/Admin.tsx`), a
 *    real `apps/api` (`e2e/support/start-api.ts`), a real throwaway SQLite
 *    database, and every action/route this UI drives —
 *    `transcripts.read`, `routes/admin.ts`'s own deletion route — reached
 *    exactly the way any other caller reaches them.
 *  - **Not real, and this is the harness's own stand-in**: the course, the
 *    conversation and the message this spec reads back are inserted
 *    directly through `@bloombot/db`'s own repos, the same "the panel's
 *    own creation flow is proven elsewhere" reasoning
 *    `course-configuration.spec.ts` already gives for its own Discord
 *    binding — this spec's own job is proving the *read* and the
 *    *deletion*, not re-proving course creation.
 *  - The platform-administrator account signs in through the ordinary
 *    emailed-link flow, at an address `playwright.config.ts` put on
 *    `ADMIN_EMAILS` for the API process this spec's `webServer` starts —
 *    AUTH-4's own "read on every check", exercised for real, not stubbed.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  conversations,
  courses,
  memberships,
  openDatabase,
  organizations,
  people,
  projects,
  transcriptAccess,
} from '@bloombot/db'

import { E2E_ADMIN_EMAIL, E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { readSignInToken } from './support/read-sign-in-token.js'

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(email)
  const token = await readSignInToken(email)
  await page.goto(`/sign-in/${token}`)
}

/**
 * This spec's own seeding writes directly to `E2E_DATABASE_PATH`
 * (this file's own module comment) through a *second* connection to the
 * same file `apps/api`'s own process already holds open — the same thing
 * `course-configuration.spec.ts` already does. SQLite's own "database is
 * locked" (`SQLITE_LOCKED`) is a different condition from "database is
 * busy" (`SQLITE_BUSY`) — `client.ts`'s own `busy_timeout` pragma governs
 * only the latter, so a genuine, if rare, lock contention between this
 * process's own writes and the live API process's (four Playwright workers
 * and one shared API process, all against one file) is not something that
 * pragma alone absorbs. Each call below is its own atomic write (a single
 * repo function, its own transaction) — safe to retry outright on this
 * specific condition, since a failed attempt commits nothing.
 */
async function withRetry<T>(fn: () => T): Promise<T> {
  const attempts = 5
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return fn()
    } catch (error) {
      const locked =
        error instanceof Error && /database is locked/i.test(error.message)
      if (!locked || attempt === attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
    }
  }
  throw new Error('unreachable')
}

test('an instructor reads their course’s transcript in the panel, and it is written to the audit trail (ADMIN-1, ADMIN-2)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `admin1-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Office Hours — ${suffix}`

  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // Seed the course, the student and the message directly (this file's own
  // module comment has why) — into the instructor's own personal
  // organization, created for them by the sign-in this spec just drove.
  const db = openDatabase(E2E_DATABASE_PATH)
  let organizationId: string
  let courseId: string
  try {
    const account = accounts.getAccountByEmail(email, db)
    if (!account) throw new Error('setup failed: account not found')
    const [membership] = memberships.listMembershipsForAccount(account.id, db)
    if (!membership) throw new Error('setup failed: membership not found')
    organizationId = membership.organizationId

    const project = await withRetry(() =>
      projects.createProject(organizationId, { name: projectName }, db)
    )
    const courseResult = await withRetry(() =>
      courses.createCourse(
        organizationId,
        {
          projectId: project.id,
          title: courseTitle,
          filePrefix: `oh-${suffix}`,
          enabled: true,
          adminsRole: `admins-${suffix}`,
          studentsRole: `students-${suffix}`,
          categories: [],
        },
        db
      )
    )
    if (!courseResult.ok) throw new Error('setup failed: course not saved')
    courseId = courseResult.course.id

    const student = await withRetry(() =>
      people.createPerson(
        organizationId,
        { displayName: `QA Student ${suffix}` },
        db
      )
    )
    const conversation = await withRetry(() =>
      conversations.getOrCreateConversation(
        organizationId,
        { courseId, personId: student.id, surface: 'web' },
        db
      )
    )
    if (!conversation) throw new Error('setup failed: conversation not created')
    await withRetry(() =>
      conversations.appendMessage(
        organizationId,
        conversation.id,
        {
          direction: 'from_person',
          content: 'Are office hours cancelled this week?',
        },
        db
      )
    )
    await withRetry(() =>
      conversations.appendMessage(
        organizationId,
        conversation.id,
        {
          direction: 'to_person',
          content: 'No, they run as usual on Thursday.',
        },
        db
      )
    )

    // Before this spec's own read: no audit entry exists yet.
    expect(
      transcriptAccess.listAccessLogForCourse(organizationId, courseId, db)
    ).toHaveLength(0)
  } finally {
    closeDatabase(db)
  }

  // The instructor's own read, through the panel.
  await navigateTo(page, 'Transcripts')
  await page.getByLabel('Project').selectOption({ label: projectName })
  await page.getByLabel('Course').selectOption({ label: courseTitle })

  await expect(
    page.getByText('Are office hours cancelled this week?')
  ).toBeVisible()
  await expect(
    page.getByText('No, they run as usual on Thursday.')
  ).toBeVisible()

  // ADMIN-2 — the read that just happened in the browser wrote the audit
  // trail: who, which course, and when. Read back from the same database
  // `apps/api` wrote to, not asserted from the UI alone.
  const verifyDb = openDatabase(E2E_DATABASE_PATH)
  try {
    const account = accounts.getAccountByEmail(email, verifyDb)
    if (!account) throw new Error('setup failed: account not found')
    const log = transcriptAccess.listAccessLogForCourse(
      organizationId,
      courseId,
      verifyDb
    )
    expect(log.length).toBeGreaterThanOrEqual(1)
    expect(log[0]).toMatchObject({
      organizationId,
      courseId,
      actorAccountId: account.id,
      kind: 'read',
    })
  } finally {
    closeDatabase(verifyDb)
  }
})

test('a platform administrator deletes a tenant’s data, confirmed by typing its name (ADMIN-5)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const tenantName = `A Real Tenant — ${suffix}`

  // Seed a tenant with something real inside it, entirely outside the
  // browser — the administrator about to delete it holds no membership in
  // it at all (ADMIN-4's own "not a master key"), so there is no panel
  // flow that would create it as this account.
  const seedDb = openDatabase(E2E_DATABASE_PATH)
  let organizationId: string
  try {
    organizationId = randomUUID()
    await withRetry(() =>
      organizations.createOrganization(
        organizationId,
        { name: tenantName, isPersonal: false },
        seedDb
      )
    )
    const project = await withRetry(() =>
      projects.createProject(organizationId, { name: 'Fall 2026' }, seedDb)
    )
    const courseResult = await withRetry(() =>
      courses.createCourse(
        organizationId,
        {
          projectId: project.id,
          title: 'A Course',
          filePrefix: `ac-${suffix}`,
          enabled: true,
          adminsRole: `admins-${suffix}`,
          studentsRole: `students-${suffix}`,
          categories: [],
        },
        seedDb
      )
    )
    if (!courseResult.ok) throw new Error('setup failed: course not saved')
  } finally {
    closeDatabase(seedDb)
  }

  await signIn(page, E2E_ADMIN_EMAIL)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await page.goto('/platform-admin')
  await expect(
    page.getByRole('heading', { name: 'Platform administration' })
  ).toBeVisible()
  const row = page.getByTestId(`admin-org-${organizationId}`)
  await expect(row).toBeVisible()

  await row.getByRole('button', { name: 'Delete' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('1 course(s)')

  // Typing the wrong name refuses — the confirmation is real, not a plain
  // "are you sure" a stray click could pass (WEB-15).
  await dialog.getByLabel('Organization name').fill('the wrong name')
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect(
    dialog.getByText('Type the name exactly to confirm.')
  ).toBeVisible()

  // The organization's own name, typed exactly, proceeds.
  await dialog.getByLabel('Organization name').fill(tenantName)
  await dialog.getByRole('button', { name: 'Delete' }).click()

  await expect(row).not.toBeAttached()

  // ADMIN-5 — confirmed and audited, read back from the database: the
  // tenant is actually gone, and who deleted it is recorded.
  const verifyDb = openDatabase(E2E_DATABASE_PATH)
  try {
    expect(
      organizations.getOrganizationById(organizationId, verifyDb)
    ).toBeUndefined()
    const admin = accounts.getAccountByEmail(E2E_ADMIN_EMAIL, verifyDb)
    if (!admin) throw new Error('setup failed: admin account not found')
    const deletions = organizations.listTenantDeletions(verifyDb)
    const thisDeletion = deletions.find(
      (entry) => entry.organizationId === organizationId
    )
    expect(thisDeletion).toMatchObject({
      organizationName: tenantName,
      deletedByAccountId: admin.id,
    })
  } finally {
    closeDatabase(verifyDb)
  }
})

test('the admin console’s own screens are addressable — a cold deep link, panel navigation and browser back all agree (WEB-33, WEB-34)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const tenantName = `A Linkable Tenant — ${suffix}`

  const seedDb = openDatabase(E2E_DATABASE_PATH)
  let organizationId: string
  try {
    organizationId = randomUUID()
    await withRetry(() =>
      organizations.createOrganization(
        organizationId,
        { name: tenantName, isPersonal: false },
        seedDb
      )
    )
  } finally {
    closeDatabase(seedDb)
  }

  await signIn(page, E2E_ADMIN_EMAIL)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // 1. A cold load of the console's own entry point resolves to the
  //    organizations list — `'platform-admin'` itself is never rendered
  //    past its own effect, mirroring `App.tsx`'s own `'/'` resolution.
  await page.goto('/platform-admin')
  await expect(page).toHaveURL('/platform-admin/organizations')
  const row = page.getByTestId(`admin-org-${organizationId}`)
  await expect(row).toBeVisible()

  // 2. Navigating in the console — clicking the organization's own name —
  //    moves the address bar to its own, shareable address.
  await row.getByRole('button', { name: tenantName }).click()
  await expect(page).toHaveURL(
    `/platform-admin/organizations/${organizationId}`
  )
  await expect(
    page.getByTestId(`admin-org-detail-${organizationId}`)
  ).toBeVisible()

  // 3. The browser's own Back button returns to the organizations list —
  //    the previous console screen, not a dead end or the sign-in screen.
  await page.goBack()
  await expect(page).toHaveURL('/platform-admin/organizations')
  await expect(row).toBeVisible()

  // 4. A cold load of the detail address directly, in a fresh navigation
  //    with no prior in-console navigation at all, renders the same
  //    organization directly — proving the address is really shareable,
  //    not merely a same-session artifact of the click in step 2.
  await page.goto(`/platform-admin/organizations/${organizationId}`)
  await expect(
    page.getByTestId(`admin-org-detail-${organizationId}`)
  ).toBeVisible()

  // An address naming an organization nothing in this read matches gets
  // the panel's own not-found screen, not an empty console.
  await page.goto(
    '/platform-admin/organizations/00000000-0000-0000-0000-000000000000'
  )
  await expect(page.getByTestId('not-found-page')).toBeVisible()
})
