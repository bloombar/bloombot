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
  conversations,
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
  await page.getByLabel('Admins role').fill(`admins-wd-${suffix}`)
  await page.getByLabel('Students role').fill(`students-wd-${suffix}`)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible()

  // 2. WEB-22: before anyone is enrolled, the People panel shows both
  //    empty states. WEB-35: People is its own tab.
  await page.getByRole('tab', { name: 'People' }).click()
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible()
  await expect(page.getByText('Nobody is enrolled yet.')).toBeVisible()
  await expect(page.getByText("Nobody's enrolment has ended.")).toBeVisible()

  // 3. Admit a real, independent student through a join link — the same
  //    device `join-links-panel.spec.ts` uses to get a genuine second
  //    enrolment onto this course without reaching into the database.
  //    WEB-35: join links are on the General tab.
  await page.getByRole('tab', { name: 'General' }).click()
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
  // WEB-35: reload holds the General tab last navigated to (step 3) — back
  // to People to see the enrolment.
  await page.getByRole('tab', { name: 'People' }).click()
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

/**
 * WEB-36, end to end: a person's own name in the People panel is a real
 * link straight to their transcript for this course, already read — for
 * both an enrolled person and one whose enrolment has since ended (ending
 * never deletes the transcript, ENRL-6).
 *
 * **What is real, and what is a harness stand-in** (this file's own module
 * comment above holds the same discipline):
 *
 *  - Real: the browser (`components/CoursePeople.tsx`, `pages/Transcripts.tsx`),
 *    a real `apps/api`, a real throwaway SQLite database, and the whole
 *    round trip a click on the link takes: an in-app navigation to
 *    `/o/:organizationId/transcripts/:courseId/:personId`, resolving the
 *    course's own project (`courses.get`), and `transcripts.read` itself.
 *  - Not real: both students' own enrolments and messages — seeded directly
 *    through `@bloombot/db` (`enrolments.enrolViaRoster`/`.endEnrolment`,
 *    `conversations.getOrCreateConversation`/`appendMessage`), the same
 *    device `transcript-access-log.spec.ts`'s own module comment already
 *    uses: nothing here needs a live join-link redemption or a real chat
 *    round trip to prove the link itself lands correctly.
 */
test('clicking a person’s name in the People panel opens their transcript, already read (WEB-36)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const ownerEmail = `owner-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Web Design — ${suffix}`
  const activeStudentName = `Alice ${suffix}`
  const endedStudentName = `Bob ${suffix}`

  // 1. Sign in and define an enabled course.
  await page.goto('/')
  await page.getByLabel('Email').fill(ownerEmail)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(ownerEmail)
  const ownerToken = await readSignInToken(ownerEmail)
  await page.goto(`/sign-in/${ownerToken}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await navigateTo(page, 'Projects')
  await page.getByRole('button', { name: 'New project' }).click()
  const newProjectDialog = page.getByRole('dialog', { name: 'New project' })
  await newProjectDialog.getByLabel('Project name').fill(projectName)
  await newProjectDialog.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: projectName, exact: true }).click()

  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(courseTitle)
  await page.getByLabel('Admins role').fill(`admins-wd-${suffix}`)
  await page.getByLabel('Students role').fill(`students-wd-${suffix}`)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible()

  // 2. Seed two real enrolments, each with one real message: an active one
  //    and one whose enrolment has since ended — this file's own module
  //    comment on why seeded directly rather than through a live join link.
  let organizationId: string
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const ownerAccount = accounts.getAccountByEmail(ownerEmail, db)
    if (!ownerAccount) throw new Error('setup failed: owner account not found')
    const [ownerMembership] = memberships.listMembershipsForAccount(
      ownerAccount.id,
      db
    )
    if (!ownerMembership) throw new Error('setup failed: membership not found')
    organizationId = ownerMembership.organizationId

    const project = projects
      .listProjects(organizationId, db)
      .find((candidate) => candidate.name === projectName)
    if (!project) throw new Error('setup failed: project not found')
    const course = courses
      .listCourses(organizationId, db, { projectId: project.id })
      .find((candidate) => candidate.title === courseTitle)
    if (!course) throw new Error('setup failed: course not found')

    const seedStudent = (displayName: string, content: string) => {
      const person = people.createPerson(
        organizationId,
        { displayName, email: `${displayName.toLowerCase()}@example.edu` },
        db
      )
      const conversation = conversations.getOrCreateConversation(
        organizationId,
        { courseId: course.id, personId: person.id, surface: 'web' },
        db
      )
      if (!conversation) throw new Error('setup failed: conversation')
      conversations.appendMessage(
        organizationId,
        conversation.id,
        { direction: 'from_person', content },
        db
      )
      const enrolment = enrolments.enrolViaRoster(
        organizationId,
        { courseId: course.id, personId: person.id },
        db
      )
      if (!enrolment) throw new Error('setup failed: enrolment')
      return enrolment
    }

    seedStudent(activeStudentName, 'When is the deadline?')
    const endedEnrolment = seedStudent(
      endedStudentName,
      'Can I still submit late work?'
    )
    enrolments.endEnrolment(organizationId, endedEnrolment.id, db)
  } finally {
    closeDatabase(db)
  }

  // 3. WEB-35: People is its own tab.
  await page.getByRole('tab', { name: 'People' }).click()
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible()
  await expect(page.getByText('Enrolled (1)')).toBeVisible()
  await expect(page.getByText('Enrolment ended (1)')).toBeVisible()

  // 4. The active student's own name is a real link — clicking it lands on
  //    their transcript, with the course, the person and the message
  //    already showing, no picker left empty.
  const activeLink = page.getByRole('link', { name: activeStudentName })
  await expect(activeLink).toHaveAttribute('href', /\/transcripts\/.+\/.+$/)
  await activeLink.click()
  await expect(page.getByRole('heading', { name: 'Transcripts' })).toBeVisible()
  // `exact: true` — `ModalProvider` keeps the "New project" dialog this
  // spec used above mounted (closed, not removed —
  // `transcript-access-log.spec.ts`'s own module comment on this exact
  // collision), and its own "Project name" field label otherwise collides,
  // as a case-insensitive substring, with this screen's own "Project"
  // label.
  await expect(page.getByLabel('Project', { exact: true })).toHaveValue(/.+/)
  await expect(page.getByLabel('Course')).toHaveValue(/.+/)
  await expect(page.getByLabel('Student')).toHaveValue(/.+/)
  await expect(page.getByText('When is the deadline?')).toBeVisible()

  // 5. Back returns to the People tab (a push, not a replace) — and the
  // ended student's own name links identically (ENRL-6: ending never
  // deletes the transcript).
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible()
  const endedLink = page.getByRole('link', { name: endedStudentName })
  await expect(endedLink).toHaveAttribute('href', /\/transcripts\/.+\/.+$/)
  await endedLink.click()
  await expect(page.getByRole('heading', { name: 'Transcripts' })).toBeVisible()
  await expect(page.getByLabel('Student')).toHaveValue(/.+/)
  await expect(page.getByText('Can I still submit late work?')).toBeVisible()
})
