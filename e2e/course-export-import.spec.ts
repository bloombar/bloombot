/**
 * PORT-1..PORT-7/WEB-39, end to end: a course is exported to a file from its
 * own row menu, and that same file — the bytes the browser actually
 * downloaded, not a fixture written by this spec — is dropped into a
 * project's Import dialog and comes back as a course.
 *
 * This is the round trip the feature exists for, and the only place it is
 * proved against a real browser, a real `apps/api` and a real database: the
 * unit tests either side of it each see one half. What it checks is that the
 * halves agree — the file the export writes is a file the import reads, the
 * course's settings survive it, and the copy lands in the project it was
 * imported into under the PORT-5 title, disabled (PORT-6).
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { expect, test } from '@playwright/test'

import { signIn } from './support/sign-in.js'
import { navigateTo } from './support/navigate.js'

test('a course is exported to a file and imported back into a project, numbered and disabled (PORT-1, PORT-5, PORT-6, PORT-7, WEB-39)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `port-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Intro to CS — ${suffix}`
  const adminsRole = `admins-cs-${suffix}`
  const studentsRole = `students-cs-${suffix}`
  const categoryName = `Intro to CS ${suffix} - GLOBAL`
  const instructions = 'Answer questions about the syllabus in plain language.'

  // 1. Sign in, and build one course worth exporting — title, both role
  //    names, a category (CFG-4) and instructions (FILE-4), through the
  //    panel alone.
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
  await page.getByRole('button', { name: 'Add category' }).click()
  await page.getByLabel('Category name').fill(categoryName)
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()

  await page.getByRole('tab', { name: 'AI' }).click()
  await page.getByLabel('Instructions').fill(instructions)
  await page.getByRole('button', { name: 'Save instructions' }).click()
  // WEB-40: the History section is collapsed by default — open it before
  // looking for "Current".
  await page.getByRole('button', { name: /Show history/ }).click()
  await expect(page.getByText('Current')).toBeVisible()

  // 2. WEB-39/PORT-1: export it from the course row's own kebab menu, and
  //    take the bytes the browser was actually handed.
  await page.getByRole('button', { name: `← ${projectName}` }).click()
  await page
    .getByRole('button', { name: `Actions for "${courseTitle}"` })
    .click()
  const downloadPromise = page.waitForEvent('download')
  await page
    .getByRole('group', { name: `Actions for "${courseTitle}"` })
    .getByRole('button', { name: 'Export' })
    .click()
  const download = await downloadPromise
  const downloadedPath = await download.path()
  const exported = readFileSync(downloadedPath, 'utf8')

  // The file says what it is, carries the course's own settings, and — PORT-2
  // — mentions nobody: the account that exported it is not in it.
  expect(exported).toContain('bloombotCourseExport: 1')
  expect(exported).toContain(courseTitle)
  expect(exported).toContain(adminsRole)
  expect(exported).toContain(categoryName)
  expect(exported).toContain(instructions)
  expect(exported).not.toContain(email)

  // 3. WEB-39/PORT-4: import that same file back into the same project,
  //    through the project row's own Import menu item and its drop zone.
  await navigateTo(page, 'Projects')
  await page
    .getByRole('button', { name: `Actions for "${projectName}"` })
    .click()
  await page
    .getByRole('group', { name: `Actions for "${projectName}"` })
    .getByRole('button', { name: 'Import' })
    .click()

  const importDialog = page.getByRole('dialog', {
    name: `Import a course into "${projectName}"`,
  })
  // PORT-6, said before the import runs rather than discovered afterwards.
  await expect(importDialog.getByText(/arrives disabled/)).toBeVisible()
  // Nothing to import until a file is chosen.
  await expect(
    importDialog.getByRole('button', { name: 'Import' })
  ).toBeDisabled()

  await importDialog.locator('input[type="file"]').setInputFiles({
    name: download.suggestedFilename(),
    mimeType: 'application/yaml',
    buffer: Buffer.from(exported),
  })
  await importDialog.getByRole('button', { name: 'Import' }).click()

  // 4. PORT-5/PORT-7: the report names the title the copy was actually
  //    given — the original's title was taken, so this is its "2".
  const report = page.getByTestId('course-import-report')
  await expect(report).toBeVisible()
  await expect(report).toContainText(`${courseTitle} 2`)
  await expect(report).toContainText('already here')
  await page.getByRole('button', { name: 'Done' }).click()

  // 5. The copy is in that project, disabled, beside the original — and the
  //    original is untouched.
  await page.getByRole('button', { name: projectName, exact: true }).click()
  await expect(
    page.getByRole('button', { name: `${courseTitle} 2`, exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: courseTitle, exact: true })
  ).toBeVisible()

  // 6. PORT-1: the copy really carries the exported settings, not just the
  //    title — its roles, its category and its instructions all came across.
  await page
    .getByRole('button', { name: `${courseTitle} 2`, exact: true })
    .click()
  await expect(page.getByLabel('Title')).toHaveValue(`${courseTitle} 2`)
  await expect(page.getByLabel('Enabled')).not.toBeChecked()
  // WEB-35: the role names and categories live on the Discord tab.
  await page.getByRole('tab', { name: 'Discord' }).click()
  await expect(page.getByLabel('Admins role')).toHaveValue(adminsRole)
  await expect(page.getByLabel('Students role')).toHaveValue(studentsRole)
  await expect(page.getByLabel('Category name')).toHaveValue(categoryName)
  await page.getByRole('tab', { name: 'AI' }).click()
  await expect(page.getByLabel('Instructions')).toHaveValue(instructions)
})
