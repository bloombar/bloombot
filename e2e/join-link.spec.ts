/**
 * ENRL-8, end to end: a course join link, redeemed through the real browser
 * and the real `apps/api`, leaving an enrolment `routes/chat.ts` actually
 * accepts.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `connect.spec.ts`/`link-10-connected-organization.spec.ts` already hold
 * themselves to):
 *
 *  - Real: the browser (`pages/JoinLink.tsx`, `pages/SignIn.tsx`,
 *    `pages/RedeemLink.tsx`, `pages/Shell.tsx`, `pages/Chat.tsx`), a real
 *    `apps/api` (`routes/join-links.ts`, `routes/chat.ts`, unmodified), a
 *    real throwaway SQLite database, and the whole sign-in round trip (an
 *    emailed link, actually redeemed) *and* the whole join-link redemption
 *    round trip.
 *  - **Not real**: the model (`e2e/support/fake-model-client.ts`, the same
 *    stand-in `chat.spec.ts`/`link-10-connected-organization.spec.ts` use).
 *  - **The join link itself is seeded directly against the e2e database**,
 *    not issued through the panel — `WEB-20` (the panel's own issuing/copying
 *    UI) is a later slice on this same branch and does not exist yet; this
 *    spec seeds a course and a live link the same way
 *    `link-10-connected-organization.spec.ts`'s own `seedRosterAdmittedCourse`
 *    seeds a roster admission directly, standing in for an instructor who
 *    already created and shared one. The secret is hashed the same
 *    SHA-256-over-the-raw-string way `@bloombot/actions`' (module-private)
 *    `hashSecret` does — `apps/api/tests/routes/join-links.test.ts`'s own
 *    module comment states the identical reason this file cannot import
 *    that function directly.
 */

import { createHash, randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  courseJoinLinks,
  courses,
  enrolments,
  openDatabase,
  organizations,
  people,
  projects,
} from '@bloombot/db'

import { E2E_DATABASE_PATH } from './support/env.js'
import { readSignInToken } from './support/read-sign-in-token.js'

/** The same hash `@bloombot/actions`' own (module-private) `hashSecret` computes — see this file's own module comment. */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

test('a real visitor redeems a course join link, signing in along the way, and reaches the enrolled course in Chat (ENRL-8)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `join-${suffix}@example.edu`
  const secret = `secret-${suffix}`
  const courseTitle = `Intro to Testing — ${suffix}`

  // 1. An institution's own organization, one enabled course, and a live
  //    join link for it — seeded directly (this spec's own module comment
  //    on why), standing in for an instructor who already shared the
  //    secret with a whole class.
  const institutionOrganizationId = randomUUID()
  const seedDb = openDatabase(E2E_DATABASE_PATH)
  let courseId: string
  try {
    organizations.createOrganization(
      institutionOrganizationId,
      { name: `Institution ${suffix}`, isPersonal: false },
      seedDb
    )
    const instructor = accounts.createAccount(
      institutionOrganizationId,
      {
        email: `instructor-${suffix}@example.edu`,
        displayName: 'Instructor',
        role: 'owner',
      },
      seedDb
    )
    const project = projects.createProject(
      institutionOrganizationId,
      { name: `Term ${suffix}` },
      seedDb
    )
    const created = courses.createCourse(
      institutionOrganizationId,
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
      seedDb
    )
    if (!created.ok) throw new Error('setup failed: course creation refused')
    courseId = created.course.id

    courseJoinLinks.createJoinLink(
      institutionOrganizationId,
      {
        courseId,
        secretHash: hashSecret(secret),
        createdByAccountId: instructor.id,
      },
      seedDb
    )
  } finally {
    closeDatabase(seedDb)
  }

  // 2. Follow the join link, signed out — the exact address a real
  //    instructor would share with a class.
  await page.goto(`/join/${secret}`)
  await expect(
    page.getByRole('heading', { name: 'Sign in to Bloombot' })
  ).toBeVisible()

  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(email)
  const token = await readSignInToken(email)

  // 3. Redeeming the sign-in link returns the browser to this same join
  //    link (`App.tsx`'s own `PENDING_JOIN_LINK_KEY` handling,
  //    `pages/JoinLink.tsx`) — which redeems automatically and lands the
  //    browser on the ordinary shell once it succeeds. Proven by the
  //    course actually being reachable below: had the browser gone
  //    straight to the shell instead of back through the join link, no
  //    redemption would ever have run and there would be nothing to reach.
  await page.goto(`/sign-in/${token}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // 4. The redeemed enrolment, read back directly — a body-supplied
  //    `personId` never had anywhere to redirect this to: the connected
  //    person is exactly the account's own.
  const verifyDb = openDatabase(E2E_DATABASE_PATH)
  try {
    const account = accounts.getAccountByEmail(email, verifyDb)
    if (!account) throw new Error('verify failed: account not found')
    const person = people.resolveIdentity(
      institutionOrganizationId,
      { surface: 'web', externalId: account.id },
      verifyDb
    )
    if (!person) throw new Error('verify failed: no connected web person')
    expect(person.connectedAt).not.toBeNull()
    expect(
      enrolments.getActiveEnrolment(
        institutionOrganizationId,
        courseId,
        person.id,
        verifyDb
      )
    ).toBeDefined()
  } finally {
    closeDatabase(verifyDb)
  }

  // 5. The browser's own part — switch to the institution's organization
  //    (connected, not a membership: this account administers nothing
  //    there, the same LINK-10 shape `link-10-connected-organization.spec.ts`
  //    already proves) and hold a real conversation with the course this
  //    join link admitted it to.
  const switcher = page.getByTestId('organization-switcher')
  await expect(switcher).toContainText(`Institution ${suffix}`)
  await page
    .getByRole('combobox', { name: 'Organization' })
    .selectOption({ label: `Institution ${suffix} (connected)` })

  await expect(page.getByText(courseTitle)).toBeVisible()
  await page
    .getByLabel('Ask a question')
    .fill('When is the midterm, and what should I read first?')
  await page.getByRole('button', { name: 'Send' }).click()

  const thread = page.getByTestId('chat-thread')
  await expect(thread).toContainText(
    'When is the midterm, and what should I read first?'
  )
  await expect(
    thread.getByRole('heading', { level: 1, name: 'Bloombot' })
  ).toBeVisible()
})

test('a never-issued secret is refused not-found-shaped, rather than crashing or hanging (ENRL-4/ENRL-8)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `join-bad-${suffix}@example.edu`

  await page.goto(`/join/never-issued-${suffix}`)
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(email)
  const token = await readSignInToken(email)

  await page.goto(`/sign-in/${token}`)
  await expect(page.getByRole('alert')).toContainText(
    'That join link is no longer valid. Ask for a new one.'
  )
})
