/**
 * WEB-63/WEB-64, end to end: an instructor opens a course from the
 * project's own course list, reads its Usage tab, then its Transcripts
 * tab — no project or course picker there, the course is already chosen —
 * filters the transcript by student, and requests an export, all without
 * leaving the course's own screen.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline `usage-panel.spec.ts`'s
 * own module comment holds itself to):
 *
 *  - Real: the browser (`pages/CourseEditor.tsx`, `components/CourseUsage.tsx`,
 *    `components/TranscriptBrowser.tsx`), a real `apps/api`
 *    (`routes/actions.ts`, unmodified), a real throwaway SQLite database,
 *    and the whole round trip for every action this spec dispatches —
 *    `costLedger.organizationUsage`, `transcripts.read`,
 *    `transcripts.listAccessLog` and `transcripts.export`.
 *  - Not real: the student's own message (inserted directly, the same
 *    device `transcript-access-log.spec.ts`'s own module comment already
 *    explains) and the export's own completion — no background worker runs
 *    in this harness (`roster-import-panel.spec.ts`'s own identical note),
 *    so the export this spec requests is proven queued, not collected.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  conversations,
  courses,
  memberships,
  openDatabase,
  people,
  projects,
} from '@bloombot/db'

import { approveCourseForE2e } from './support/approve-course.js'
import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { signIn } from './support/sign-in.js'

test('an instructor reads a course’s own Usage and Transcripts tabs, filters by student, and exports (WEB-63/WEB-64)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const ownerEmail = `owner-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Web Design — ${suffix}`
  const studentDisplayName = `Alice ${suffix}`
  const studentEmail = `alice-${suffix}@example.edu`

  // 1. Sign in and define an enabled course — the same panel-only path
  //    every other spec in this suite establishes.
  await signIn(page, ownerEmail)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await navigateTo(page, 'Projects')
  await page.getByRole('button', { name: 'New project' }).click()
  const newProjectDialog = page.getByRole('dialog', { name: 'New project' })
  await newProjectDialog.getByLabel('Project name').fill(projectName)
  await newProjectDialog.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: projectName, exact: true }).click()

  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(courseTitle)
  await page.getByLabel('Admins role').fill(`admins-wd-${suffix}`)
  await page.getByLabel('Students role').fill(`students-wd-${suffix}`)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()

  // 2. Seed a real conversation, and approve the course — this file's own
  //    module comment on why the message is inserted directly.
  let organizationId: string
  let ownerDisplayName: string
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const ownerAccount = accounts.getAccountByEmail(ownerEmail, db)
    if (!ownerAccount) throw new Error('setup failed: owner account not found')
    ownerDisplayName = ownerAccount.displayName
    const [ownerMembership] = memberships.listMembershipsForAccount(
      ownerAccount.id,
      db
    )
    if (!ownerMembership) throw new Error('setup failed: membership not found')
    organizationId = ownerMembership.organizationId

    const project = projects
      .listProjects(organizationId, db)
      .find((candidate) => candidate.name === projectName)
    if (!project) throw new Error('setup failed: project not found')
    const course = courses
      .listCourses(organizationId, db, { projectId: project.id })
      .find((candidate) => candidate.title === courseTitle)
    if (!course) throw new Error('setup failed: course not found')

    approveCourseForE2e(db, organizationId, course.id)

    const student = people.createPerson(
      organizationId,
      { displayName: studentDisplayName, email: studentEmail },
      db
    )
    const conversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId: course.id, personId: student.id, surface: 'web' },
      db
    )
    if (!conversation) throw new Error('setup failed: conversation')
    conversations.appendMessage(
      organizationId,
      conversation.id,
      { direction: 'from_person', content: 'When is the deadline?' },
      db
    )
  } finally {
    closeDatabase(db)
  }

  // 3. Back on the course's own screen (still open from step 1) — the
  //    Usage tab: no conversation has cost anything yet (WEB-63's own read
  //    scopes to this course, so a `$0.00 · 0 calls` line is this course's
  //    own, not merely the organization's first entry).
  await page.getByRole('tab', { name: 'Usage' }).click()
  await expect(page.getByText(/\$0\.00 · 0 calls/)).toBeVisible()
  // WEB-63: no organization-wide spending-cap form on this tab.
  await expect(page.getByLabel('Spending cap ($)')).toHaveCount(0)

  // 4. The Transcripts tab: no project or course picker — the seeded
  //    message is already there, unfiltered.
  await page.getByRole('tab', { name: 'Transcripts' }).click()
  // `role: 'combobox'`, not `getByLabel` — this screen's own `<section
  // aria-label="Course">` wrapper (unrelated to any picker) otherwise
  // matches a bare `getByLabel('Course')` too.
  await expect(
    page.getByRole('combobox', { name: 'Project', exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole('combobox', { name: 'Course', exact: true })
  ).toHaveCount(0)
  await expect(page.getByText('When is the deadline?')).toBeVisible()

  // 5. Filter by the seeded student — the same reading `transcript-access-log.spec.ts`
  //    already proves an ADMIN-2 event, below.
  await page
    .getByLabel('Student', { exact: true })
    .selectOption({ label: studentDisplayName })
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page.getByText('When is the deadline?')).toBeVisible()

  // Then export (ADMIN-3) — unfiltered: PPL-5 refuses an export filtered to
  // one student unless that student has a verified address
  // (`packages/actions/src/actions/transcripts.ts`'s own module comment),
  // which this spec's directly-inserted person (this file's own module
  // comment on why) never has. No worker runs in this harness, so the
  // export is proven queued, not collected.
  await page
    .getByLabel('Student', { exact: true })
    .selectOption({ label: 'Every student' })
  await page.getByRole('button', { name: 'Export' }).click()
  await expect(page.getByText('Queued…')).toBeVisible()

  // ADMIN-2 — the filtered read above (and the export request) both
  // recorded an audited access-log entry, on this same tab.
  await expect(page.getByRole('heading', { name: 'Access log' })).toBeVisible()
  await expect(
    page.getByText(`${ownerDisplayName} read ${studentDisplayName}`)
  ).toBeVisible()
})
