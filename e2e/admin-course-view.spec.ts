/**
 * ADMIN-6, end to end: a platform administrator opens a pending course from
 * the Courses screen's own list, reads its settings — general, AI and
 * knowledge — read-only, and approves it from that same screen, after which
 * the course actually starts answering. Sibling to
 * `admin-course-approval.spec.ts` (WEB-53's own approve/unapprove flow from
 * the list itself) rather than an extension of it — this spec's own point is
 * the *detail* screen `routes/admin.ts#GET /courses/:courseId` and
 * `pages/Admin.tsx`'s own `CourseDetailView` add, not the list's buttons,
 * which that file already covers.
 *
 * **What is real, and what is a harness stand-in — the same discipline
 * `admin-course-approval.spec.ts`'s own module comment holds itself to:**
 *
 *  - Real: two browsers (`pages/CourseEditor.tsx`/`pages/Chat.tsx` for the
 *    course owner, `pages/Admin.tsx` for the administrator), a real
 *    `apps/api`, a real throwaway SQLite database, and every route this
 *    spec drives — `routes/admin.ts`'s own `GET /courses`, `GET
 *    /courses/:courseId` and `approve`, `routes/chat.ts` — reached exactly
 *    the way any other caller reaches them.
 *  - **Not real**: the model (`e2e/support/fake-model-client.ts`), and this
 *    account's own enrolment, seeded directly the same way `chat.spec.ts`'s
 *    own module comment explains for the identical reason.
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

test('a platform administrator opens a pending course from the list, reads its settings, and approves it from that screen (ADMIN-6, ADMIN-13)', async ({
  page,
  browser,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `admin6-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Approval Detail — ${suffix}`
  const question = 'When is the midterm, and what should I read first?'
  const instructions = 'Answer student questions about the course clearly.'

  // 1. The course owner signs in and defines a course through the panel
  //    alone — left pending, COST-8's default for a non-administrator-owned
  //    course.
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

  await page.getByRole('tab', { name: 'AI' }).click()
  await page.getByLabel('Instructions').fill(instructions)
  await page.getByRole('button', { name: 'Save instructions' }).click()
  await page.getByRole('button', { name: /Show history/ }).click()
  await expect(page.getByText('Current')).toBeVisible()

  // 2. Seed this account's own enrolment — the harness stand-in
  //    `chat.spec.ts`'s own module comment explains — and read the course
  //    id this spec needs to address the exact row on the admin console.
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

  // 3. Confirm the pending state from the student's own end, before an
  //    administrator ever touches it.
  await navigateTo(page, 'Chat')
  await expect(page.getByText(courseTitle)).toBeVisible()
  await page.getByLabel('Ask a question').fill(question)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByRole('status')).toContainText(
    "hasn't been approved to answer questions yet"
  )

  // 4. A platform administrator, in a second, independent browser context,
  //    signs in, opens the Courses list, and clicks into this exact course.
  const adminContext = await browser.newContext()
  try {
    const adminPage = await adminContext.newPage()
    await signIn(adminPage, E2E_ADMIN_EMAIL)
    await expect(adminPage.getByTestId('organization-switcher')).toBeVisible()

    await adminPage.goto('/platform-admin/courses')
    const pendingRow = adminPage.getByTestId(`admin-course-${courseId}`)
    await expect(pendingRow).toBeVisible()
    // ADMIN-12 — the row's own title is now a real link (`AppLink`), not
    // a button, so an administrator can middle-click, copy it, or open it
    // in a new tab.
    await pendingRow.getByRole('link', { name: courseTitle }).click()

    // ADMIN-6's own address — bookmarkable, and distinct from the list.
    await expect(adminPage).toHaveURL(
      new RegExp(`/platform-admin/courses/${courseId}$`)
    )

    // 5. The settings render, read-only — general, AI and knowledge — and
    //    nothing on this screen is a control a person can type into.
    const detail = adminPage.getByTestId(`admin-course-detail-${courseId}`)
    await expect(detail.getByRole('region', { name: 'General' })).toBeVisible()
    await expect(detail.getByRole('region', { name: 'AI' })).toBeVisible()
    // ROST-20: `exact` — "Roster acknowledgements" (below, on this same
    // screen) contains "acknowledge" contains "knowledge" as a literal
    // substring, so Playwright's default substring role-name match resolves
    // this locator to two regions without it.
    await expect(
      detail.getByRole('region', { name: 'Knowledge', exact: true })
    ).toBeVisible()
    await expect(detail).toContainText(`admins-${suffix}`)
    await expect(detail).toContainText(`students-${suffix}`)
    await expect(detail).toContainText(instructions)
    await expect(detail.getByRole('textbox')).toHaveCount(0)
    await expect(detail.getByRole('combobox')).toHaveCount(0)
    await expect(detail.getByRole('button', { name: /save/i })).toHaveCount(0)

    // 6. Approve from this screen, not the list — ADMIN-13's confirmation,
    //    naming the course, before anything is sent.
    await detail.getByRole('button', { name: 'Approve', exact: true }).click()
    const approveDialog = adminPage.getByRole('dialog')
    await expect(approveDialog).toContainText(courseTitle)
    await approveDialog
      .getByRole('button', { name: 'Approve', exact: true })
      .click()
    await expect(
      detail.getByRole('button', { name: 'Unapprove' })
    ).toBeVisible()

    // 7. Back returns to the list, where the row now shows Unapprove —
    //    proof the decision made from the detail screen actually landed.
    await adminPage.getByRole('button', { name: '← Courses' }).click()
    await expect(adminPage).toHaveURL(/\/platform-admin\/courses$/)
    await expect(
      pendingRow.getByRole('button', { name: 'Unapprove' })
    ).toBeVisible()

    // 8. Back in the student's own tab: the same question now answers — no
    //    reload of `apps/api` needed, since COST-8's gate is checked live
    //    on the next request.
    await page.getByLabel('Ask a question').fill(question)
    await page.getByRole('button', { name: 'Send' }).click()
    const thread = page.getByTestId('chat-thread')
    await expect(
      thread.getByRole('heading', { level: 1, name: 'Bloombot' })
    ).toBeVisible()
  } finally {
    await adminContext.close()
  }
})
