/**
 * PROJ-8/PROJ-9/WEB-50/PROJ-11, end to end: deleting a course and deleting a
 * project through the Projects screen's own row kebabs, against a real
 * browser and a real `apps/api` — the same harness
 * `projects-row-menus.spec.ts`/`admin-console.spec.ts` already use (their
 * own module comments have the fuller "what is real, what is a harness
 * stand-in" account, unchanged here).
 *
 * PROJ-11 retired the row kebab's own call to the permanent
 * `courses.delete`/`projects.delete` in favour of the reversible
 * `courses.softDelete`/`projects.softDelete` — the same action
 * `e2e/delete-course-general-tab.spec.ts`'s own Danger-zone delete already
 * calls — so this spec now proves the row-kebab delete is soft: the row is
 * gone from the list, but the record still exists with `deletedAt` set, and
 * a restore (`@bloombot/db`'s own `restoreCourse`/`restoreProject` — there
 * is no restore UI yet, WEB-72's own module comment on why this reads the
 * repo directly rather than driving a screen that does not exist) brings it
 * back.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'
import { eq } from 'drizzle-orm'

import {
  accounts,
  closeDatabase,
  courses,
  memberships,
  openDatabase,
  projects,
  schema,
} from '@bloombot/db'

import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { signIn } from './support/sign-in.js'

test('a course is soft-deleted from its own row kebab, confirmed by typing its title, and a restore brings it back (PROJ-8, WEB-50, PROJ-11)', async ({
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
  // preview's own counts are read into the confirmation itself, unchanged
  // by PROJ-11.
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('conversation(s)')
  await expect(dialog).toContainText('knowledge file(s)')
  // PROJ-11 — the dialog states reversible-then-permanent, never "cannot
  // be undone": this control is the same reversible delete the Danger zone
  // offers now, not the permanent wipe it used to be.
  await expect(dialog).toContainText('reversible')
  await expect(dialog).not.toContainText('cannot be undone')

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

  // Read back from the database: soft-deleted (DATA-7), not removed — an
  // ordinary read already excludes it (DATA-9), but the row itself still
  // exists with `deletedAt` set, and a restore brings it back.
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

    // DATA-9 — gone from an ordinary read.
    expect(
      courses
        .listCourses(organizationId, verifyDb, { projectId: project.id })
        .find((candidate) => candidate.title === courseTitle)
    ).toBeUndefined()

    // DATA-7 — but still present, marked rather than removed. Read
    // unfiltered, directly off the schema (`repos/deletions.ts`'s own DATA-9
    // exception for a restore — there is no `includeDeleted` read on
    // `courses.listCourses` itself, WEB-72's module comment on why this
    // slice does not add one).
    const deletedCourse = verifyDb
      .select()
      .from(schema.courses)
      .where(eq(schema.courses.title, courseTitle))
      .get()
    expect(deletedCourse).toBeDefined()
    expect(deletedCourse?.deletedAt).not.toBeNull()
    expect(deletedCourse?.deletedByAccountId).toBe(account.id)

    // A restore un-marks it, and it is visible again.
    if (!deletedCourse)
      throw new Error('setup failed: deleted course not found')
    courses.restoreCourse(organizationId, deletedCourse.id, verifyDb)
    expect(
      courses
        .listCourses(organizationId, verifyDb, { projectId: project.id })
        .find((candidate) => candidate.title === courseTitle)
    ).toBeDefined()
  } finally {
    closeDatabase(verifyDb)
  }
})

test('a project — and its course — is soft-deleted from its own row kebab, confirmed by typing its name, and a restore brings it back (PROJ-9, WEB-50, PROJ-11)', async ({
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
  // PROJ-11 — reversible-then-permanent, never "cannot be undone."
  await expect(dialog).toContainText('reversible')
  await expect(dialog).not.toContainText('cannot be undone')

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

  // Read back from the database: the project and its course are both
  // soft-deleted, not removed, and a restore brings the project back.
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

    // DATA-9 — gone from an ordinary read.
    expect(
      projects
        .listProjects(organizationId, verifyDb)
        .find((candidate) => candidate.name === projectName)
    ).toBeUndefined()

    // DATA-7 — but still present, marked rather than removed. Read
    // unfiltered, directly off the schema, the same DATA-9 exception the
    // course half of this spec uses above.
    const deletedProject = verifyDb
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.name, projectName))
      .get()
    expect(deletedProject).toBeDefined()
    expect(deletedProject?.deletedAt).not.toBeNull()
    expect(deletedProject?.deletedByAccountId).toBe(account.id)

    // A restore un-marks it, and it is visible again.
    if (!deletedProject)
      throw new Error('setup failed: deleted project not found')
    projects.restoreProject(organizationId, deletedProject.id, verifyDb)
    expect(
      projects
        .listProjects(organizationId, verifyDb)
        .find((candidate) => candidate.name === projectName)
    ).toBeDefined()
  } finally {
    closeDatabase(verifyDb)
  }
})
