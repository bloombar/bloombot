/**
 * WEB-51: a category name is unique on a Discord server ignoring
 * capitalisation and every whitespace character — the same comparison the
 * server's own PROJ-3/BOT-13 check applies (`@bloombot/db`'s
 * `normalizeCategoryName`). Two things a unit test cannot prove, both real
 * here (this file's own "what is real" caveat mirrors
 * `course-configuration.spec.ts`'s): a same-course duplicate held back
 * client-side never reaches a real `apps/api` at all, and a cross-course
 * duplicate the client could not have known about locally is refused by a
 * real save through `courses.save`, against a real SQLite database, and the
 * refusal's own field-level rendering is what this spec actually watches
 * for — not a mocked `ApiError` the way `apps/web/tests/course-editor.test.tsx`
 * asserts it.
 *
 * Not real, same as `course-configuration.spec.ts`: no discord.js, no
 * gateway, no OpenAI call — this spec never reaches `handleMention` at all,
 * since nothing it does needs to.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import { navigateTo } from './support/navigate.js'
import { signIn } from './support/sign-in.js'

test('a same-course category duplicate is flagged inline and never reaches the server (WEB-51)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web51-same-${suffix}@example.edu`

  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await navigateTo(page, 'Projects')
  await page.getByRole('button', { name: 'New project' }).click()
  const newProjectDialog = page.getByRole('dialog', { name: 'New project' })
  await newProjectDialog
    .getByLabel('Project name')
    .fill(`Fall 2026 — ${suffix}`)
  await newProjectDialog.getByRole('button', { name: 'Create' }).click()
  await page
    .getByRole('button', { name: `Fall 2026 — ${suffix}`, exact: true })
    .click()

  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(`Web Design — ${suffix}`)
  await page.getByRole('button', { name: 'Add category' }).click()
  await page.getByRole('button', { name: 'Add category' }).click()
  const categoryInputs = page.getByLabel('Category name')
  await categoryInputs.nth(0).fill(`Web Design - GLOBAL - ${suffix}`)
  // Differs only by case and by doubled/leading/trailing whitespace — the
  // same normalization (`normalizeCategoryName`) both this form's own
  // client-side check and the server's PROJ-3/BOT-13 refusal apply.
  await categoryInputs
    .nth(1)
    .fill(`  web design - global - ${suffix}  `.toUpperCase())
  await categoryInputs.nth(1).blur()

  await expect(categoryInputs.nth(1)).toHaveAttribute('aria-invalid', 'true')
  await expect(
    page.getByText('Another category in this course is already named')
  ).toBeVisible()

  // A save attempt is held back client-side — no settings tabs ever appear,
  // which only render once `courses.save` actually returns a saved course.
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('tab', { name: 'General' })).toBeHidden()

  // Editing the duplicate clears the error, and the save now goes through.
  await categoryInputs.nth(1).fill(`Web Design - EXTRA - ${suffix}`)
  await expect(categoryInputs.nth(1)).not.toHaveAttribute(
    'aria-invalid',
    'true'
  )
  await expect(
    page.getByText('Another category in this course is already named')
  ).toBeHidden()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()
})

test('a category matching another course only by case/spelling is refused by the server, and the field-level message names that course (WEB-51/BOT-13/PROJ-10)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web51-cross-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const firstCourseTitle = `Intro to CS — ${suffix}`
  const secondCourseTitle = `Web Design — ${suffix}`
  const sharedCategoryName = `GLOBAL - ${suffix}`

  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await navigateTo(page, 'Projects')
  await page.getByRole('button', { name: 'New project' }).click()
  const newProjectDialog = page.getByRole('dialog', { name: 'New project' })
  await newProjectDialog.getByLabel('Project name').fill(projectName)
  await newProjectDialog.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: projectName, exact: true }).click()

  // First course, with the category name a second course is about to
  // collide with under BOT-13's case/whitespace-insensitive comparison.
  // Enabled (D-23's default is disabled) — `findCourseNameConflict` only
  // considers *enabled* courses as collision candidates
  // (`packages/db/src/repos/courses.ts`), so a disabled first course would
  // leave the second course's save going through uncontested.
  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(firstCourseTitle)
  await page.getByRole('button', { name: 'Add category' }).click()
  await page.getByLabel('Category name').fill(sharedCategoryName)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()

  // Back to the project's own course list, then a second, brand-new course.
  await navigateTo(page, 'Projects')
  await page.getByRole('button', { name: projectName, exact: true }).click()
  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(secondCourseTitle)
  await page.getByRole('button', { name: 'Add category' }).click()
  // Differs only by case and surrounding whitespace from the first course's
  // own category — this form's own client-side check only ever compares
  // categories *within* this same course, so this reaches the server.
  await page
    .getByLabel('Category name')
    .fill(`  ${sharedCategoryName.toLowerCase()}  `)
  // `createCourse` only runs the PROJ-3/BOT-13 collision check at all while
  // *this* course is itself being enabled (`packages/db/src/repos/courses.ts`)
  // — a disabled course can be saved with a name nobody else uses yet, since
  // it does not route until it is turned on.
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()

  // Refused — the settings tabs never appear (this course was never
  // created), and the field-level message on the category row itself names
  // the course it collided with.
  await expect(page.getByRole('tab', { name: 'General' })).toBeHidden()
  await expect(page.getByLabel('Category name')).toHaveAttribute(
    'aria-invalid',
    'true'
  )
  const fieldError = page
    .getByLabel('Category name')
    .locator('xpath=following-sibling::p[@role="alert"]')
  await expect(fieldError).toContainText(firstCourseTitle)
  await expect(fieldError).toContainText(projectName)

  // Editing the category clears the field error and the save now succeeds.
  await page.getByLabel('Category name').fill(`Web Design - GLOBAL - ${suffix}`)
  await expect(page.getByLabel('Category name')).not.toHaveAttribute(
    'aria-invalid',
    'true'
  )
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()
})
