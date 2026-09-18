/**
 * ADMIN-7..ADMIN-11, end to end: the console as a map of the platform — a
 * platform administrator opens an organization, follows a project link to
 * its own screen, follows a course link from there to its own screen, and
 * reaches an enrolled student's own account screen — once from the
 * course's own People section (ADMIN-9's link into ADMIN-11), and once
 * again from the console's Users screen (ADMIN-10). Sibling to
 * `admin-console.spec.ts`'s own WEB-33/WEB-54 navigation coverage, but
 * proving the *new* addresses this phase adds (`admin-project`,
 * `admin-accounts`, `admin-account`) and the links between every screen
 * this slice's own brief calls for, rather than the three pre-existing
 * addresses that file already covers.
 *
 * **What is real, and what is a harness stand-in — the same discipline
 * `admin-console.spec.ts`'s own module comment holds itself to:**
 *
 *  - Real: the browser (`pages/Admin.tsx` and every module under
 *    `pages/admin/`), a real `apps/api`, a real throwaway SQLite database,
 *    and every route this spec drives — `routes/admin.ts`'s own
 *    `GET /organizations/:organizationId`, `GET /projects/:projectId`,
 *    `GET /courses/:courseId`, `GET /accounts` and `GET /accounts/:accountId`
 *    — reached exactly the way any other caller reaches them.
 *  - **Not real**: the project, course and enrolment this spec reads back
 *    are seeded directly through `@bloombot/db`'s own repos, into the
 *    student's own personal organization (created for them by the ordinary
 *    sign-in this spec drives) — the same "the panel's own creation flow
 *    is proven elsewhere" reasoning `admin-course-view.spec.ts`'s own
 *    module comment already gives for the identical enrolment shape.
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

import { E2E_ADMIN_EMAIL, E2E_DATABASE_PATH } from './support/env.js'
import { signIn } from './support/sign-in.js'
import { withRetry } from './support/with-retry.js'

test('a platform administrator moves from an organization to its project to its course to an enrolled student’s own account, entirely through the console’s own links (ADMIN-7, ADMIN-8, ADMIN-9, ADMIN-10, ADMIN-11)', async ({
  page,
  browser,
}) => {
  const suffix = randomUUID().slice(0, 8)
  // No `.`/`_`/`-` in the local part — `displayNameFromEmail`
  // (`@bloombot/auth`) capitalizes the first letter and lower-cases the
  // rest with no word breaks to reason about, so this spec can predict the
  // exact display name the student's own sign-in produces.
  const email = `qastudent${suffix}@example.edu`
  const expectedDisplayName = `Qastudent${suffix}`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Office Hours — ${suffix}`

  // 1. The student signs in for real — the ordinary emailed-link flow
  //    creates their own personal organization and a `web` person identity
  //    already connected to their own account.
  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  const db = openDatabase(E2E_DATABASE_PATH)
  let organizationId: string
  let courseId: string
  let studentAccountId: string
  try {
    const account = accounts.getAccountByEmail(email, db)
    if (!account) throw new Error('setup failed: account not found')
    studentAccountId = account.id
    const [membership] = memberships.listMembershipsForAccount(account.id, db)
    if (!membership) throw new Error('setup failed: membership not found')
    organizationId = membership.organizationId

    const project = await withRetry(() =>
      projects.createProject(organizationId, { name: projectName }, db)
    )
    const courseResult = await withRetry(() =>
      courses.createCourse(
        organizationId,
        {
          projectId: project.id,
          title: courseTitle,
          enabled: true,
          adminsRole: `admins-${suffix}`,
          studentsRole: `students-${suffix}`,
          categories: [],
        },
        db
      )
    )
    if (!courseResult.ok) throw new Error('setup failed: course not saved')
    courseId = courseResult.course.id

    const person = people.resolveIdentity(
      organizationId,
      { surface: 'web', externalId: account.id },
      db
    )
    if (!person) throw new Error('setup failed: no connected web person')
    // `resolvePersonByIdentity` (called by the ordinary sign-in this spec
    // just drove) always creates a `web` person with `displayName: null`
    // (PPL-3's own "nobody has proven a name yet") — set it directly so
    // this spec's own assertions have a predictable name to look for on
    // the course's own People section, rather than the bare person id
    // `AdminCoursePerson`'s own `displayName ?? email ?? personId` fallback
    // would otherwise show.
    people.overwriteRosterFields(
      organizationId,
      person.id,
      { displayName: expectedDisplayName },
      db
    )
    const enrolled = enrolments.enrolViaRoster(
      organizationId,
      { courseId, personId: person.id },
      db
    )
    if (!enrolled) throw new Error('setup failed: enrolment refused')
  } finally {
    closeDatabase(db)
  }

  // 2. A platform administrator, in a second, independent browser context —
  //    never a member of the student's own organization at all (ADMIN-4's
  //    own "not a master key").
  const adminContext = await browser.newContext()
  try {
    const adminPage = await adminContext.newPage()
    await signIn(adminPage, E2E_ADMIN_EMAIL)
    await expect(adminPage.getByTestId('organization-switcher')).toBeVisible()

    // The organization's own screen (ADMIN-7).
    await adminPage.goto('/platform-admin/organizations')
    const orgRow = adminPage.getByTestId(`admin-org-${organizationId}`)
    await expect(orgRow).toBeVisible()
    await orgRow.getByRole('button', { name: expectedDisplayName }).click()
    await expect(adminPage).toHaveURL(
      `/platform-admin/organizations/${organizationId}`
    )
    const orgDetail = adminPage.getByTestId(
      `admin-org-detail-${organizationId}`
    )
    await expect(orgDetail).toBeVisible()
    const projectsSection = orgDetail.getByRole('region', {
      name: 'Projects',
    })
    await expect(projectsSection).toContainText(projectName)
    await expect(projectsSection).toContainText(courseTitle)

    // Follow the project link into its own screen (ADMIN-8).
    await projectsSection.getByRole('link', { name: projectName }).click()
    await expect(adminPage).toHaveURL(/\/platform-admin\/projects\/.+/)
    const projectDetail = adminPage.locator(
      '[data-testid^="admin-project-detail-"]'
    )
    await expect(projectDetail).toBeVisible()
    await expect(projectDetail).toContainText(expectedDisplayName)
    await expect(projectDetail).toContainText(courseTitle)

    // Follow the course link into its own screen (ADMIN-9) — its own
    // settings, plus the organization/project links, and the enrolled
    // student, linking to that student's own account screen.
    await projectDetail.getByRole('link', { name: courseTitle }).click()
    await expect(adminPage).toHaveURL(
      new RegExp(`/platform-admin/courses/${courseId}$`)
    )
    const courseDetail = adminPage.getByTestId(
      `admin-course-detail-${courseId}`
    )
    await expect(courseDetail).toBeVisible()
    // The organization link is asserted by `href`, not by its own link
    // text — the student's personal organization happens to share the
    // student's own display name (both `displayNameFromEmail(email)`), so
    // the People section's own link to the same person, just below, would
    // otherwise make `getByRole('link', { name: expectedDisplayName })`
    // ambiguous on this screen.
    await expect(
      courseDetail.locator(
        `a[href="/platform-admin/organizations/${organizationId}"]`
      )
    ).toBeVisible()
    const peopleSection = courseDetail.getByRole('region', { name: 'People' })
    await expect(peopleSection).toContainText(expectedDisplayName)

    // Follow the student's own name into their account screen — ADMIN-9's
    // own link into ADMIN-11.
    await peopleSection.getByRole('link', { name: expectedDisplayName }).click()
    await expect(adminPage).toHaveURL(
      `/platform-admin/users/${studentAccountId}`
    )
    await expect(
      adminPage.getByTestId(`admin-account-detail-${studentAccountId}`)
    ).toContainText(email)

    // 3. Reach the same account a second way — through the console's own
    //    Users screen (ADMIN-10), reached from the nav rather than a typed
    //    address.
    const nav = adminPage.getByRole('navigation', { name: 'Console' })
    await nav.getByRole('link', { name: 'Users' }).click()
    await expect(adminPage).toHaveURL('/platform-admin/users')
    const accountRow = adminPage.getByTestId(
      `admin-account-${studentAccountId}`
    )
    await expect(accountRow).toBeVisible()
    await accountRow.getByRole('link', { name: expectedDisplayName }).click()
    await expect(adminPage).toHaveURL(
      `/platform-admin/users/${studentAccountId}`
    )
  } finally {
    await adminContext.close()
  }
})
