/**
 * WEB-20, end to end: an organization owner issues a join link from the
 * panel, copies it, a real visitor redeems it, and revoking it stops
 * admitting new visitors without un-enrolling the one who already joined.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `course-configuration.spec.ts`/`join-link.spec.ts` both hold themselves
 * to):
 *
 *  - Real: the browser (`pages/CourseEditor.tsx`, `components/JoinLinks.tsx`,
 *    `pages/JoinLink.tsx`), a real `apps/api` (`routes/join-links.ts`,
 *    `routes/actions.ts`, unmodified), a real throwaway SQLite database, and
 *    the whole round trip: `courseJoinLinks.create`/`.list`/`.revoke`
 *    dispatched exactly the way any other caller reaches them, and the
 *    created link actually redeemed through the unmodified `/join/:secret`
 *    flow `join-link.spec.ts` already covers for ENRL-8 — this spec does
 *    not re-prove that flow's own internals, only that the URL the panel
 *    hands an instructor is a genuine, working one.
 *  - Not real: the model (unreached — nothing here asks the course a
 *    question).
 *
 * So this test proves: a link issued and copied entirely through the panel
 * admits a real, independent visitor who follows it, and revoking that same
 * link — behind a confirmation naming both halves of ENRL-4 — stops it
 * admitting anyone new while leaving the visitor who already joined
 * enrolled, all without ever looking at `course_join_links.secret_hash`
 * directly.
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

import { E2E_DATABASE_PATH, E2E_PUBLIC_APP_URL } from './support/env.js'
import { readSignInToken } from './support/read-sign-in-token.js'

test('an owner issues and copies a join link; a real visitor redeems it; revoking stops new admission without un-enrolling them (WEB-20, ENRL-4)', async ({
  page,
  browser,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const ownerEmail = `owner-${suffix}@example.edu`
  const studentEmail = `student-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Web Design — ${suffix}`

  // Playwright's own clipboard API needs the origin's permission granted
  // explicitly — jsdom's unit tests stub `navigator.clipboard` outright
  // (`join-links.test.tsx`), but a real Chromium refuses `writeText`
  // without this.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: E2E_PUBLIC_APP_URL,
  })

  // 1. Sign in and define a course — the same panel-only path
  //    `course-configuration.spec.ts` already proves for CFG-2..4.
  await page.goto('/')
  await page.getByLabel('Email').fill(ownerEmail)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(ownerEmail)
  const ownerToken = await readSignInToken(ownerEmail)
  await page.goto(`/sign-in/${ownerToken}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await page.getByRole('button', { name: 'Projects' }).click()
  await page.getByLabel('New project name').fill(projectName)
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('button', { name: projectName }).click()

  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(courseTitle)
  await page.getByLabel('File prefix').fill(`wd-${suffix}`)
  await page.getByLabel('Admins role').fill(`admins-wd-${suffix}`)
  await page.getByLabel('Students role').fill(`students-wd-${suffix}`)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible()

  // 2. WEB-20: issue a join link and copy it — the secret is shown exactly
  //    once, right here.
  await expect(page.getByRole('heading', { name: 'Join links' })).toBeVisible()
  await expect(page.getByText('No join links issued yet.')).toBeVisible()
  await page.getByRole('button', { name: 'Create join link' }).click()

  const urlNode = page.getByTestId('created-join-link-url')
  await expect(urlNode).toBeVisible()
  const joinUrl = (await urlNode.textContent())?.trim()
  if (!joinUrl) throw new Error('the panel never rendered the created URL')
  expect(joinUrl).toContain('/join/')

  await page.getByRole('button', { name: 'Copy link' }).click()
  await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible()
  // `navigator.clipboard` — Node's own minimal `Navigator` type (this
  // repo's `tsconfig.base.json` carries no `dom` lib, only `ES2023`,
  // matching every other package in this workspace) does not declare the
  // Clipboard API, even though the callback below runs in the real browser
  // this page controls, not in this test process — a narrow, deliberate
  // `as` past that gap, not a real `any`.
  const clipboardText = await page.evaluate(() =>
    (
      navigator as unknown as { clipboard: { readText(): Promise<string> } }
    ).clipboard.readText()
  )
  // Proves the control that says "copy" actually reaches the clipboard with
  // exactly the URL displayed, not merely toggling its own label.
  expect(clipboardText).toBe(joinUrl)

  // 3. A real, independent visitor follows the copied URL — a fresh browser
  //    context, since sign-in is cookie-based and this must not reuse the
  //    owner's own session.
  const studentContext = await browser.newContext()
  try {
    const studentPage = await studentContext.newPage()
    await studentPage.goto(joinUrl)
    await expect(
      studentPage.getByRole('heading', { name: 'Sign in to Bloombot' })
    ).toBeVisible()
    await studentPage.getByLabel('Email').fill(studentEmail)
    await studentPage
      .getByRole('button', { name: 'Email me a sign-in link' })
      .click()
    await expect(studentPage.getByTestId('link-requested')).toContainText(
      studentEmail
    )
    const studentToken = await readSignInToken(studentEmail)
    await studentPage.goto(`/sign-in/${studentToken}`)
    await expect(studentPage.getByTestId('organization-switcher')).toBeVisible()
    // Landed in the instructor's own organization, connected (LINK-10), and
    // reaching the enrolled course — the same shape `join-link.spec.ts`
    // already proves for ENRL-8; here it matters only as proof this
    // panel-issued link genuinely admits.
    await expect(
      studentPage.getByTestId('organization-switcher')
    ).toContainText('(connected)')
  } finally {
    await studentContext.close()
  }

  // 4. Back in the owner's own panel: a real reload, then back to this same
  //    course the ordinary way (this app routes most screens through
  //    client-side state, not a URL, so a reload always lands back on
  //    Projects — `App.tsx`'s own module comment on which few paths are
  //    real routes). The list still shows the link, live; the secret itself
  //    is never shown again — this screen has nothing left to show it from
  //    (`repos/course-join-links.ts`'s own module comment).
  await page.reload()
  await page.getByRole('button', { name: projectName }).click()
  await page.getByRole('button', { name: courseTitle }).click()
  await expect(page.getByRole('heading', { name: 'Join links' })).toBeVisible()
  await expect(page.getByText('No expiry')).toBeVisible()
  await expect(page.getByTestId('created-join-link-url')).not.toBeVisible()

  await page.getByRole('button', { name: /^Revoke join link/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Revoke this join link?' })
  await expect(dialog).toContainText('stops the link admitting anyone new')
  await expect(dialog).toContainText('does not un-enrol anybody')
  await dialog.getByRole('button', { name: 'Revoke' }).click()
  await expect(page.getByText(/^Revoked /)).toBeVisible()

  // 5. ENRL-4, read back directly: the student who already joined stays
  //    enrolled — revoking never un-admits anyone it already admitted.
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    // The owner's own organization is where this course and its join link
    // both live — resolved off the owner's own membership, the same way
    // `course-configuration.spec.ts`/`course-knowledge-files.spec.ts` both
    // resolve one.
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

    // The student's own account connected a person in the owner's
    // organization (LINK-10) rather than joining as a member — resolved
    // through that connected `web` identity, the same as `join-link.spec.ts`
    // itself reads it back.
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
    ).toBeDefined()
  } finally {
    closeDatabase(db)
  }

  // 6. The revoked link now refuses a second visitor identically to a
  //    never-issued one (ENRL-4's own "no oracle" shape,
  //    `join-link.spec.ts`'s own second test already proves the wording).
  const secondVisitorContext = await browser.newContext()
  try {
    const secondVisitorPage = await secondVisitorContext.newPage()
    await secondVisitorPage.goto(joinUrl)
    await secondVisitorPage
      .getByLabel('Email')
      .fill(`too-late-${suffix}@example.edu`)
    await secondVisitorPage
      .getByRole('button', { name: 'Email me a sign-in link' })
      .click()
    await expect(secondVisitorPage.getByTestId('link-requested')).toBeVisible()
    const tooLateToken = await readSignInToken(`too-late-${suffix}@example.edu`)
    await secondVisitorPage.goto(`/sign-in/${tooLateToken}`)
    await expect(secondVisitorPage.getByRole('alert')).toContainText(
      'That join link is no longer valid. Ask for a new one.'
    )
  } finally {
    await secondVisitorContext.close()
  }
})
