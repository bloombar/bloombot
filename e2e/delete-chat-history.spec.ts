/**
 * WEB-73/DATA-7, end to end: a person deletes their own conversation
 * history in a course, from Chat's own heading row — the same harness
 * `e2e/chat.spec.ts` already uses (that file's own module comment has the
 * full "what is real, what is a harness stand-in" account, unchanged
 * here).
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

import { approveCourseForE2e } from './support/approve-course.js'
import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { signIn } from './support/sign-in.js'

test('a person deletes their own history in a course, confirmed by naming the course, and the thread is empty afterward (WEB-73)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web73-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Intro to Testing — ${suffix}`
  const studentsRole = `students-${suffix}`
  const adminsRole = `admins-${suffix}`

  // 1. Sign in, then define and enable a course — the same two steps
  //    `chat.spec.ts` drives, reused here rather than duplicated.
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
  await page.getByLabel('Admins role').fill(adminsRole)
  await page.getByLabel('Students role').fill(studentsRole)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()

  // Instructions (WEB-19/FILE-4), on the AI tab — `chat.spec.ts`'s own
  // module comment on this step: without a saved prompt, `answerQuestion`
  // reports the course as not yet configured, which `Chat.tsx` shows as a
  // notice rather than a reply, and this test needs a real reply on the
  // thread for the Delete history control to have anything to offer.
  await page.getByRole('tab', { name: 'AI' }).click()
  await page
    .getByLabel('Instructions')
    .fill('Answer student questions about the course clearly.')
  await page.getByRole('button', { name: 'Save instructions' }).click()
  await page.getByRole('button', { name: /Show history/ }).click()
  await expect(page.getByText('Current')).toBeVisible()

  // 2. Seed this account's own enrolment — the fact the panel has no
  //    screen for yet (`chat.spec.ts`'s own module comment explains why
  //    this enrols the account's own already-connected web person).
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

    approveCourseForE2e(db, organizationId, course.id)

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

  // 3. Ask something — WEB-73's own control is not offered until there is
  //    history to delete.
  await navigateTo(page, 'Chat')
  await expect(page.getByText(courseTitle)).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Delete history' })
  ).not.toBeVisible()

  await page.getByLabel('Ask a question').fill('When is the midterm?')
  await page.getByRole('button', { name: 'Send' }).click()

  const thread = page.getByTestId('chat-thread')
  await expect(thread).toContainText('When is the midterm?')
  await expect(
    thread.getByRole('heading', { level: 1, name: 'Bloombot' })
  ).toBeVisible()

  // 4. Delete history — offered now, confirms first naming the course,
  //    and clears the thread on screen.
  await expect(
    page.getByRole('button', { name: 'Delete history' })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Delete history' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(courseTitle)
  await dialog.getByRole('button', { name: 'Delete history' }).click()

  await expect(thread).not.toContainText('When is the midterm?')
  // Nothing left to delete — the control itself is gone too.
  await expect(
    page.getByRole('button', { name: 'Delete history' })
  ).not.toBeVisible()
})
