/**
 * WEB-72/DATA-7, end to end: an owner deletes a course from its own
 * General tab's own Danger zone, confirmed by typing its title — the same
 * harness `e2e/delete-project-course.spec.ts` already uses for PROJ-8's
 * own permanent delete, one level over (this is the reversible, soft
 * delete `courses.softDelete` adds, distinct from `courses.delete`, and
 * left unconnected to it — see `docs/DECISIONS.md` D-140).
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  courses,
  memberships,
  openDatabase,
  projects,
} from '@bloombot/db'

import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { signIn } from './support/sign-in.js'

test('an owner deletes a course from its own General tab, confirmed by typing its title, and it is gone (WEB-72)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web72-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Intro to Testing — ${suffix}`
  const studentsRole = `students-${suffix}`
  const adminsRole = `admins-${suffix}`

  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // Create a project and a course through the panel itself — the same two
  // steps `delete-project-course.spec.ts` drives, reused here rather than
  // duplicated as a fixture. A fresh sign-up's own personal organization
  // makes this account its owner (TEN-1) — the same account WEB-72's own
  // Danger zone requires.
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

  // WEB-72 — the Danger zone is the last section on the General tab.
  const generalPanel = page.getByRole('tabpanel', { name: 'General' })
  const dangerZone = generalPanel.getByRole('region', { name: 'Danger zone' })
  await dangerZone.scrollIntoViewIfNeeded()
  await expect(dangerZone).toBeVisible()

  await dangerZone.getByRole('button', { name: 'Delete course' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(courseTitle)

  // WEB-50's own typed-name discipline: disabled until the title typed
  // matches exactly.
  const confirmButton = dialog.getByRole('button', { name: 'Delete course' })
  await expect(confirmButton).toBeDisabled()
  await dialog.getByLabel('Course title').fill('the wrong title')
  await expect(confirmButton).toBeDisabled()

  await dialog.getByLabel('Course title').fill(courseTitle)
  await expect(confirmButton).toBeEnabled()
  await confirmButton.click()

  // The editor closes back to the project's own course list — the
  // deleted course's row is gone from it.
  await expect(page.getByText('No courses in this project yet.')).toBeVisible()

  // Read back from the database: soft-deleted (DATA-7), not removed — an
  // ordinary read already excludes it (DATA-9).
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
  } finally {
    closeDatabase(verifyDb)
  }
})
