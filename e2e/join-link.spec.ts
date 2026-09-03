/**
 * ENRL-8, AUTH-6, WEB-25, end to end: a course join link, redeemed through
 * the real browser and the real `apps/api`, leaving an enrolment
 * `routes/chat.ts` actually accepts — and, this slice's own additions, a
 * sign-in that completes in a *different* browsing context than the one
 * that requested it (AUTH-6), and a redemption that confirms itself, names
 * the course, and lands the student directly in chat with it selected
 * (WEB-25), rather than a course picker they have no reason to understand.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `connect.spec.ts`/`link-10-connected-organization.spec.ts` already hold
 * themselves to):
 *
 *  - Real: the browser (`pages/JoinLink.tsx`, `pages/SignIn.tsx`,
 *    `pages/RedeemLink.tsx`, `pages/Shell.tsx`, `pages/Chat.tsx`), a real
 *    `apps/api` (`routes/join-links.ts`, `routes/auth.ts`, `routes/chat.ts`,
 *    unmodified), a real throwaway SQLite database, and the whole sign-in
 *    round trip (an emailed link, actually redeemed) *and* the whole
 *    join-link redemption round trip.
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
 *  - **The cross-tab case (AUTH-6) uses a second `Page` in the same
 *    `BrowserContext`, not a second `BrowserContext` or a second browser.**
 *    A `Page` is Playwright's own "browsing context" — a new top-level one,
 *    exactly as a browser's own "open in new tab" is — and, like a real
 *    browser, two pages in the same context share cookies but *not*
 *    `sessionStorage`, which is scoped per browsing context by the
 *    specification, not per profile. That is precisely the property AUTH-6
 *    is about: the old `sessionStorage` marker never survived this, and the
 *    fix (a destination carried on the sign-in token itself) does not care
 *    which page redeems it.
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

/** One enabled course in `issuer`'s own organization, and a live join link for it. */
function seedJoinLink(suffix: string): {
  institutionOrganizationId: string
  courseId: string
  courseTitle: string
  secret: string
} {
  const institutionOrganizationId = randomUUID()
  const courseTitle = `Intro to Testing — ${suffix}`
  const secret = `secret-${suffix}`

  const seedDb = openDatabase(E2E_DATABASE_PATH)
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

    courseJoinLinks.createJoinLink(
      institutionOrganizationId,
      {
        courseId: created.course.id,
        secretHash: hashSecret(secret),
        createdByAccountId: instructor.id,
      },
      seedDb
    )

    return {
      institutionOrganizationId,
      courseId: created.course.id,
      courseTitle,
      secret,
    }
  } finally {
    closeDatabase(seedDb)
  }
}

test('a real visitor redeems a course join link, signing in along the way, and lands directly in chat with it confirmed and selected (ENRL-8, WEB-25)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `join-${suffix}@example.edu`
  const { institutionOrganizationId, courseId, courseTitle, secret } =
    seedJoinLink(suffix)

  // 1. Follow the join link, signed out — the exact address a real
  //    instructor would share with a class.
  await page.goto(`/join/${secret}`)
  await expect(
    page.getByRole('heading', { name: 'Sign in to Bloombot' })
  ).toBeVisible()

  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(email)
  const token = await readSignInToken(email)

  // 2. Redeeming the sign-in link returns the browser to this same join
  //    link (AUTH-6: the destination the *token itself* was issued for,
  //    `pages/SignIn.tsx`'s own `destination` prop through
  //    `pages/JoinLink.tsx`) — which redeems automatically. WEB-25: the
  //    panel opens directly on this organization's own Chat tab, with the
  //    course already selected and the redemption confirmed by name — no
  //    manual switch through the organization picker, unlike before this
  //    rework.
  await page.goto(`/sign-in/${token}`)
  await expect(page.getByTestId('organization-switcher')).toContainText(
    `Institution ${suffix}`
  )
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()
  // The confirmation banner names the course by title (WEB-25) — checked
  // through `toContainText`, not a bare `getByText(courseTitle)`, since the
  // single-course label just below the heading repeats the same title and
  // would make that locator ambiguous.
  await expect(page.getByTestId('join-confirmation')).toContainText(
    `You're enrolled in ${courseTitle}.`
  )

  // 3. The redeemed enrolment, read back directly — a body-supplied
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

  // 4. Hold a real conversation with the course this join link admitted it
  //    to — already selected, no further navigation needed.
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

// AUTH-6's whole point, made convincing: the sign-in that redeems this link
// completes in a *different* browsing context than the one that requested
// it — the ordinary shape a mail client's own "open in a new tab" produces,
// which the old `sessionStorage` marker could not survive (this file's own
// module comment has why a second `Page` in the same context is the right
// stand-in for that). Fails without the fix: the redeemed session would land
// on the ordinary, empty shell in the second tab, with `join-confirmation`
// and the institution's own organization nowhere to be found.
test('a sign-in that completes in a different browsing context than the one that requested it still lands the visitor enrolled, in that course (AUTH-6)', async ({
  page,
  context,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `crosstab-${suffix}@example.edu`
  const { courseTitle, secret } = seedJoinLink(suffix)

  // Tab A: follow the join link, signed out, and request a sign-in link —
  // exactly as far as a visitor gets before switching to their mail client.
  await page.goto(`/join/${secret}`)
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(email)
  const token = await readSignInToken(email)

  // Tab B: a genuinely different browsing context — a fresh `Page` in the
  // same `BrowserContext`, sharing cookies (irrelevant here: neither tab has
  // a session yet) but not `sessionStorage`, the same isolation a mail
  // client's own "open in a new tab" gives a real visitor. This is the tab
  // that actually opens the emailed link.
  const otherTab = await context.newPage()
  await otherTab.goto(`/sign-in/${token}`)

  // Redeemed in tab B, and tab B lands enrolled, in the joined course, fully
  // confirmed — carried entirely on the token the server issued, never on
  // anything tab A's own `sessionStorage` wrote (tab B never touched it).
  await expect(otherTab.getByTestId('organization-switcher')).toContainText(
    `Institution ${suffix}`
  )
  await expect(otherTab.getByRole('heading', { name: 'Chat' })).toBeVisible()
  await expect(otherTab.getByTestId('join-confirmation')).toContainText(
    `You're enrolled in ${courseTitle}.`
  )

  await otherTab.close()
})

// WEB-25: "redeeming twice is a confirmation, not an error" — a student who
// re-clicks a link they were already sent (people do this) still lands in
// their course, told plainly they are already enrolled rather than shown
// nothing or an error. Fails without the fix: before `alreadyEnrolled`
// existed, a second redemption looked identical to the first.
test('redeeming the same join link a second time still lands the student in the course, saying they are already enrolled (WEB-25)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `twice-${suffix}@example.edu`
  const { courseTitle, secret } = seedJoinLink(suffix)

  await page.goto(`/join/${secret}`)
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  const token = await readSignInToken(email)
  await page.goto(`/sign-in/${token}`)
  await expect(page.getByTestId('join-confirmation')).toContainText(
    `You're enrolled in ${courseTitle}.`
  )

  // The same link, presented again — now signed in, so this redeems
  // directly (`pages/JoinLink.tsx`'s own mount-time redemption), no second
  // sign-in required.
  await page.goto(`/join/${secret}`)

  await expect(page.getByTestId('join-confirmation')).toContainText(
    `You're already enrolled in ${courseTitle}.`
  )
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()
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
