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
 *    anywhere in this run).
 *  - **Real, since the LINK-1 rework**: the account's own web person — this
 *    spec no longer creates one itself; it looks up the person
 *    `@bloombot/auth`'s real `sign-in.ts` already created and *connected*
 *    the moment sign-in created the account (`docs/DECISIONS.md`), the
 *    exact function `routes/chat.ts` itself resolves the caller with.
 *  - **Still a harness stand-in, and read this part carefully — it does
 *    not prove what an earlier version of this comment claimed**:
 *    `enrolments.enrolViaRoster` is called directly on *that same web
 *    person* (`:130`), not on a `discord`-surface one. That is not the
 *    roster-admission path a real import takes — it enrols the very person
 *    the route resolves, which is the identical tautology
 *    `apps/api/tests/routes/chat.test.ts`'s own `connectCallerTo` helper
 *    was written to escape (its own module comment explains why seeding
 *    an enrolment against the caller's own web person proves nothing about
 *    reachability). What this spec actually proves end to end is narrower:
 *    a signed-in account, once *some* active enrolment exists for the
 *    exact person its own web identity resolves to, can hold a real
 *    conversation through `routes/chat.ts` and `answerQuestion`, rendered
 *    safely. It does not prove a student enrolled through a Discord role or
 *    a roster import — a `discord`-surface person in a *different*
 *    organization than the account's own personal one — can reach that
 *    conversation; nothing in this repository unites the two records yet.
 *    `docs/DECISIONS.md` (D-37) has the fuller account of why that is
 *    correctly deferred, and to which phase.
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
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible()

  // WEB-19/FILE-4: instructions are saved through their own versioned
  // action, offered only once the course exists — see
  // `course-configuration.spec.ts`'s own comment on the same step.
  await page
    .getByLabel('Instructions')
    .fill('Answer student questions about the course clearly.')
  await page.getByRole('button', { name: 'Save instructions' }).click()
  await expect(page.getByText('Current')).toBeVisible()

  // 2. Seed the one fact the panel has no screen for yet — this account's
  //    own enrolment in the course it just defined (this file's own module
  //    comment explains why).
  const db = openDatabase(E2E_DATABASE_PATH)
  // CORE-7/CORE-8 — kept past the `db` connection closing below so step 3
  // can assert the rendered reply never shows it (this file's own module
  // comment on the account's own web identity being keyed on this id).
  let accountId: string
  try {
    const account = accounts.getAccountByEmail(email, db)
    if (!account) throw new Error('setup failed: account not found')
    accountId = account.id
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

    // WEB-10 rework — `@bloombot/auth`'s `sign-in.ts` already created and
    // *connected* this account's own web person the moment sign-in itself
    // created the account (`docs/DECISIONS.md`'s own account of why); this
    // looks that person up (`resolveIdentity`, read-only, the same function
    // `routes/chat.ts#resolveConnectedCallerPerson` itself calls) rather
    // than inventing a second one. Enrolling *that* connected person, not a
    // freshly created one, is what makes the browser's own chat request
    // (about to authenticate as this same account) resolve to an active
    // enrolment.
    const person = people.resolveIdentity(
      organizationId,
      { surface: 'web', externalId: account.id },
      db
    )
    if (!person) throw new Error('setup failed: no connected web person')
    expect(person.connectedAt).not.toBeNull()
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

  // CORE-7/CORE-8 — read this before trusting what it proves (found in
  // review, and worth being blunt about): **this assertion passes with the
  // reported defect fully present.** Confirmed directly — reverting
  // `answer.ts`'s `addressAs` computation to Discord's own mention token
  // for every surface, rebuilding, and rerunning this spec still passes,
  // because `e2e/support/fake-model-client.ts`'s own answer text is a fixed
  // string (this file's own module comment: "not real") that never reads
  // `request.addressAs` at all — nothing a real course's prompt would echo
  // ever reaches this fixture, so a Discord-shaped token genuinely cannot
  // appear here regardless of what `answerQuestion` did. It is *not* a
  // regression test for CORE-7/CORE-8, and must not be read as one.
  //
  // What this assertion actually is: a sanity check that this account's own
  // id, and a literal mention token, are not otherwise leaked somewhere in
  // rendering or serialization independent of the model's answer (a stray
  // debug attribute, an error payload, a log line rendered into the DOM).
  // The genuine, failing-with-the-defect proof lives two layers down, where
  // an echoing model is cheap to build with no shared-fixture collision
  // risk: `packages/core/tests/answer.test.ts`'s own CORE-7/CORE-8 block
  // (`answerQuestion`'s own return value) and
  // `apps/api/tests/routes/chat.test.ts`'s own matching case (the HTTP
  // response body this app actually sends the browser) — both use an
  // `EchoingModelClient` that behaves the way a Discord-tuned course prompt
  // does, and both fail loudly with the defect restored.
  const threadText = await thread.innerText()
  expect(threadText).not.toContain('<@')
  expect(threadText).not.toContain(accountId)
})
