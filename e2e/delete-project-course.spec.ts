/**
 * PROJ-8/PROJ-9/WEB-50, end to end: deleting a course and deleting a
 * project through the Projects screen's own row kebabs, against a real
 * browser and a real `apps/api` — the same harness
 * `projects-row-menus.spec.ts`/`admin-console.spec.ts` already use (their
 * own module comments have the fuller "what is real, what is a harness
 * stand-in" account, unchanged here). This spec is ADMIN-5's own
 * confirmed-and-audited deletion shape, one level down: a course or a
 * project, not a whole tenant, deleted by the instructor who owns it
 * rather than a platform administrator.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  courses,
  deletions,
  memberships,
  openDatabase,
  projects,
  schema,
} from '@bloombot/db'

import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { signIn } from './support/sign-in.js'

test('a course is deleted from its own row kebab, confirmed by typing its title (PROJ-8, WEB-50)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `proj8-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Intro to Testing — ${suffix}`
  const studentsRole = `students-${suffix}`
  const adminsRole = `admins-${suffix}`

  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // Create a project and a course through the panel itself — the same two
  // steps `projects-row-menus.spec.ts` drives, reused here rather than
  // duplicated as a fixture.
  await navigateTo(page, 'Projects')
  await page.getByRole('button', { name: 'New project' }).click()
  const newProjectDialog = page.getByRole('dialog', { name: 'New project' })
  await newProjectDialog.getByLabel('Project name').fill(projectName)
  await newProjectDialog.getByRole('button', { name: 'Create' }).click()
  await expect(
    page.getByRole('button', { name: projectName, exact: true })
  ).toBeVisible()

  await page.getByRole('button', { name: projectName, exact: true }).click()
  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(courseTitle)
  await page.getByLabel('Admins role').fill(adminsRole)
  await page.getByLabel('Students role').fill(studentsRole)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()

  // Back to the project's own course list, where the row's kebab lives.
  await page.getByRole('button', { name: `← ${projectName}` }).click()
  const courseRow = page.getByTestId(/^course-/)
  await expect(courseRow).toBeVisible()

  await page
    .getByRole('button', { name: `Actions for "${courseTitle}"` })
    .click()
  const menu = page.getByRole('group', {
    name: `Actions for "${courseTitle}"`,
  })
  // WEB-50: Delete is last, styled destructive.
  const menuItems = menu.getByRole('button')
  await expect(menuItems.last()).toHaveText('Delete')
  await menuItems.last().click()

  // PROJ-8: "names exactly what will be deleted before it happens" — the
  // preview's own counts are read into the confirmation itself.
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('conversation(s)')
  await expect(dialog).toContainText('knowledge file(s)')

  // WEB-50 rework finding: the destructive button is disabled until the
  // typed title matches exactly — nothing typed yet, then the wrong
  // title, both leave it disabled and unclickable, the real confirmation
  // WEB-15 asks for rather than a plain "are you sure" a stray click
  // could pass.
  const confirmButton = dialog.getByRole('button', { name: 'Delete' })
  await expect(confirmButton).toBeDisabled()
  await dialog.getByLabel('Course title').fill('the wrong title')
  await expect(confirmButton).toBeDisabled()

  // The course's own title, typed exactly, enables it and proceeds.
  await dialog.getByLabel('Course title').fill(courseTitle)
  await expect(confirmButton).toBeEnabled()
  await confirmButton.click()

  await expect(
    page.getByRole('button', { name: `Actions for "${courseTitle}"` })
  ).not.toBeAttached()
  await expect(page.getByText('No courses in this project yet.')).toBeVisible()

  // Read back from the database: the course is actually gone.
  const verifyDb = openDatabase(E2E_DATABASE_PATH)
  try {
    const account = accounts.getAccountByEmail(email, verifyDb)
    if (!account) throw new Error('setup failed: account not found')
    const [membership] = memberships.listMembershipsForAccount(
      account.id,
      verifyDb
    )
    if (!membership) throw new Error('setup failed: membership not found')
    const organizationId = membership.organizationId
    const project = projects
      .listProjects(organizationId, verifyDb)
      .find((candidate) => candidate.name === projectName)
    if (!project) throw new Error('setup failed: project not found')

    expect(
      courses
        .listCourses(organizationId, verifyDb, { projectId: project.id })
        .find((candidate) => candidate.title === courseTitle)
    ).toBeUndefined()

    const recorded = verifyDb
      .select()
      .from(schema.contentDeletions)
      .all()
      .filter((row) => row.subjectName === courseTitle)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      organizationId,
      kind: 'course',
      deletedByAccountId: account.id,
    })
  } finally {
    closeDatabase(verifyDb)
  }
})

test('a project — and its course — is deleted from its own row kebab, confirmed by typing its name (PROJ-9, WEB-50)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `proj9-${suffix}@example.edu`
  const projectName = `Spring 2027 — ${suffix}`
  const courseTitle = `Advanced Testing — ${suffix}`
  const studentsRole = `students-${suffix}`
  const adminsRole = `admins-${suffix}`

  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await navigateTo(page, 'Projects')
  await page.getByRole('button', { name: 'New project' }).click()
  const newProjectDialog = page.getByRole('dialog', { name: 'New project' })
  await newProjectDialog.getByLabel('Project name').fill(projectName)
  await newProjectDialog.getByRole('button', { name: 'Create' }).click()
  await expect(
    page.getByRole('button', { name: projectName, exact: true })
  ).toBeVisible()

  await page.getByRole('button', { name: projectName, exact: true }).click()
  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(courseTitle)
  await page.getByLabel('Admins role').fill(adminsRole)
  await page.getByLabel('Students role').fill(studentsRole)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()

  // Back to the Projects list itself, where the project row's own kebab
  // lives.
  await page.getByRole('button', { name: `← ${projectName}` }).click()
  await navigateTo(page, 'Projects')
  await expect(
    page.getByRole('button', { name: projectName, exact: true })
  ).toBeVisible()

  await page
    .getByRole('button', { name: `Actions for "${projectName}"` })
    .click()
  const menu = page.getByRole('group', {
    name: `Actions for "${projectName}"`,
  })
  const menuItems = menu.getByRole('button')
  await expect(menuItems.last()).toHaveText('Delete')
  await menuItems.last().click()

  // PROJ-9: names how many courses will go, alongside PROJ-8's own counts.
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('1 course(s)')

  // WEB-50 rework finding: disabled until the typed name matches exactly.
  const confirmButton = dialog.getByRole('button', { name: 'Delete' })
  await expect(confirmButton).toBeDisabled()
  await dialog.getByLabel('Project name').fill('the wrong name')
  await expect(confirmButton).toBeDisabled()

  await dialog.getByLabel('Project name').fill(projectName)
  await expect(confirmButton).toBeEnabled()
  await confirmButton.click()

  await expect(
    page.getByRole('button', { name: projectName, exact: true })
  ).not.toBeAttached()

  // Read back from the database: the project and its course are both gone.
  const verifyDb = openDatabase(E2E_DATABASE_PATH)
  try {
    const account = accounts.getAccountByEmail(email, verifyDb)
    if (!account) throw new Error('setup failed: account not found')
    const [membership] = memberships.listMembershipsForAccount(
      account.id,
      verifyDb
    )
    if (!membership) throw new Error('setup failed: membership not found')
    const organizationId = membership.organizationId

    expect(
      projects
        .listProjects(organizationId, verifyDb)
        .find((candidate) => candidate.name === projectName)
    ).toBeUndefined()

    const recorded = verifyDb
      .select()
      .from(schema.contentDeletions)
      .all()
      .filter((row) => row.subjectName === projectName)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      organizationId,
      kind: 'project',
      deletedByAccountId: account.id,
    })

    // Confirmed with `deletions.previewProjectDeletion` too, the same
    // "nothing left to count" proof `packages/db`'s own unit tests use.
    expect(
      deletions.previewProjectDeletion(
        organizationId,
        recorded[0]?.subjectId ?? '',
        verifyDb
      )
    ).toBeUndefined()
  } finally {
    closeDatabase(verifyDb)
  }
})
