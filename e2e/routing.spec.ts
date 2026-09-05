/**
 * WEB-32/WEB-34, end to end: the panel's own canonical URLs, against a real
 * browser and a real `apps/api`, the same harness
 * `projects-row-menus.spec.ts`/`chat.spec.ts` already use (their own module
 * comments have the fuller "what is real, what is a harness stand-in"
 * account, unchanged here). Covers exactly what unit tests cannot: that the
 * *real* address bar, browser history and a real page reload all agree with
 * what `routing/route.ts` and `pages/Shell.tsx` claim.
 *
 *  - a cold load of a deep course URL renders that course directly, with no
 *    prior in-panel navigation;
 *  - navigating in the panel (a project row, a course row, "back") changes
 *    the address bar to match;
 *  - the browser's own Back button returns to the previous screen, not a
 *    dead end or the sign-in screen;
 *  - a reload holds the panel's place, rather than bouncing back to a
 *    default screen;
 *  - an address naming nothing this panel recognises renders the not-found
 *    screen, with a working way back home — never an empty shell.
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
import { readSignInToken } from './support/read-sign-in-token.js'

/** Signs a fresh account in through the real emailed-link flow (TEN-1: this is what creates its own personal organization). */
async function signInFreshAccount(
  page: import('@playwright/test').Page,
  email: string
): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(email)
  const token = await readSignInToken(email)
  await page.goto(`/sign-in/${token}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()
}

/** The personal organization TEN-1 creates for a fresh account's own first sign-in, read back directly — the same `memberships.listMembershipsForAccount` lookup `projects-row-menus.spec.ts`'s own setup uses. */
function findPersonalOrganizationId(email: string): string {
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const account = accounts.getAccountByEmail(email, db)
    if (!account) throw new Error('setup failed: account not found')
    const [membership] = memberships.listMembershipsForAccount(account.id, db)
    if (!membership) throw new Error('setup failed: no personal organization')
    return membership.organizationId
  } finally {
    closeDatabase(db)
  }
}

/** A project with one enabled course, seeded directly against the e2e database — the same "an instructor already set this up" stand-in `projects-row-menus.spec.ts`'s own course seeding uses, rather than driving the create-project/create-course UI a second time for a slice that is not about that UI. */
function seedProjectAndCourse(
  organizationId: string,
  suffix: string
): { projectId: string; courseId: string; courseTitle: string } {
  const courseTitle = `Intro to Testing — ${suffix}`
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const project = projects.createProject(
      organizationId,
      { name: `Fall 2026 — ${suffix}` },
      db
    )
    const created = courses.createCourse(
      organizationId,
      {
        projectId: project.id,
        title: courseTitle,
        filePrefix: `t-${suffix}`,
        enabled: true,
        adminsRole: `admins-${suffix}`,
        studentsRole: `students-${suffix}`,
        promptId: 'prompt-1',
        categories: [],
      },
      db
    )
    if (!created.ok) throw new Error('setup failed: course creation refused')
    return {
      projectId: project.id,
      courseId: created.course.id,
      courseTitle,
    }
  } finally {
    closeDatabase(db)
  }
}

test('a cold load of a deep course URL renders that course, panel navigation and browser back both update the address, and a reload holds place (WEB-32, WEB-34)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web32-${suffix}@example.edu`

  await signInFreshAccount(page, email)
  const organizationId = findPersonalOrganizationId(email)

  const { projectId, courseId, courseTitle } = seedProjectAndCourse(
    organizationId,
    suffix
  )
  const projectName = `Fall 2026 — ${suffix}`

  // 1. A cold load of the course's own deep address — no prior navigation
  //    in this tab at all — renders that exact course, in that
  //    organization, directly.
  await page.goto(
    `/o/${organizationId}/projects/${projectId}/courses/${courseId}`
  )
  await expect(
    page.getByRole('heading', { name: courseTitle, level: 1 })
  ).toBeVisible()
  await expect(page.getByLabel('Title')).toHaveValue(courseTitle)

  // 2. Navigating in the panel — its own "back to the project" control —
  //    changes the address bar to that project's own courses address.
  await page.getByRole('button', { name: `← ${projectName}` }).click()
  await expect(page).toHaveURL(`/o/${organizationId}/projects/${projectId}`)
  await expect(
    page.getByRole('heading', { name: projectName, level: 1 })
  ).toBeVisible()

  // Into the course again, from its own row this time — the address moves
  // forward to the course's own address once more.
  await page.getByRole('button', { name: courseTitle, exact: true }).click()
  await expect(page).toHaveURL(
    `/o/${organizationId}/projects/${projectId}/courses/${courseId}`
  )
  await expect(
    page.getByRole('heading', { name: courseTitle, level: 1 })
  ).toBeVisible()

  // 3. The browser's own Back button returns to the previous screen — the
  //    project's own courses list — not a dead end, and not signed out.
  await page.goBack()
  await expect(page).toHaveURL(`/o/${organizationId}/projects/${projectId}`)
  await expect(
    page.getByRole('heading', { name: projectName, level: 1 })
  ).toBeVisible()

  // 4. A reload holds the panel's place — still the same courses screen,
  //    not bounced back to the Projects list or any other default.
  await page.reload()
  await expect(
    page.getByRole('heading', { name: projectName, level: 1 })
  ).toBeVisible()
  await expect(page.getByText(courseTitle)).toBeVisible()
})

test('an address naming nothing this panel recognises renders the not-found screen, with a working way home (WEB-32)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web32-nf-${suffix}@example.edu`

  await signInFreshAccount(page, email)
  const organizationId = findPersonalOrganizationId(email)

  // A path this router does not recognise at all.
  await page.goto('/this-is-not-a-real-page')
  await expect(page.getByTestId('not-found-page')).toBeVisible()
  await page.getByRole('button', { name: 'Go home' }).click()
  await expect(page).toHaveURL(`/o/${organizationId}/projects`)

  // An organization-scoped address naming an organization this account has
  // no relationship to at all — never a leak of whether it exists.
  await page.goto('/o/00000000-0000-0000-0000-000000000000/projects')
  await expect(page.getByTestId('not-found-page')).toBeVisible()
})

test("the browser's own Back button asks before leaving a dirty course form, and honours the answer (WEB-34, WEB-16)", async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web34-guard-${suffix}@example.edu`

  await signInFreshAccount(page, email)
  const organizationId = findPersonalOrganizationId(email)
  const { projectId, courseId, courseTitle } = seedProjectAndCourse(
    organizationId,
    suffix
  )
  const projectName = `Fall 2026 — ${suffix}`

  // Open the course from its project, so there is a real previous entry for
  // Back to return to, and make the form dirty.
  await page.goto(`/o/${organizationId}/projects/${projectId}`)
  await page.getByRole('button', { name: courseTitle, exact: true }).click()
  await expect(page).toHaveURL(
    `/o/${organizationId}/projects/${projectId}/courses/${courseId}`
  )
  await page.getByLabel('Title').fill(`${courseTitle} (edited)`)

  // Back, refused: the confirmation appears, "Keep editing" leaves the
  // editor exactly where it was — the edit still in the field, the address
  // still the course's own.
  await page.goBack()
  await expect(
    page.getByRole('heading', { name: 'Discard unsaved changes?' })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Keep editing' }).click()
  await expect(page).toHaveURL(
    `/o/${organizationId}/projects/${projectId}/courses/${courseId}`
  )
  await expect(page.getByLabel('Title')).toHaveValue(`${courseTitle} (edited)`)

  // Back again, confirmed this time: now it leaves, and lands on the screen
  // Back actually named. Without the guard in `routing/useRoute.ts` the
  // first Back above would have done this silently, discarding the edit
  // with nothing asked.
  await page.goBack()
  await expect(
    page.getByRole('heading', { name: 'Discard unsaved changes?' })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Discard changes' }).click()
  await expect(page).toHaveURL(`/o/${organizationId}/projects/${projectId}`)
  await expect(
    page.getByRole('heading', { name: projectName, level: 1 })
  ).toBeVisible()
})
