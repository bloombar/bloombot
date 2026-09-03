/**
 * COST-4, end to end: an instructor sees their courses' usage and which
 * students are approaching their limits, from the panel's own Usage
 * screen — not a log file, not a query.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline `chat.spec.ts`'s
 * own module comment holds itself to):
 *
 *  - Real: the browser (`pages/Chat.tsx`, `pages/Usage.tsx`), a real
 *    `apps/api` (`routes/chat.ts`, `routes/actions.ts`, both unmodified), a
 *    real throwaway SQLite database, and `answerQuestion`'s own cost
 *    recording (`@bloombot/core`) and daily-count increment
 *    (`@bloombot/db`'s `usage.ts`) — both genuinely written by the one
 *    chat message this spec sends, not seeded directly.
 *  - Not real: the model (`e2e/support/fake-model-client.ts`, the same
 *    stand-in `chat.spec.ts` uses — no OpenAI call happens anywhere in
 *    this run). `FakeModelClient` reports no token usage, so the cost
 *    this spec reads back is `@bloombot/core#pricing.ts`'s own estimate
 *    (COST-6) — real money was still "spent" by this platform's own
 *    accounting, just not a real provider bill. **Rework finding:** a
 *    single fixture-sized reply prices under a cent (a real run recorded
 *    `cost_micros: 133`) — `pages/Usage.tsx#formatMicros` rounds to two
 *    decimal places, so the panel legitimately still shows `$0.00` for
 *    it, and a `toContainText` assertion against that display cannot
 *    tell "priced at a genuine sub-cent amount" apart from "priced at
 *    `0`, the exact bug the pricing table below exists to close" —
 *    proven directly here: deleting `pricing: getModelPricingTable()`
 *    from `e2e/support/start-api.ts` left every assertion in this file
 *    passing. Step 5, below, reads `cost_ledger_entries.cost_micros`
 *    back from the database instead, the same directness
 *    `spending-cap.spec.ts` already uses for `spending_cap_micros`.
 *  - **Same LINK-1/enrolment caveat `chat.spec.ts`'s own module comment
 *    states** — `enrolments.enrolViaRoster` is called on the account's own
 *    connected web person, not a `discord`-surface one; see that spec's
 *    own comment for exactly what this does and does not prove about
 *    reachability. What this spec adds beyond it is COST-4's own claim:
 *    once that conversation happens, its cost and its count both show up
 *    on the instructor's own Usage screen, without reading the database at
 *    all.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  costLedger,
  courses,
  enrolments,
  memberships,
  openDatabase,
  people,
  projects,
} from '@bloombot/db'

import { E2E_DATABASE_PATH } from './support/env.js'
import { readSignInToken } from './support/read-sign-in-token.js'

test("an instructor sees their course's spend and a student approaching its daily limit, from the Usage screen (COST-4)", async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `cost4-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Intro to Testing — ${suffix}`
  const studentsRole = `students-${suffix}`
  const adminsRole = `admins-${suffix}`

  // 1. Sign in, then define and enable a course — the same panel-only path
  //    `chat.spec.ts` already establishes. `maxRequestsPerDay: 1` is
  //    deliberate: one question is then already at 100% of the course's own
  //    daily allowance, comfortably over `listUsageNearLimit`'s own 80%
  //    threshold (`@bloombot/db`'s `usage.ts`), so this spec needs only one
  //    real conversation to reach both halves of COST-4 at once.
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
  await page.getByLabel('Max requests per day').fill('1')
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible()

  // WEB-19/FILE-4: a course with neither a promptId nor instructions is
  // declined outright by `answerQuestion` (`chat.spec.ts`'s own identical
  // step) — this course needs something to actually answer against before
  // step 4 below asks it anything.
  await page
    .getByLabel('Instructions')
    .fill('Answer student questions about the course clearly.')
  await page.getByRole('button', { name: 'Save instructions' }).click()
  await expect(page.getByText('Current')).toBeVisible()

  // 2. Before any conversation, the Usage screen shows this course at
  //    zero, and nobody near a limit. Scoped to the "Usage by course"
  //    region (`Usage.tsx`'s own `aria-label`), not a bare
  //    `page.getByText(courseTitle)` — once a student is near the limit
  //    (step 5, below), the same course title appears a second time in the
  //    near-limit list, and an unscoped locator would be ambiguous between
  //    the two.
  await page.getByRole('button', { name: 'Usage' }).click()
  await expect(
    page.getByRole('heading', { name: 'Usage', exact: true })
  ).toBeVisible()
  const usageByCourse = page.getByRole('region', { name: 'Usage by course' })
  const nearLimit = page.getByRole('region', {
    name: 'Students approaching their limit today',
  })
  await expect(usageByCourse).toContainText(courseTitle)
  await expect(usageByCourse).toContainText('$0.00 · 0 calls')
  await expect(nearLimit).toContainText(
    "Nobody is close to a course's own daily limit today."
  )

  // 3. Seed the one fact the panel has no screen for yet — this account's
  //    own enrolment in the course it just defined (`chat.spec.ts`'s own
  //    module comment explains why this, not a fresh person, is what makes
  //    the browser's own chat request resolve to an active enrolment).
  let personId: string
  // Hoisted out of the `try` block below: step 5 reads the ledger back
  // directly by this same id, the way `spending-cap.spec.ts` already reads
  // `spending_cap_micros` back directly rather than trusting the panel's
  // own display.
  let organizationId: string
  const db = openDatabase(E2E_DATABASE_PATH)
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
    personId = person.id
    const enrolled = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      db
    )
    if (!enrolled) throw new Error('setup failed: enrolment refused')
  } finally {
    closeDatabase(db)
  }

  // 4. One real conversation, through the chat surface — costs something
  //    real (COST-6's own estimate, this spec's own module comment) and
  //    counts against the course's own daily allowance of 1.
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
  // The reply itself, not only the optimistic echo of the question
  // (`pages/Chat.tsx`'s own module comment: the student's own message
  // renders immediately, before the request has even resolved) — waiting
  // for `e2e/support/start-api.ts`'s own fixed answer is what proves the
  // request actually completed, and the cost this spec reads back next was
  // genuinely recorded, not merely that a bubble appeared client-side.
  // Not the `# Bloombot` heading `chat.spec.ts` itself waits for:
  // `maxRequestsPerDay: 1` (this spec's own deliberate choice, above) makes
  // this the day's *last* request too, so `answerQuestion` prepends
  // CORE-3's own last-request notice ahead of the fixture's answer
  // (`@bloombot/core#answer.ts`'s own `withLastRequestNotice`) — `#
  // Bloombot` no longer starts its own line once that prefix lands ahead
  // of it, so it never parses as a heading. The bold `fixture` text still
  // does, regardless of what precedes it.
  await expect(thread.locator('strong')).toHaveText('fixture')

  // 5. Back on the Usage screen: this course's own call count moved from 0
  //    to 1 — real, visible proof a conversation was recorded. The dollar
  //    figure next to it is not a reliable signal for *this* assertion
  //    (this file's own module comment on why: a single fixture-sized
  //    reply prices under a cent, and `formatMicros` rounds to two decimal
  //    places, so `$0.00` here is not the bug this spec exists to catch).
  await page.getByRole('button', { name: 'Usage' }).click()
  await expect(usageByCourse).toContainText(courseTitle)
  await expect(usageByCourse).toContainText('1 call')
  await expect(usageByCourse).not.toContainText('0 calls')

  // What actually proves COST-6's own estimate priced this call rather
  // than leaving it free: the ledger row itself, read back directly —
  // never `0`, the exact value `e2e/support/start-api.ts`'s own
  // `NO_PRICING_CONFIGURED` fallback would have recorded before its
  // `pricing:` field was wired through.
  const usageReadDb = openDatabase(E2E_DATABASE_PATH)
  let recordedCostMicros: number
  try {
    recordedCostMicros = costLedger.getOrganizationSpentMicros(
      organizationId,
      usageReadDb
    )
  } finally {
    closeDatabase(usageReadDb)
  }
  expect(recordedCostMicros).toBeGreaterThan(0)

  // 6. And the student who just asked is now shown as approaching the
  //    course's own daily limit — by person id, never a name or an email
  //    (this account connected with no display name set anywhere for its
  //    own person row, `@bloombot/db#resolvePersonByIdentity`'s own
  //    default).
  await expect(nearLimit).not.toContainText(
    "Nobody is close to a course's own daily limit today."
  )
  await expect(nearLimit).toContainText(personId)
  await expect(nearLimit).toContainText('1 of 1 today')
})
