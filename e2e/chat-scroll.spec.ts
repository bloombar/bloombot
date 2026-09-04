/**
 * WEB-24, end to end: `pages/Chat.tsx`'s bounded thread and pinned
 * composer, proven against a real browser laying out real pixels — the one
 * property jsdom cannot see at all. `apps/web/tests/chat.test.tsx`'s own
 * module comment on its "Chat — thread scroll behaviour (WEB-24)" block has
 * the fuller account of what those unit tests could, and could not, prove
 * (the imperative `scrollTop = scrollHeight` action `pages/Chat.tsx` takes,
 * not whether real pixels move, or which element — thread or page — the
 * browser actually scrolls). This file is where those two properties get a
 * real answer.
 *
 * Reuses the same real sign-in → project → course → enable sequence
 * `e2e/chat.spec.ts` (WEB-10) already drives, then seeds a long transcript
 * directly through `@bloombot/db` (`conversations.appendMessage`) rather
 * than sending forty real chat requests through the fake model client —
 * this spec is about layout and scroll position, not about the answering
 * pipeline `chat.spec.ts` already covers end to end.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  conversations,
  courses,
  enrolments,
  memberships,
  openDatabase,
  people,
  projects,
} from '@bloombot/db'

import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { readSignInToken } from './support/read-sign-in-token.js'

/**
 * `window`/`document` — Node's own type lib (this repo's `tsconfig.base.json`
 * carries no `dom` lib, only `ES2023`, matching every other package in this
 * workspace) declares neither, even though every `page.evaluate` callback
 * below runs in the real browser this page controls, not in this test
 * process — the same narrow, deliberate `as` `e2e/join-links-panel.spec.ts`
 * already uses for `navigator.clipboard`. Cast inline, inside each callback
 * — Playwright serializes an `evaluate` callback and re-runs it in the
 * browser, so it cannot close over a helper function defined out here; only
 * `globalThis` itself (a real identifier in both environments) survives the
 * trip.
 */
type BrowserWindow = {
  scrollY: number
  innerWidth: number
  document: { documentElement: { scrollWidth: number } }
}

test('the composer stays reachable without scrolling the page once the thread overflows, and sending scrolls the thread — not the page (WEB-24)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web24-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Intro to Testing — ${suffix}`
  const studentsRole = `students-${suffix}`
  const adminsRole = `admins-${suffix}`

  // 1. Sign in, then define and enable a course through the panel alone —
  //    the same two steps `chat.spec.ts` (WEB-10) already drives, reused
  //    here rather than duplicated as a fixture (that file's own choice,
  //    kept consistent).
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(email)
  const token = await readSignInToken(email)
  await page.goto(`/sign-in/${token}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await navigateTo(page, 'Projects')
  // WEB-27: "New project" opens a modal that asks for the name.
  await page.getByRole('button', { name: 'New project' }).click()
  const newProjectDialog = page.getByRole('dialog', { name: 'New project' })
  await newProjectDialog.getByLabel('Project name').fill(projectName)
  await newProjectDialog.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: projectName, exact: true }).click()

  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(courseTitle)
  await page.getByLabel('File prefix').fill(`t-${suffix}`)
  await page.getByLabel('Admins role').fill(adminsRole)
  await page.getByLabel('Students role').fill(studentsRole)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible()

  // WEB-19/FILE-4: instructions are saved through their own versioned
  // action, offered only once the course exists — without at least one
  // revision, `answerQuestion` declines every request as `not-configured`
  // (the same step `chat.spec.ts`'s own module comment already explains).
  await page
    .getByLabel('Instructions')
    .fill('Answer student questions about the course clearly.')
  await page.getByRole('button', { name: 'Save instructions' }).click()
  await expect(page.getByText('Current')).toBeVisible()

  // 2. Seed this account's own enrolment (the same harness stand-in
  //    `chat.spec.ts`'s own module comment explains in full — not the
  //    roster-admission path a real import takes) and a long transcript —
  //    forty messages, directly through `@bloombot/db`, rather than paying
  //    for forty real chat requests through the fake model client to
  //    reach a scroll-position/layout question that has nothing to do with
  //    the answering pipeline itself.
  const db = openDatabase(E2E_DATABASE_PATH)
  let organizationId: string
  try {
    const account = accounts.getAccountByEmail(email, db)
    if (!account) throw new Error('setup failed: account not found')
    const [membership] = memberships.listMembershipsForAccount(account.id, db)
    if (!membership) throw new Error('setup failed: membership not found')
    organizationId = membership.organizationId

    const project = projects
      .listProjects(organizationId, db)
      .find((candidate) => candidate.name === projectName)
    if (!project) throw new Error('setup failed: project not found')
    const course = courses
      .listCourses(organizationId, db, { projectId: project.id })
      .find((candidate) => candidate.title === courseTitle)
    if (!course) throw new Error('setup failed: course not found')

    const person = people.resolveIdentity(
      organizationId,
      { surface: 'web', externalId: account.id },
      db
    )
    if (!person) throw new Error('setup failed: no connected web person')
    const enrolled = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      db
    )
    if (!enrolled) throw new Error('setup failed: enrolment refused')

    const conversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId: course.id, personId: person.id, surface: 'web' },
      db
    )
    if (!conversation) throw new Error('setup failed: no conversation')

    for (let i = 0; i < 20; i++) {
      conversations.appendMessage(
        organizationId,
        conversation.id,
        {
          direction: 'from_person',
          content: `Question ${i}: is the reading due before or after the lecture?`,
        },
        db
      )
      conversations.appendMessage(
        organizationId,
        conversation.id,
        {
          direction: 'to_person',
          content: `Answer ${i}: before the lecture, as stated on the syllabus.`,
        },
        db
      )
    }
  } finally {
    closeDatabase(db)
  }

  // 3. The browser's own part.
  await navigateTo(page, 'Chat')
  const thread = page.getByTestId('chat-thread')
  await expect(thread).toContainText('Question 19')

  // WEB-24 — the reported defect, made explicit: the composer is reachable
  // without scrolling the *page*, even with a forty-message thread behind
  // it. Fails without the fix: before the thread had a maximum height, this
  // exact transcript overflowed the page itself, and the composer sat below
  // the bottom of the viewport until the whole page was scrolled down.
  expect(
    await page.evaluate(() => (globalThis as unknown as BrowserWindow).scrollY)
  ).toBe(0)
  const composer = page.getByLabel('Ask a question')
  await expect(composer).toBeInViewport()

  // The thread itself opened at its own newest message, not its first —
  // `scrollHeight - clientHeight` is the most a container can scroll;
  // landing near that maximum (not `scrollTop === 0`) is what "follows the
  // conversation" means for the initial render, and confirms the thread
  // really did overflow its own box (a thread that fit entirely would
  // report `max <= 0`).
  const initialScroll = await thread.evaluate((el) => ({
    scrollTop: el.scrollTop,
    max: el.scrollHeight - el.clientHeight,
  }))
  expect(initialScroll.max).toBeGreaterThan(0)
  expect(initialScroll.scrollTop).toBeGreaterThanOrEqual(initialScroll.max - 4)

  // Sending a message scrolls the thread further still, not the page.
  await composer.fill('One more question, asked from the browser itself.')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(thread).toContainText(
    'One more question, asked from the browser itself.'
  )
  // Waits for the assistant's own reply to render too (`e2e/support/start-api.ts`'s
  // fixed fixture answer, the same one `chat.spec.ts` asserts on) before
  // reading the scroll invariant below — otherwise this check can race the
  // reply's own `setMessages` update, which grows `scrollHeight` again and
  // re-triggers the auto-scroll a second time after this test's own
  // snapshot already read a stale, smaller `max`.
  await expect(
    thread.getByRole('heading', { level: 1, name: 'Bloombot' }).last()
  ).toBeVisible()
  expect(
    await page.evaluate(() => (globalThis as unknown as BrowserWindow).scrollY)
  ).toBe(0)
  const afterSendScroll = await thread.evaluate((el) => ({
    scrollTop: el.scrollTop,
    max: el.scrollHeight - el.clientHeight,
  }))
  expect(afterSendScroll.scrollTop).toBeGreaterThanOrEqual(
    afterSendScroll.max - 4
  )

  // The composer never covers the last message — a real bounding-box
  // comparison against the actual last message in the thread (the
  // assistant's own reply, by now — `[data-testid^="chat-message-"]` covers
  // both roles, `components/ChatMessage.tsx`'s own `chat-message-${role}`),
  // not merely "both happen to be visible."
  const lastMessage = page.locator('[data-testid^="chat-message-"]').last()
  const messageBox = await lastMessage.boundingBox()
  const composerBox = await composer.boundingBox()
  if (!messageBox || !composerBox) {
    throw new Error(
      'expected both the last message and the composer to have a real layout box'
    )
  }
  expect(messageBox.y + messageBox.height).toBeLessThanOrEqual(composerBox.y)

  // WEB-24: no horizontal scroll at a narrow width — resized last, since a
  // viewport change forces a relayout that would otherwise perturb the
  // scroll-position assertions above.
  await page.setViewportSize({ width: 375, height: 700 })
  await expect(composer).toBeVisible()
  const overflowsHorizontally = await page.evaluate(() => {
    const win = globalThis as unknown as BrowserWindow
    return win.document.documentElement.scrollWidth > win.innerWidth
  })
  expect(overflowsHorizontally).toBe(false)
})
