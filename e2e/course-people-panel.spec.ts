/**
 * WEB-22/ENRL-9, end to end: an owner admits a real student through a join
 * link (`join-links-panel.spec.ts`'s own admission device, reused rather
 * than duplicated), ends their enrolment from the People panel behind a
 * confirmation naming both halves of ENRL-6, sees them move from
 * "Enrolled" to "Enrolment ended", then reinstates them with no
 * confirmation at all (ENRL-9) — and the row moves back, with who and when
 * recorded on the row itself.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `join-links-panel.spec.ts`'s own module comment holds itself to):
 *
 *  - Real: the browser (`pages/CourseEditor.tsx`, `components/CoursePeople.tsx`),
 *    a real `apps/api` (`routes/actions.ts`, unmodified), a real throwaway
 *    SQLite database, and the whole round trip: `courseJoinLinks.create`,
 *    the join redemption itself, `enrolments.end` and `enrolments.reinstate`
 *    all dispatched exactly the way any other caller reaches them.
 *  - Not real: the model (unreached — nothing here asks the course a
 *    question; `routes/chat.ts`'s own access change from ending and
 *    reinstating is proven directly, over HTTP, in
 *    `apps/api/tests/routes/enrolments-reinstate.test.ts`, not repeated
 *    here).
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

import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { readSignInToken } from './support/read-sign-in-token.js'

test('ending, then reinstating, an enrolment from the People panel (WEB-22, ENRL-9)', async ({
  page,
  browser,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const ownerEmail = `owner-${suffix}@example.edu`
  const studentEmail = `student-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Web Design — ${suffix}`

  // 1. Sign in and define a course — the same panel-only path
  //    `join-links-panel.spec.ts` already establishes.
  await page.goto('/')
  await page.getByLabel('Email').fill(ownerEmail)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(ownerEmail)
  const ownerToken = await readSignInToken(ownerEmail)
  await page.goto(`/sign-in/${ownerToken}`)
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
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible()

  // 2. WEB-22: before anyone is enrolled, the People panel shows both
  //    empty states.
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible()
  await expect(page.getByText('Nobody is enrolled yet.')).toBeVisible()
  await expect(page.getByText("Nobody's enrolment has ended.")).toBeVisible()

  // 3. Admit a real, independent student through a join link — the same
  //    device `join-links-panel.spec.ts` uses to get a genuine second
  //    enrolment onto this course without reaching into the database.
  await page.getByRole('button', { name: 'Create join link' }).click()
  const urlNode = page.getByTestId('created-join-link-url')
  await expect(urlNode).toBeVisible()
  const joinUrl = (await urlNode.textContent())?.trim()
  if (!joinUrl) throw new Error('the panel never rendered the created URL')

  const studentContext = await browser.newContext()
  try {
    const studentPage = await studentContext.newPage()
    await studentPage.goto(joinUrl)
    await studentPage.getByLabel('Email').fill(studentEmail)
    await studentPage
      .getByRole('button', { name: 'Email me a sign-in link' })
      .click()
    await expect(studentPage.getByTestId('link-requested')).toContainText(
      studentEmail
    )
    const studentToken = await readSignInToken(studentEmail)
    await studentPage.goto(`/sign-in/${studentToken}`)
    await expect(
      studentPage.getByTestId('organization-switcher')
    ).toContainText('(connected)')
  } finally {
    await studentContext.close()
  }

  // 4. Back in the owner's own panel: reload — WEB-32/WEB-34's own
  //    "a reload holds the panel's place," so this reload lands directly
  //    back on this exact course's own address, no re-navigation through
  //    Projects needed — and the People panel now lists the student as
  //    enrolled — admitted through the join link, and offering only End
  //    (this student joined with no display name set anywhere, so the row
  //    falls back to their own person id — WEB-22's own "never an email"
  //    fallback, `components/CoursePeople.tsx`'s own module comment).
  await page.reload()
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible()
  await expect(page.getByText('Enrolled (1)')).toBeVisible()
  const endButton = page.getByRole('button', { name: /^End /, exact: false })
  await expect(endButton).toBeVisible()

  // 5. End the enrolment — behind a confirmation stating both halves of
  //    ENRL-6.
  await endButton.click()
  const endDialog = page.getByRole('dialog', { name: /^End .*enrolment\?$/ })
  await expect(endDialog).toContainText('This stops them asking this course')
  await expect(endDialog).toContainText('does not delete their transcript')
  await endDialog.getByRole('button', { name: 'End enrolment' }).click()

  // The row moves — "Enrolled" empties, "Enrolment ended" gains one, and
  // only Reinstate is offered on it now.
  await expect(page.getByText('Nobody is enrolled yet.')).toBeVisible()
  await expect(page.getByText('Enrolment ended (1)')).toBeVisible()
  const reinstateButton = page.getByRole('button', {
    name: /^Reinstate /,
    exact: false,
  })
  await expect(reinstateButton).toBeVisible()

  // 6. Read back directly: the enrolment is genuinely ended, not merely
  //    absent from the active list — the same "read back directly" step
  //    `join-links-panel.spec.ts` takes for its own ENRL-4 proof.
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const ownerAccount = accounts.getAccountByEmail(ownerEmail, db)
    if (!ownerAccount) throw new Error('verify failed: owner account not found')
    const [ownerMembership] = memberships.listMembershipsForAccount(
      ownerAccount.id,
      db
    )
    if (!ownerMembership) throw new Error('verify failed: membership not found')
    const organizationId = ownerMembership.organizationId

    const project = projects
      .listProjects(organizationId, db)
      .find((candidate) => candidate.name === projectName)
    if (!project) throw new Error('verify failed: project not found')
    const course = courses
      .listCourses(organizationId, db, { projectId: project.id })
      .find((candidate) => candidate.title === courseTitle)
    if (!course) throw new Error('verify failed: course not found')

    const studentAccount = accounts.getAccountByEmail(studentEmail, db)
    if (!studentAccount) {
      throw new Error('verify failed: student account not found')
    }
    const studentPerson = people.resolveIdentity(
      organizationId,
      { surface: 'web', externalId: studentAccount.id },
      db
    )
    if (!studentPerson) {
      throw new Error('verify failed: no connected web person for the student')
    }

    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        studentPerson.id,
        db
      )
    ).toBeUndefined()
    const listed = enrolments.listPeopleForCourse(organizationId, course.id, db)
    expect(listed).toHaveLength(0)
  } finally {
    closeDatabase(db)
  }

  // 7. Reinstate — no confirmation, since it grants rather than removes
  //    (`components/CoursePeople.tsx`'s own module comment).
  await reinstateButton.click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await expect(page.getByText('Enrolled (1)')).toBeVisible()
  await expect(page.getByText("Nobody's enrolment has ended.")).toBeVisible()
  await expect(
    page.getByRole('button', { name: /^End /, exact: false })
  ).toBeVisible()

  // 8. Read back directly again: active once more, and ENRL-9's own
  //    "recorded: who did it and when" — the owner's own account id, not
  //    nobody's.
  const dbAfter = openDatabase(E2E_DATABASE_PATH)
  try {
    const ownerAccount = accounts.getAccountByEmail(ownerEmail, dbAfter)
    if (!ownerAccount) throw new Error('verify failed: owner account not found')
    const [ownerMembership] = memberships.listMembershipsForAccount(
      ownerAccount.id,
      dbAfter
    )
    if (!ownerMembership) throw new Error('verify failed: membership not found')
    const organizationId = ownerMembership.organizationId

    const project = projects
      .listProjects(organizationId, dbAfter)
      .find((candidate) => candidate.name === projectName)
    if (!project) throw new Error('verify failed: project not found')
    const course = courses
      .listCourses(organizationId, dbAfter, { projectId: project.id })
      .find((candidate) => candidate.title === courseTitle)
    if (!course) throw new Error('verify failed: course not found')

    const studentAccount = accounts.getAccountByEmail(studentEmail, dbAfter)
    if (!studentAccount) {
      throw new Error('verify failed: student account not found')
    }
    const studentPerson = people.resolveIdentity(
      organizationId,
      { surface: 'web', externalId: studentAccount.id },
      dbAfter
    )
    if (!studentPerson) {
      throw new Error('verify failed: no connected web person for the student')
    }

    const active = enrolments.getActiveEnrolment(
      organizationId,
      course.id,
      studentPerson.id,
      dbAfter
    )
    expect(active).toBeDefined()
    expect(active).toMatchObject({
      reinstatedByAccountId: ownerAccount.id,
      reinstatedAt: expect.any(Number),
    })
  } finally {
    closeDatabase(dbAfter)
  }
})
