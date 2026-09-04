/**
 * FILE-6/MDL-9/WEB-31, end to end: an administrator names a website on a
 * course, typed as a full URL, sees it listed as the reduced bare domain,
 * adds a duplicate and sees it refused, and removes one through the
 * confirmation — mirroring `join-links-panel.spec.ts`/
 * `course-knowledge-files.spec.ts`'s own shape.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline those two specs'
 * own module comments hold themselves to):
 *
 *  - Real: the browser (`pages/CourseEditor.tsx`,
 *    `components/CourseWebSources.tsx`), a real `apps/api`
 *    (`e2e/support/start-api.ts`), a real throwaway SQLite database, and
 *    every action this UI drives — `courses.save`, `courseWebSources.add`,
 *    `.list`, `.remove` — reached exactly the way any other caller reaches
 *    them.
 *  - Not real: the model (unreached — nothing here asks the course a
 *    question) and the provider (no `web_search` call happens anywhere in
 *    this run; MDL-9's own adapter wiring is proven by
 *    `packages/openai`'s own unit tests, not here).
 *
 * So this test proves: a website added entirely through the panel, typed
 * however an instructor actually would (a full URL), is stored and shown
 * back as its bare domain (WEB-31); a duplicate is refused rather than
 * silently accepted or opaquely failed; and removing one, behind a
 * confirmation naming the consequence, actually takes it out of what the
 * course names.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  courses,
  courseWebSources,
  memberships,
  openDatabase,
  projects,
} from '@bloombot/db'

import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { readSignInToken } from './support/read-sign-in-token.js'

test('an owner adds a website (typed as a URL), sees it reduced to its domain, a duplicate is refused, and removing one takes effect (FILE-6, WEB-31)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const ownerEmail = `owner-${suffix}@example.edu`
  const projectName = `Web Sources — ${suffix}`
  const courseTitle = `Web Sources Course — ${suffix}`

  // 1. Sign in and define a course — the same panel-only path
  //    `course-configuration.spec.ts` already proves for CFG-2..4.
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
  await page.getByLabel('File prefix').fill(`ws-${suffix}`)
  await page.getByLabel('Admins role').fill(`admins-ws-${suffix}`)
  await page.getByLabel('Students role').fill(`students-ws-${suffix}`)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible()

  // 2. FILE-6/WEB-31: add a website, typed as a full URL — the panel shows
  //    it back as the bare domain `courseWebSources.add` reduced it to.
  // Scoped to the panel's own "Websites" region — "example.edu" also
  // appears, coincidentally, in this same page's roster-import format
  // instructions (an email address in its own example row), so an
  // unscoped `page.getByText` would count matches that have nothing to do
  // with this section.
  const websites = page.getByRole('region', { name: 'Websites' })
  await expect(
    websites.getByRole('heading', { name: 'Websites' })
  ).toBeVisible()
  await expect(websites.getByText('No websites added yet.')).toBeVisible()

  await page
    .getByLabel('Website', { exact: true })
    .fill('https://Example.edu/some/path')
  await page.getByRole('button', { name: 'Add website' }).click()

  await expect(websites.getByText('example.edu')).toBeVisible()
  await expect(
    websites.getByText('https://Example.edu/some/path')
  ).not.toBeVisible()

  // 3. A duplicate — even typed differently (bare, this time) — is refused,
  //    not silently accepted as a second row and not an opaque error.
  await page.getByLabel('Website', { exact: true }).fill('example.edu')
  await page.getByRole('button', { name: 'Add website' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'is already a website this course names'
  )
  await expect(websites.getByText('example.edu', { exact: true })).toHaveCount(
    1
  )

  // 4. Read back through the real database — proves the panel's own value
  //    round-tripped through `courseWebSources.add` and was actually
  //    persisted as the reduced domain, not merely rendered from
  //    client-side state.
  const db = openDatabase(E2E_DATABASE_PATH)
  let organizationId: string
  let courseId: string
  try {
    const ownerAccount = accounts.getAccountByEmail(ownerEmail, db)
    if (!ownerAccount) throw new Error('verify failed: owner account not found')
    const [ownerMembership] = memberships.listMembershipsForAccount(
      ownerAccount.id,
      db
    )
    if (!ownerMembership) throw new Error('verify failed: membership not found')
    organizationId = ownerMembership.organizationId

    const project = projects
      .listProjects(organizationId, db)
      .find((candidate) => candidate.name === projectName)
    if (!project) throw new Error('verify failed: project not found')
    const course = courses
      .listCourses(organizationId, db, { projectId: project.id })
      .find((candidate) => candidate.title === courseTitle)
    if (!course) throw new Error('verify failed: course not found')
    courseId = course.id

    const sources = courseWebSources.listWebSourcesForCourse(
      organizationId,
      courseId,
      db
    )
    expect(sources.map((source) => source.domain)).toEqual(['example.edu'])
  } finally {
    closeDatabase(db)
  }

  // 5. FILE-6: remove, behind a confirmation naming the consequence.
  await page.getByRole('button', { name: 'Remove example.edu' }).click()
  const dialog = page.getByRole('dialog', { name: 'Remove "example.edu"?' })
  await expect(dialog).toContainText(
    "the course's answers are no longer drawn from this site"
  )
  await dialog.getByRole('button', { name: 'Remove' }).click()

  await expect(page.getByText('No websites added yet.')).toBeVisible()

  // 6. Read back directly: the row is actually gone, not merely hidden.
  const verifyDb = openDatabase(E2E_DATABASE_PATH)
  try {
    const remaining = courseWebSources.listWebSourcesForCourse(
      organizationId,
      courseId,
      verifyDb
    )
    expect(remaining).toEqual([])
  } finally {
    closeDatabase(verifyDb)
  }
})
