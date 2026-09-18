/**
 * WEB-53, end to end: a platform administrator approves a pending course
 * from the console's own Courses screen, and the course actually starts
 * answering — through the real `apps/api` chat route and
 * `@bloombot/core#answerQuestion` pipeline, the same "real API, real
 * database, fake model, fake network" shape `chat.spec.ts`'s own module
 * comment describes. Then unapproves it, and the SURF-10 notice
 * `chat.spec.ts`'s own COST-8/SURF-10 test already proves for a course
 * nobody has ever approved comes back for a course that *was* approved and
 * had it taken away — COST-8's "not re-approved automatically" (§41), read
 * on the browser's own two ends.
 *
 * **What is real, and what is a harness stand-in — the same discipline
 * `admin-console.spec.ts`'s own module comment holds itself to:**
 *
 *  - Real: two browsers (`pages/CourseEditor.tsx`/`pages/Chat.tsx` for the
 *    course owner, `pages/Admin.tsx` for the administrator), a real
 *    `apps/api`, a real throwaway SQLite database, and every route this
 *    spec drives — `routes/admin.ts`'s own `GET /courses`/`approve`/
 *    `unapprove`, `routes/chat.ts` — reached exactly the way any other
 *    caller reaches them.
 *  - **Not real**: the model (`e2e/support/fake-model-client.ts`, the same
 *    stand-in `chat.spec.ts` uses), and this account's own enrolment,
 *    seeded directly the same way `chat.spec.ts`'s own module comment
 *    explains for the identical reason.
 *  - The platform-administrator account signs in through the ordinary
 *    emailed-link flow, at `E2E_ADMIN_EMAIL` — the same address
 *    `admin-console.spec.ts` already uses, on `ADMIN_EMAILS` for this
 *    spec's own `apps/api` process.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  courses,
  enrolments,
  memberships,
  openDatabase,
  people,
  projects,
} from '@bloombot/db'

import { E2E_ADMIN_EMAIL, E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { signIn } from './support/sign-in.js'

test('a platform administrator approves a pending course, it answers, then unapproving brings the SURF-10 notice back (WEB-53, COST-8, ADMIN-13)', async ({
  page,
  browser,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web53-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Approval Queue — ${suffix}`
  const question = 'When is the midterm, and what should I read first?'

  // 1. The course owner signs in and defines a course through the panel
  //    alone, exactly the path `chat.spec.ts`'s own two tests already
  //    establish — left pending, the same default COST-8 gives every
  //    non-administrator-owned course.
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
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()
  // COST-8/SURF-10 — the owner's own pending state, right where they would
  // actually see it.
  await expect(page.getByText('Pending approval')).toBeVisible()

  await page.getByRole('tab', { name: 'AI' }).click()
  await page
    .getByLabel('Instructions')
    .fill('Answer student questions about the course clearly.')
  await page.getByRole('button', { name: 'Save instructions' }).click()
  await page.getByRole('button', { name: /Show history/ }).click()
  await expect(page.getByText('Current')).toBeVisible()

  // 2. Seed this account's own enrolment — the harness stand-in
  //    `chat.spec.ts`'s own module comment explains — and read the course
  //    id WEB-53's console needs to address this exact row.
  const db = openDatabase(E2E_DATABASE_PATH)
  let courseId: string
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
    // Never approved yet — the fact this whole spec is about.
    expect(course.aiApprovedAt).toBeNull()
    courseId = course.id

    const person = people.resolveIdentity(
      organizationId,
      { surface: 'web', externalId: account.id },
      db
    )
    if (!person) throw new Error('setup failed: no connected web person')
    const enrolled = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      db
    )
    if (!enrolled) throw new Error('setup failed: enrolment refused')
  } finally {
    closeDatabase(db)
  }

  // 3. Confirm the pending state from the student's own end, the same way
  //    `chat.spec.ts`'s own COST-8/SURF-10 test does, before an
  //    administrator ever touches it.
  await navigateTo(page, 'Chat')
  await expect(page.getByText(courseTitle)).toBeVisible()
  await page.getByLabel('Ask a question').fill(question)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByRole('status')).toContainText(
    "hasn't been approved to answer questions yet"
  )

  // 4. A platform administrator, in a second, independent browser context
  //    (the same device `course-people-panel.spec.ts` uses for a second
  //    identity), signs in and reaches WEB-53's own Courses screen.
  const adminContext = await browser.newContext()
  try {
    const adminPage = await adminContext.newPage()
    await signIn(adminPage, E2E_ADMIN_EMAIL)
    await expect(adminPage.getByTestId('organization-switcher')).toBeVisible()

    await adminPage.goto('/platform-admin/courses')
    const pendingRow = adminPage.getByTestId(`admin-course-${courseId}`)
    await expect(pendingRow).toBeVisible()
    await expect(pendingRow).toContainText(courseTitle)

    // ADMIN-12/ADMIN-7 — the row's own project name is now a real link into
    // its own console screen (`CoursesView.tsx`'s own module comment on the
    // gap this closes), not merely plain text.
    await pendingRow.getByRole('link', { name: projectName }).click()
    await expect(adminPage.getByText(projectName)).toBeVisible()
    await adminPage.goBack()
    await expect(pendingRow).toBeVisible()

    // `exact: true` — a plain `{ name: 'Approve' }` matches "Unapprove" too
    // (a case-insensitive substring by default, and "Unapprove" contains
    // "approve"), the same trap this file's own `projectName, exact: true`
    // above (`:73`) already guards against for a different pair of names.
    await pendingRow
      .getByRole('button', { name: 'Approve', exact: true })
      .click()
    // ADMIN-13 — Approve confirms too now, naming the course, before
    // anything is sent.
    const approveDialog = adminPage.getByRole('dialog')
    await expect(approveDialog).toContainText(courseTitle)
    await approveDialog
      .getByRole('button', { name: 'Approve', exact: true })
      .click()
    // The row moves out of "Pending approval" once the read refreshes —
    // proven by the Approve button itself being replaced with Unapprove,
    // rather than asserting on which `<ul>` it sits under.
    await expect(
      pendingRow.getByRole('button', { name: 'Unapprove' })
    ).toBeVisible()

    // 5. Back in the student's own tab: the same question now answers —
    //    no reload of `apps/api` needed, since COST-8's gate is checked
    //    live on the next request.
    await page.getByLabel('Ask a question').fill(question)
    await page.getByRole('button', { name: 'Send' }).click()
    const thread = page.getByTestId('chat-thread')
    await expect(
      thread.getByRole('heading', { level: 1, name: 'Bloombot' })
    ).toBeVisible()

    // 6. The administrator unapproves it — the destructive direction,
    //    confirmed through the panel's one modal (`Admin.tsx`'s own module
    //    comment: a plain `confirm()`, no typed name).
    await pendingRow.getByRole('button', { name: 'Unapprove' }).click()
    const dialog = adminPage.getByRole('dialog')
    await expect(dialog).toContainText(courseTitle)
    await dialog.getByRole('button', { name: 'Unapprove' }).click()
    await expect(
      pendingRow.getByRole('button', { name: 'Approve', exact: true })
    ).toBeVisible()
  } finally {
    await adminContext.close()
  }

  // 7. SURF-10's notice is back — COST-8's own "not re-approved
  //    automatically" (§41), proven on the browser's own end this time
  //    rather than only against the repository.
  await page.getByLabel('Ask a question').fill(question)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByRole('status')).toContainText(
    "hasn't been approved to answer questions yet"
  )
})
