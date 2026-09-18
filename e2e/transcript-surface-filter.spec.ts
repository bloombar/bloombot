/**
 * WEB-66, end to end: a course whose transcript carries messages from two
 * surfaces — filtering the Transcripts screen to one narrows what is
 * shown, and a requested export carries the same filter.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `transcript-access-log.spec.ts`'s own module comment holds itself to):
 *
 *  - Real: the browser (`pages/Transcripts.tsx`,
 *    `components/TranscriptBrowser.tsx`), a real `apps/api`
 *    (`routes/actions.ts`, unmodified), a real throwaway SQLite database,
 *    and the whole round trip for `transcripts.read`/`.export` — the
 *    filter this spec applies is the one the server actually narrows its
 *    own query by, not a client-side hide.
 *  - Not real: the two seeded messages (inserted directly, the same device
 *    `transcript-access-log.spec.ts`'s own module comment already explains)
 *    and the export's own completion — no background worker runs in this
 *    harness (`course-usage-transcripts-tabs.spec.ts`'s own identical
 *    note), so this spec reads the requested export's own row back from
 *    the database directly, rather than waiting for a file.
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
  schema,
} from '@bloombot/db'
import { eq } from 'drizzle-orm'

import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { signIn } from './support/sign-in.js'

test('a surface filter narrows a course transcript, and a requested export carries it (WEB-66)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const ownerEmail = `owner-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Web Design — ${suffix}`
  const studentDisplayName = `Alice ${suffix}`

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

  // 2. Seed two real messages from the same student, on two different
  //    surfaces — this file's own module comment on why they are inserted
  //    directly.
  let organizationId: string
  let courseId: string
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const ownerAccount = accounts.getAccountByEmail(ownerEmail, db)
    if (!ownerAccount) throw new Error('setup failed: owner account not found')
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
    courseId = course.id

    const student = people.createPerson(
      organizationId,
      { displayName: studentDisplayName },
      db
    )

    const webConversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId: course.id, personId: student.id, surface: 'web' },
      db
    )
    if (!webConversation) throw new Error('setup failed: web conversation')
    conversations.appendMessage(
      organizationId,
      webConversation.id,
      {
        direction: 'from_person',
        content: 'Asked over the web panel',
        surface: 'web',
      },
      db
    )

    const discordConversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId: course.id, personId: student.id, surface: 'discord' },
      db
    )
    if (!discordConversation) {
      throw new Error('setup failed: discord conversation')
    }
    conversations.appendMessage(
      organizationId,
      discordConversation.id,
      {
        direction: 'from_person',
        content: 'Asked over Discord',
        surface: 'discord',
      },
      db
    )
  } finally {
    closeDatabase(db)
  }

  // 3. Both messages show up unfiltered.
  await navigateTo(page, 'Transcripts')
  await page
    .getByLabel('Project', { exact: true })
    .selectOption({ label: projectName })
  await page.getByLabel('Course').selectOption({ label: courseTitle })
  await expect(page.getByText('Asked over the web panel')).toBeVisible()
  await expect(page.getByText('Asked over Discord')).toBeVisible()

  // 4. The surface filter, between Student and From — narrows the read,
  //    applied by the server (WEB-66's own text: "not by hiding rows in
  //    the browser").
  await page.getByLabel('Surface').selectOption({ label: 'Discord' })
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page.getByText('Asked over Discord')).toBeVisible()
  await expect(page.getByText('Asked over the web panel')).toHaveCount(0)

  // 5. Requesting an export carries the same filter onto the pending row —
  //    read back directly, since no worker runs in this harness
  //    (this file's own module comment).
  await page.getByRole('button', { name: 'Export' }).click()
  await expect(page.getByText('Queued…')).toBeVisible()

  const verifyDb = openDatabase(E2E_DATABASE_PATH)
  try {
    const exportRow = verifyDb
      .select()
      .from(schema.transcriptExports)
      .where(eq(schema.transcriptExports.courseId, courseId))
      .get()
    expect(exportRow?.surface).toBe('discord')
  } finally {
    closeDatabase(verifyDb)
  }
})
