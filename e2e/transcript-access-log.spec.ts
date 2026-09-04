/**
 * ADMIN-2, end to end: an owner reads a course's transcript from the panel,
 * then reads the same course's own access log — who read whose
 * conversation, and when — with a display name on both sides and never an
 * email.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `team-panel.spec.ts`'s own module comment holds itself to):
 *
 *  - Real: the browser (`pages/Transcripts.tsx`), a real `apps/api`
 *    (`routes/actions.ts`, unmodified), a real throwaway SQLite database,
 *    and the whole round trip: `transcripts.read` and
 *    `transcripts.listAccessLog` both dispatched exactly the way any other
 *    caller reaches them — the audit row this test reads back is the same
 *    row `readCourseTranscript` writes for the panel's own read, not one
 *    seeded directly.
 *  - Not real: the student's own message — inserted directly through
 *    `@bloombot/db`'s own `conversations.getOrCreateConversation`/
 *    `appendMessage`, the same device `transcript-access.test.ts`'s own
 *    `seedMessage` helper already uses at the unit layer, since nothing in
 *    this harness needs a live Discord bot or a real chat round trip to
 *    prove ADMIN-2's own read path.
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
  people,
  projects,
} from '@bloombot/db'

import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { readSignInToken } from './support/read-sign-in-token.js'

test('an owner reads a course transcript, then reads its own access log — a display name on both sides, never an email (ADMIN-2)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const ownerEmail = `owner-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Web Design — ${suffix}`
  const studentDisplayName = `Alice ${suffix}`
  const studentEmail = `alice-${suffix}@example.edu`

  // 1. Sign in and define an enabled course — the same panel-only path
  //    every other spec in this suite establishes.
  await page.goto('/')
  await page.getByLabel('Email').fill(ownerEmail)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(ownerEmail)
  const ownerToken = await readSignInToken(ownerEmail)
  await page.goto(`/sign-in/${ownerToken}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await navigateTo(page, 'Projects')
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

  // 2. Seed one real message directly — this file's own module comment on
  //    why a live chat round trip is not needed to prove ADMIN-2's own
  //    read path.
  let organizationId: string
  let ownerDisplayName: string
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const ownerAccount = accounts.getAccountByEmail(ownerEmail, db)
    if (!ownerAccount) throw new Error('setup failed: owner account not found')
    ownerDisplayName = ownerAccount.displayName
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

    const student = people.createPerson(
      organizationId,
      { displayName: studentDisplayName, email: studentEmail },
      db
    )
    const conversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId: course.id, personId: student.id, surface: 'web' },
      db
    )
    if (!conversation) throw new Error('setup failed: conversation')
    conversations.appendMessage(
      organizationId,
      conversation.id,
      { direction: 'from_person', content: 'When is the deadline?' },
      db
    )
  } finally {
    closeDatabase(db)
  }

  // 3. ADMIN-1: read the transcript from the panel, filtered by student —
  //    this is the ADMIN-2 audit event this test then reads back, and the
  //    filter is what makes the row name a student rather than "the whole
  //    course" (the unfiltered read this screen already ran on selecting
  //    the course, before this student filter was ever applied).
  await navigateTo(page, 'Transcripts')
  await page.getByLabel('Project').selectOption({ label: projectName })
  await page.getByLabel('Course').selectOption({ label: courseTitle })
  await expect(page.getByText('When is the deadline?')).toBeVisible()
  await page.getByLabel('Student').selectOption({ label: studentDisplayName })
  await page.getByRole('button', { name: 'Apply filters' }).click()

  // 4. ADMIN-2: the Access log section, owner-only, names who read and
  //    whose conversation it named — display names, never an email.
  await expect(page.getByRole('heading', { name: 'Access log' })).toBeVisible()
  await expect(
    page.getByText(`${ownerDisplayName} read ${studentDisplayName}`)
  ).toBeVisible()
  // The unfiltered read this screen ran first is still on the log too.
  await expect(
    page.getByText(`${ownerDisplayName} read the whole course`)
  ).toBeVisible()
  await expect(page.locator('body')).not.toContainText(studentEmail)
})
