/**
 * WEB-18/FILE-1..3: the knowledge-files screen, driven the way a real
 * instructor actually reaches it — sign in, open a course, upload a file,
 * watch it become ready, and see it listed; then a second file the
 * provider rejects, and the course must not read as configured while it
 * is ungrounded (FILE-2). `.claude/CLAUDE.md`'s own warning about this
 * project's history is the reason this spec exists at all: a test that
 * seeds data the way the implementation resolves it, rather than the way
 * production produces it, proves nothing about whether an instructor can
 * actually do this.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `course-configuration.spec.ts`'s own module comment holds itself to):
 *
 *  - Real: the browser (`pages/CourseEditor.tsx`,
 *    `components/CourseAttachments.tsx`), a real `apps/api`
 *    (`e2e/support/start-api.ts`), a real throwaway SQLite database, and
 *    every action this UI drives — `courses.save`, `courseAttachments.attach`,
 *    `.list`, `.detach` — reached exactly the way any other caller reaches
 *    them. The uploaded bytes are written to a real, throwaway
 *    `AttachmentStorage` directory (`E2E_ATTACHMENT_STORAGE_DIR`) by the
 *    action itself, the same as production.
 *  - Real: `apps/worker`'s own handlers
 *    (`createAttachCourseAttachmentHandler`/`createDetachCourseAttachmentHandler`)
 *    and `@bloombot/jobs`'s own `runNextJob` — the actual claim/run
 *    machinery, unmodified, run against the same database file `apps/api`
 *    just wrote to.
 *  - **Not real, and this is the harness's own stand-in, not `apps/worker`'s**:
 *    no `apps/worker` *process* runs continuously in this harness (this
 *    repository's e2e harness runs one API process and one web process
 *    only — `start-api.ts`'s own module comment on `ADMIN-4` says the same
 *    for the bot and worker health checks). `runOneWorkerJob` below calls
 *    the same handler and runner directly, in this test process, the exact
 *    "reuse the app's own factory rather than run the app" device
 *    `start-api.ts` itself already uses for `apps/api`, and
 *    `course-configuration.spec.ts` uses for `@bloombot/discord`'s
 *    `handleMention` standing in for a live bot.
 *  - **Not real**: the provider. `e2e/support/fake-openai-files-server.ts`
 *    is a loopback fake of OpenAI's Files/Vector Stores endpoints — no
 *    OpenAI call happens anywhere in this run (MDL-7's "no test may reach
 *    OpenAI").
 *
 * So this test proves: a file uploaded entirely through the panel is
 * written, queued, and — once a worker claims the job, whether that
 * worker is running continuously or (as here) claims it once — uploaded,
 * attached to the course's own vector store, and reported back to the
 * panel as ready; and a file the provider rejects is reported back as
 * failed, with its own reason, never silently read as configured.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  courseAttachments,
  courses,
  createFilesystemAttachmentStorage,
  memberships,
  openDatabase,
  projects,
  type Database,
} from '@bloombot/db'
import { HandlerRegistry, runNextJob, type RetryPolicy } from '@bloombot/jobs'
import type { FilesHttpOptions } from '@bloombot/openai'

import {
  createAttachCourseAttachmentHandler,
  createDetachCourseAttachmentHandler,
} from '../apps/worker/src/handlers/course-attachments.js'
import { E2E_ATTACHMENT_STORAGE_DIR, E2E_DATABASE_PATH } from './support/env.js'
import { FakeOpenAiFilesServer } from './support/fake-openai-files-server.js'
import { navigateTo } from './support/navigate.js'
import { readSignInToken } from './support/read-sign-in-token.js'

const RETRY_POLICY: RetryPolicy = { baseDelayMs: 1000, backoffFactor: 2 }

/**
 * Claims and runs exactly one `courseAttachments.attach`/`.detach` job
 * against the e2e database — this spec's own stand-in for a live
 * `apps/worker` process (this file's own module comment has the full
 * reasoning). A fresh `HandlerRegistry` every call, scoped to only these
 * two job kinds, so `claimNextJob` (`@bloombot/jobs`) can never reach past
 * them to a job kind another spec's own fixtures happened to leave queued.
 *
 * Retries a few times, a short real delay apart, before giving up — the
 * same "poll until something is there" a live `apps/worker`'s own loop
 * does (`createWorkerLoop`), not a workaround for a bug: the browser's own
 * `fetch` to enqueue a job (`attachCourseFile`/`detachCourseAttachment`)
 * resolves once `apps/api`'s response is on the wire, which can land a few
 * milliseconds before this test process's own next line runs — a single,
 * un-retried claim caught this race directly (`outcome: 'empty'`) the
 * first time this spec ran three times in a row.
 */
async function claimAndRunJob(
  db: Database,
  openaiServer: FakeOpenAiFilesServer
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await runOneWorkerJob(db, openaiServer)
    if (result.outcome !== 'empty') return result
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('claimAndRunJob: no eligible job appeared within 2s')
}

async function runOneWorkerJob(
  db: Database,
  openaiServer: FakeOpenAiFilesServer
) {
  const openaiHttpOptions: FilesHttpOptions = {
    fetchFn: fetch,
    baseUrl: openaiServer.baseUrl,
    apiKey: 'e2e-unused-key',
    timeoutMs: 5000,
  }
  const attachmentStorage = createFilesystemAttachmentStorage(
    E2E_ATTACHMENT_STORAGE_DIR
  )
  const handlers = new HandlerRegistry()
  handlers.register(
    'courseAttachments.attach',
    createAttachCourseAttachmentHandler({
      openaiHttpOptions,
      attachmentStorage,
    })
  )
  handlers.register(
    'courseAttachments.detach',
    createDetachCourseAttachmentHandler({
      openaiHttpOptions,
      attachmentStorage,
    })
  )
  return runNextJob({
    db,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    handlers,
    owner: 'e2e-worker',
    leaseMs: 60_000,
    handlerTimeoutMs: 60_000,
    retryPolicy: RETRY_POLICY,
  })
}

test('an instructor uploads a file, watches it become ready, and sees it listed — a rejected upload is reported as failed, not configured (WEB-18, FILE-1..3)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web18-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Web Design — ${suffix}`

  const openaiServer = await FakeOpenAiFilesServer.start()
  try {
    // 1. Sign in, create a project and a course — the same panel-only path
    //    `course-configuration.spec.ts` already proves for CFG-2..4.
    await page.goto('/')
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
    await expect(page.getByTestId('link-requested')).toContainText(email)
    const token = await readSignInToken(email)
    await page.goto(`/sign-in/${token}`)
    await expect(page.getByTestId('organization-switcher')).toBeVisible()

    await navigateTo(page, 'Projects')
    await page.getByLabel('New project name').fill(projectName)
    await page.getByRole('button', { name: 'Create project' }).click()
    await page.getByRole('button', { name: projectName }).click()

    await page.getByRole('button', { name: 'New course' }).click()
    await page.getByLabel('Title').fill(courseTitle)
    await page.getByLabel('File prefix').fill(`wd-${suffix}`)
    await page.getByLabel('Admins role').fill(`admins-wd-${suffix}`)
    await page.getByLabel('Students role').fill(`students-wd-${suffix}`)
    await page.getByRole('button', { name: 'Save course' }).click()

    // WEB-18: the knowledge-files screen only appears once the course
    // actually has an id — the same "existing record only" gate the
    // Discord channels section already uses.
    await expect(
      page.getByRole('heading', { name: 'Knowledge files' })
    ).toBeVisible()
    await expect(page.getByText('No files attached yet.')).toBeVisible()

    // 2. Upload a syllabus — a real multipart-free, base64 action call,
    //    written to a real, throwaway AttachmentStorage directory.
    openaiServer.respondToFiles({ status: 200, body: { id: 'file_syllabus' } })
    openaiServer.respondToVectorStoreCreate({
      status: 200,
      body: { id: `vs_${suffix}` },
    })
    openaiServer.respondToVectorStoreFileAttach({
      status: 200,
      body: { status: 'completed' },
    })

    // The label names the drop zone (a real button, so the keyboard reaches
    // it); the picker behind it is the `input[type=file]`, which is what
    // Playwright sets files on. Scoped to this component's own container
    // (`data-testid="course-attachments"`) since WEB-21's own roster-import
    // drop zone renders a second, identically-shaped `input[type=file]`
    // once this course exists — an unscoped locator is ambiguous the
    // moment both are on screen.
    await page
      .getByTestId('course-attachments')
      .locator('input[type="file"]')
      .setInputFiles({
        name: 'syllabus.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4 e2e fixture'),
      })
    await page.getByRole('button', { name: 'Attach file' }).click()
    await expect(page.getByText('syllabus.pdf')).toBeVisible()
    await expect(page.getByText('Pending…')).toBeVisible()

    // 3. This is where the browser's own part pauses — no live worker
    //    claims the job in this harness (this file's own module comment),
    //    so this spec claims and runs it itself, once, the same handler
    //    and runner `apps/worker` itself uses.
    const db = openDatabase(E2E_DATABASE_PATH)
    try {
      const attachResult = await claimAndRunJob(db, openaiServer)
      expect(attachResult.outcome).toBe('succeeded')

      // 4. Back in the browser: the panel's own poll picks up the change —
      //    nothing here forces a reload.
      await expect(page.getByText('Ready — grounding answers.')).toBeVisible({
        timeout: 10_000,
      })

      // The account's own organization/course, read back directly — proves
      // the course actually adopted the freshly created store (D-3/D-32),
      // not merely that the panel says "Ready."
      const account = accounts.getAccountByEmail(email, db)
      if (!account) throw new Error('setup failed: account not found')
      const [membership] = memberships.listMembershipsForAccount(account.id, db)
      if (!membership) throw new Error('setup failed: membership not found')
      const organizationId = membership.organizationId
      const project = projects
        .listProjects(organizationId, db)
        .find((candidate) => candidate.name === projectName)
      if (!project) throw new Error('setup failed: project not found')
      const course = courses
        .listCourses(organizationId, db, { projectId: project.id })
        .find((candidate) => candidate.title === courseTitle)
      if (!course) throw new Error('setup failed: course not found')
      expect(course.vectorStoreId).toBe(`vs_${suffix}`)
      const readyAttachments = courseAttachments.listAttachmentsForCourse(
        organizationId,
        course.id,
        db
      )
      expect(readyAttachments).toHaveLength(1)
      expect(readyAttachments[0]?.status).toBe('ready')

      // 5. Detach it — WEB-18: reaches the provider and cannot be undone,
      //    so it confirms through the shared modal primitive.
      openaiServer.respondToVectorStoreFileDelete({
        status: 200,
        body: { deleted: true },
      })
      openaiServer.respondToFileDelete({ status: 200, body: { deleted: true } })

      await page.getByRole('button', { name: 'Detach syllabus.pdf' }).click()
      const detachDialog = page.getByRole('dialog', {
        name: 'Detach "syllabus.pdf"?',
      })
      await expect(detachDialog).toBeVisible()
      await detachDialog.getByRole('button', { name: 'Detach' }).click()
      await expect(page.getByText('Removing…')).toBeVisible()

      const detachResult = await claimAndRunJob(db, openaiServer)
      expect(detachResult.outcome).toBe('succeeded')

      await expect(page.getByText('No files attached yet.')).toBeVisible({
        timeout: 10_000,
      })
      expect(
        courseAttachments.listAttachmentsForCourse(
          organizationId,
          course.id,
          db
        )
      ).toHaveLength(0)

      // 6. FILE-2: a second upload the provider rejects must not leave the
      //    course looking configured — it reads plainly as failed, with
      //    the provider's own reason, and `courses.vectorStoreId` is
      //    untouched (D-32).
      openaiServer.respondToFiles({
        status: 400,
        body: { error: { message: 'unsupported file type' } },
      })

      // The label names the drop zone (a real button, so the keyboard reaches
      // it); the picker behind it is the `input[type=file]`, which is what
      // Playwright sets files on.
      await page
        .getByTestId('course-attachments')
        .locator('input[type="file"]')
        .setInputFiles({
          name: 'notes.exe',
          mimeType: 'application/octet-stream',
          buffer: Buffer.from('not actually notes'),
        })
      await page.getByRole('button', { name: 'Attach file' }).click()
      await expect(page.getByText('notes.exe')).toBeVisible()

      const failedResult = await claimAndRunJob(db, openaiServer)
      expect(failedResult.outcome).toBe('succeeded')

      await expect(page.getByText('Failed.')).toBeVisible({ timeout: 10_000 })
      await expect(page.getByText('unsupported file type')).toBeVisible()

      const finalCourse = courses.getCourse(organizationId, course.id, db)
      // The store this test itself created and then detached every file
      // from stays set (D-32's own documented "stays set" choice) — the
      // point under test here is that the *rejected* upload never touched
      // it, which a value unchanged from the prior assertion already
      // proves either way.
      expect(finalCourse?.vectorStoreId).toBe(`vs_${suffix}`)
    } finally {
      closeDatabase(db)
    }
  } finally {
    await openaiServer.stop()
  }
})
