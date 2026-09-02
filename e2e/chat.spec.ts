/**
 * WEB-10, end to end: a signed-in account holds a conversation with a
 * course's assistant in the browser, through the real `apps/api` chat
 * route (`routes/chat.ts`) and the real `@bloombot/core#answerQuestion`
 * pipeline underneath it — the same pipeline `e2e/course-configuration.spec.ts`
 * drives from the Discord side, this time from the web side.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `course-configuration.spec.ts`'s own module comment holds itself to):
 *
 *  - Real: the browser (`pages/Chat.tsx`, `components/ChatMessage.tsx`'s
 *    own sanitized Markdown rendering), a real `apps/api`
 *    (`e2e/support/start-api.ts`), a real throwaway SQLite database, and
 *    `routes/chat.ts`'s own `answerQuestion` call — unmodified, running
 *    against the same database file the browser and `apps/api` just wrote
 *    the course to.
 *  - **Not real**: the model (`e2e/support/fake-model-client.ts`, the same
 *    stand-in `course-configuration.spec.ts` uses — no OpenAI call happens
 *    anywhere in this run). **Not real**: the enrolment that lets this
 *    account ask the course at all — `enrolments.enrolViaRoster` is called
 *    directly, the same "insert the one fact the browser has no screen to
 *    produce yet" device `course-configuration.spec.ts` uses for its own
 *    Discord server binding. `routes/chat.ts`'s own module comment explains
 *    why: reaching this course via the web today requires an enrolment
 *    admitted through *some* existing path (a Discord role, a roster row)
 *    — the join-link/"connect" screen that would let a *student* redeem one
 *    themselves is out of this slice's scope, so this spec proves the chat
 *    surface itself works, seeding the one fact a future slice's own UI
 *    will eventually produce.
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

import { E2E_DATABASE_PATH } from './support/env.js'
import { readSignInToken } from './support/read-sign-in-token.js'

test('a signed-in account holds a conversation with an enrolled course, rendered as sanitized Markdown (WEB-10)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web10-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Intro to Testing — ${suffix}`
  const studentsRole = `students-${suffix}`
  const adminsRole = `admins-${suffix}`

  // 1. Sign in, then define and enable a course through the panel alone —
  //    the same two steps `course-configuration.spec.ts` drives, reused
  //    here rather than duplicated as a fixture.
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(email)
  const token = await readSignInToken(email)
  await page.goto(`/sign-in/${token}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await page.getByRole('button', { name: 'Projects' }).click()
  await page.getByLabel('New project name').fill(projectName)
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('button', { name: projectName }).click()

  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(courseTitle)
  await page.getByLabel('File prefix').fill(`t-${suffix}`)
  await page.getByLabel('Admins role').fill(adminsRole)
  await page.getByLabel('Students role').fill(studentsRole)
  await page
    .getByLabel('Instructions')
    .fill('Answer student questions about the course clearly.')
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible()

  // 2. Seed the one fact the panel has no screen for yet — this account's
  //    own enrolment in the course it just defined (this file's own module
  //    comment explains why).
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
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

    // The same `'web'`-surface identity `routes/chat.ts#resolveCallerPerson`
    // itself resolves for this account — enrolling *that* person, not a
    // freshly invented one, is what makes the browser's own chat request
    // (about to authenticate as this same account) resolve to an active
    // enrolment.
    const person = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'web', externalId: account.id },
      db
    )
    const enrolled = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      db
    )
    if (!enrolled) throw new Error('setup failed: enrolment refused')
  } finally {
    closeDatabase(db)
  }

  // 3. The browser's own part: open Chat, ask something, read the reply —
  //    rendered as Markdown (a heading, bold text), never as raw HTML.
  await page.getByRole('button', { name: 'Chat' }).click()
  await expect(page.getByText(courseTitle)).toBeVisible()

  await page
    .getByLabel('Ask a question')
    .fill('When is the midterm, and what should I read first?')
  await page.getByRole('button', { name: 'Send' }).click()

  const thread = page.getByTestId('chat-thread')
  await expect(thread).toContainText(
    'When is the midterm, and what should I read first?'
  )
  // `e2e/support/start-api.ts`'s own fixed answer, rendered as real
  // Markdown by `components/ChatMessage.tsx` — a `<h1>` and a `<strong>`,
  // not the literal `#`/`**` characters a plain-text render would show.
  await expect(
    thread.getByRole('heading', { level: 1, name: 'Bloombot' })
  ).toBeVisible()
  await expect(thread.locator('strong')).toHaveText('fixture')
  // WEB-10's own safety claim, proven against the real browser this time:
  // no script tag survived into the DOM.
  expect(await thread.locator('script').count()).toBe(0)
})
