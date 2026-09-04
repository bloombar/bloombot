/**
 * WEB-26/WEB-27/WEB-28/PROJ-6, end to end: the row-level kebab menus, the
 * "New project" modal, project rename, and a course row's own Chat button
 * — against a real browser and a real `apps/api`, the same harness
 * `course-configuration.spec.ts`/`chat.spec.ts` already use (their own
 * module comments have the fuller "what is real, what is a harness
 * stand-in" account, unchanged here).
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

test('a project is created through the "New project" modal, renamed through its kebab menu, and a course row\'s Chat button opens a real chat for that course (WEB-26, WEB-27, WEB-28, PROJ-6)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web26-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const renamedProjectName = `Autumn 2026 — ${suffix}`
  const courseTitle = `Intro to Testing — ${suffix}`
  const studentsRole = `students-${suffix}`
  const adminsRole = `admins-${suffix}`

  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(email)
  const token = await readSignInToken(email)
  await page.goto(`/sign-in/${token}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // 1. WEB-27: "New project" is a primary button beside the heading, and
  //    creating one asks for the name in a modal — no inline input, no
  //    always-present Create button on the row itself.
  await navigateTo(page, 'Projects')
  await expect(
    page.getByRole('heading', { name: 'Projects', level: 1 })
  ).toBeVisible()
  await page.getByRole('button', { name: 'New project' }).click()
  const newProjectDialog = page.getByRole('dialog', { name: 'New project' })
  await newProjectDialog.getByLabel('Project name').fill(projectName)
  await newProjectDialog.getByRole('button', { name: 'Create' }).click()
  await expect(
    page.getByRole('button', { name: projectName, exact: true })
  ).toBeVisible()

  // 2. WEB-26/PROJ-6: rename it from its own row's kebab menu — the action
  //    (`projects.rename`) that had no caller before this slice, reached
  //    the one way this panel ever reaches an action.
  await page
    .getByRole('button', { name: `Actions for "${projectName}"` })
    .click()
  await page
    .getByRole('group', { name: `Actions for "${projectName}"` })
    .getByRole('button', { name: 'Rename' })
    .click()
  const renameDialog = page.getByRole('dialog', {
    name: `Rename "${projectName}"`,
  })
  await expect(renameDialog.getByLabel('Project name')).toHaveValue(projectName)
  await renameDialog.getByLabel('Project name').fill(renamedProjectName)
  await renameDialog.getByRole('button', { name: 'Rename' }).click()

  // The row now reads the new name, and the old one is gone — not merely
  // that the new name appears *somewhere*.
  await expect(
    page.getByRole('button', { name: renamedProjectName, exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: projectName, exact: true })
  ).toHaveCount(0)

  // 3. Define and enable a course in the renamed project — the same two
  //    steps `chat.spec.ts` drives, reused here rather than duplicated as a
  //    fixture.
  await page
    .getByRole('button', { name: renamedProjectName, exact: true })
    .click()
  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(courseTitle)
  await page.getByLabel('File prefix').fill(`t-${suffix}`)
  await page.getByLabel('Admins role').fill(adminsRole)
  await page.getByLabel('Students role').fill(studentsRole)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible()
  await page
    .getByLabel('Instructions')
    .fill('Answer student questions about the course clearly.')
  await page.getByRole('button', { name: 'Save instructions' }).click()
  await expect(page.getByText('Current')).toBeVisible()

  // 4. Seed this account's own enrolment (the same harness stand-in
  //    `chat.spec.ts`'s own module comment explains in full) — Chat only
  //    has something to answer once an active enrolment exists.
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const account = accounts.getAccountByEmail(email, db)
    if (!account) throw new Error('setup failed: account not found')
    const [membership] = memberships.listMembershipsForAccount(account.id, db)
    if (!membership) throw new Error('setup failed: membership not found')
    const organizationId = membership.organizationId

    const project = projects
      .listProjects(organizationId, db)
      .find((candidate) => candidate.name === renamedProjectName)
    if (!project) throw new Error('setup failed: project not found')
    const course = courses
      .listCourses(organizationId, db, { projectId: project.id })
      .find((candidate) => candidate.title === courseTitle)
    if (!course) throw new Error('setup failed: course not found')

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

  // 5. Back to the course list — `CourseEditor.tsx`'s own back control,
  //    unchanged by this slice — then open a chat session directly from
  //    the course row's own Chat button (WEB-28), not through the drawer's
  //    own Chat tab first.
  await page.getByRole('button', { name: `← ${renamedProjectName}` }).click()
  await page
    .getByRole('button', { name: `Chat about "${courseTitle}"` })
    .click()

  // Landed on the Chat tab, this exact course already selected — the same
  // proof `chat.spec.ts` uses for "which course," not merely that some
  // "Chat" text exists (the drawer's own nav item reads "Chat" too).
  await expect(
    page.getByRole('heading', { name: 'Chat', level: 1 })
  ).toBeVisible()
  await expect(page.getByText(courseTitle)).toBeVisible()

  await page
    .getByLabel('Ask a question')
    .fill('When is the midterm, and what should I read first?')
  await page.getByRole('button', { name: 'Send' }).click()
  const thread = page.getByTestId('chat-thread')
  await expect(thread).toContainText(
    'When is the midterm, and what should I read first?'
  )
  await expect(
    thread.getByRole('heading', { level: 1, name: 'Bloombot' })
  ).toBeVisible()
})
