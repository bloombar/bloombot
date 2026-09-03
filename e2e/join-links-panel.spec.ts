/**
 * WEB-20, end to end: an organization owner issues a join link from the
 * panel, copies it, a real visitor redeems it, and revoking it stops
 * admitting new visitors without un-enrolling the one who already joined.
 * WEB-23's own expiry test, and ENRL-12's own "issue, close, reveal,
 * redeem" journey, are further down this same file.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `course-configuration.spec.ts`/`join-link.spec.ts` both hold themselves
 * to):
 *
 *  - Real: the browser (`pages/CourseEditor.tsx`, `components/JoinLinks.tsx`,
 *    `pages/JoinLink.tsx`), a real `apps/api` (`routes/join-links.ts`,
 *    `routes/actions.ts`, unmodified), a real throwaway SQLite database, and
 *    the whole round trip: `courseJoinLinks.create`/`.list`/`.revoke`
 *    dispatched exactly the way any other caller reaches them, and the
 *    created link actually redeemed through the unmodified `/join/:secret`
 *    flow `join-link.spec.ts` already covers for ENRL-8 — this spec does
 *    not re-prove that flow's own internals, only that the URL the panel
 *    hands an instructor is a genuine, working one.
 *  - Not real: the model (unreached — nothing here asks the course a
 *    question).
 *
 * So this test proves: a link issued and copied entirely through the panel
 * admits a real, independent visitor who follows it, and revoking that same
 * link — behind a confirmation naming both halves of ENRL-4 — stops it
 * admitting anyone new while leaving the visitor who already joined
 * enrolled, all without ever looking at `course_join_links.secret_hash`
 * directly.
 */

import { createHash, randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  courseJoinLinks,
  courses,
  enrolments,
  memberships,
  openDatabase,
  people,
  projects,
} from '@bloombot/db'

import { E2E_DATABASE_PATH, E2E_PUBLIC_APP_URL } from './support/env.js'
import { readSignInToken } from './support/read-sign-in-token.js'

test('an owner issues and copies a join link; a real visitor redeems it; revoking stops new admission without un-enrolling them (WEB-20, ENRL-4)', async ({
  page,
  browser,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const ownerEmail = `owner-${suffix}@example.edu`
  const studentEmail = `student-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Web Design — ${suffix}`

  // Playwright's own clipboard API needs the origin's permission granted
  // explicitly — jsdom's unit tests stub `navigator.clipboard` outright
  // (`join-links.test.tsx`), but a real Chromium refuses `writeText`
  // without this.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: E2E_PUBLIC_APP_URL,
  })

  // 1. Sign in and define a course — the same panel-only path
  //    `course-configuration.spec.ts` already proves for CFG-2..4.
  await page.goto('/')
  await page.getByLabel('Email').fill(ownerEmail)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(ownerEmail)
  const ownerToken = await readSignInToken(ownerEmail)
  await page.goto(`/sign-in/${ownerToken}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await page.getByRole('button', { name: 'Projects' }).click()
  await page.getByLabel('New project name').fill(projectName)
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('button', { name: projectName }).click()

  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(courseTitle)
  await page.getByLabel('File prefix').fill(`wd-${suffix}`)
  await page.getByLabel('Admins role').fill(`admins-wd-${suffix}`)
  await page.getByLabel('Students role').fill(`students-wd-${suffix}`)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible()

  // 2. WEB-20: issue a join link and copy it — the secret is shown exactly
  //    once, right here.
  await expect(page.getByRole('heading', { name: 'Join links' })).toBeVisible()
  await expect(page.getByText('No join links issued yet.')).toBeVisible()
  await page.getByRole('button', { name: 'Create join link' }).click()

  const urlNode = page.getByTestId('created-join-link-url')
  await expect(urlNode).toBeVisible()
  const joinUrl = (await urlNode.textContent())?.trim()
  if (!joinUrl) throw new Error('the panel never rendered the created URL')
  expect(joinUrl).toContain('/join/')

  await page.getByRole('button', { name: 'Copy link' }).click()
  await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible()
  // `navigator.clipboard` — Node's own minimal `Navigator` type (this
  // repo's `tsconfig.base.json` carries no `dom` lib, only `ES2023`,
  // matching every other package in this workspace) does not declare the
  // Clipboard API, even though the callback below runs in the real browser
  // this page controls, not in this test process — a narrow, deliberate
  // `as` past that gap, not a real `any`.
  const clipboardText = await page.evaluate(() =>
    (
      navigator as unknown as { clipboard: { readText(): Promise<string> } }
    ).clipboard.readText()
  )
  // Proves the control that says "copy" actually reaches the clipboard with
  // exactly the URL displayed, not merely toggling its own label.
  expect(clipboardText).toBe(joinUrl)

  // 3. A real, independent visitor follows the copied URL — a fresh browser
  //    context, since sign-in is cookie-based and this must not reuse the
  //    owner's own session.
  const studentContext = await browser.newContext()
  try {
    const studentPage = await studentContext.newPage()
    await studentPage.goto(joinUrl)
    await expect(
      studentPage.getByRole('heading', { name: 'Sign in to Bloombot' })
    ).toBeVisible()
    await studentPage.getByLabel('Email').fill(studentEmail)
    await studentPage
      .getByRole('button', { name: 'Email me a sign-in link' })
      .click()
    await expect(studentPage.getByTestId('link-requested')).toContainText(
      studentEmail
    )
    const studentToken = await readSignInToken(studentEmail)
    await studentPage.goto(`/sign-in/${studentToken}`)
    await expect(studentPage.getByTestId('organization-switcher')).toBeVisible()
    // Landed in the instructor's own organization, connected (LINK-10), and
    // reaching the enrolled course — the same shape `join-link.spec.ts`
    // already proves for ENRL-8; here it matters only as proof this
    // panel-issued link genuinely admits.
    await expect(
      studentPage.getByTestId('organization-switcher')
    ).toContainText('(connected)')
  } finally {
    await studentContext.close()
  }

  // 4. Back in the owner's own panel: a real reload, then back to this same
  //    course the ordinary way (this app routes most screens through
  //    client-side state, not a URL, so a reload always lands back on
  //    Projects — `App.tsx`'s own module comment on which few paths are
  //    real routes). The list still shows the link, live; the secret itself
  //    is never shown again — this screen has nothing left to show it from
  //    (`repos/course-join-links.ts`'s own module comment).
  await page.reload()
  await page.getByRole('button', { name: projectName }).click()
  await page.getByRole('button', { name: courseTitle }).click()
  await expect(page.getByRole('heading', { name: 'Join links' })).toBeVisible()
  await expect(page.getByText('No expiry')).toBeVisible()
  await expect(page.getByTestId('created-join-link-url')).not.toBeVisible()

  await page.getByRole('button', { name: /^Revoke join link/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Revoke this join link?' })
  await expect(dialog).toContainText('stops the link admitting anyone new')
  await expect(dialog).toContainText('does not un-enrol anybody')
  await dialog.getByRole('button', { name: 'Revoke' }).click()
  await expect(page.getByText(/^Revoked /)).toBeVisible()

  // 5. ENRL-4, read back directly: the student who already joined stays
  //    enrolled — revoking never un-admits anyone it already admitted.
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    // The owner's own organization is where this course and its join link
    // both live — resolved off the owner's own membership, the same way
    // `course-configuration.spec.ts`/`course-knowledge-files.spec.ts` both
    // resolve one.
    const ownerAccount = accounts.getAccountByEmail(ownerEmail, db)
    if (!ownerAccount) throw new Error('verify failed: owner account not found')
    const [ownerMembership] = memberships.listMembershipsForAccount(
      ownerAccount.id,
      db
    )
    if (!ownerMembership) throw new Error('verify failed: membership not found')
    const organizationId = ownerMembership.organizationId

    const project = projects
      .listProjects(organizationId, db)
      .find((candidate) => candidate.name === projectName)
    if (!project) throw new Error('verify failed: project not found')
    const course = courses
      .listCourses(organizationId, db, { projectId: project.id })
      .find((candidate) => candidate.title === courseTitle)
    if (!course) throw new Error('verify failed: course not found')

    // The student's own account connected a person in the owner's
    // organization (LINK-10) rather than joining as a member — resolved
    // through that connected `web` identity, the same as `join-link.spec.ts`
    // itself reads it back.
    const studentAccount = accounts.getAccountByEmail(studentEmail, db)
    if (!studentAccount) {
      throw new Error('verify failed: student account not found')
    }
    const studentPerson = people.resolveIdentity(
      organizationId,
      { surface: 'web', externalId: studentAccount.id },
      db
    )
    if (!studentPerson) {
      throw new Error('verify failed: no connected web person for the student')
    }
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        studentPerson.id,
        db
      )
    ).toBeDefined()
  } finally {
    closeDatabase(db)
  }

  // 6. The revoked link now refuses a second visitor identically to a
  //    never-issued one (ENRL-4's own "no oracle" shape,
  //    `join-link.spec.ts`'s own second test already proves the wording).
  const secondVisitorContext = await browser.newContext()
  try {
    const secondVisitorPage = await secondVisitorContext.newPage()
    await secondVisitorPage.goto(joinUrl)
    await secondVisitorPage
      .getByLabel('Email')
      .fill(`too-late-${suffix}@example.edu`)
    await secondVisitorPage
      .getByRole('button', { name: 'Email me a sign-in link' })
      .click()
    await expect(secondVisitorPage.getByTestId('link-requested')).toBeVisible()
    const tooLateToken = await readSignInToken(`too-late-${suffix}@example.edu`)
    await secondVisitorPage.goto(`/sign-in/${tooLateToken}`)
    await expect(secondVisitorPage.getByRole('alert')).toContainText(
      'That join link is no longer valid. Ask for a new one.'
    )
  } finally {
    await secondVisitorContext.close()
  }
})

/**
 * WEB-23, end to end: an instructor chooses an expiry when issuing a link,
 * rather than only ever getting the permanent default the test above
 * covers. Real, same as above: the browser (`JoinLinks.tsx`'s new expiry
 * control), a real `apps/api`, and a real throwaway SQLite database — this
 * reads `course_join_links.expires_at` back directly to prove the value the
 * panel sent was actually persisted, not merely rendered.
 */
test('an owner chooses an expiry when issuing a join link, and it is what gets persisted and shown (WEB-23)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const ownerEmail = `owner-web23-${suffix}@example.edu`
  const projectName = `Web23 — ${suffix}`
  const courseTitle = `Web23 Course — ${suffix}`
  const weekMs = 7 * 24 * 60 * 60 * 1000

  await page.goto('/')
  await page.getByLabel('Email').fill(ownerEmail)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(ownerEmail)
  const ownerToken = await readSignInToken(ownerEmail)
  await page.goto(`/sign-in/${ownerToken}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await page.getByRole('button', { name: 'Projects' }).click()
  await page.getByLabel('New project name').fill(projectName)
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('button', { name: projectName }).click()

  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(courseTitle)
  await page.getByLabel('File prefix').fill(`w23-${suffix}`)
  await page.getByLabel('Admins role').fill(`admins-w23-${suffix}`)
  await page.getByLabel('Students role').fill(`students-w23-${suffix}`)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible()

  await expect(page.getByRole('heading', { name: 'Join links' })).toBeVisible()
  await expect(page.getByText('No join links issued yet.')).toBeVisible()

  const before = Date.now()
  await page.getByLabel('Expiry').selectOption('1w')
  await page.getByRole('button', { name: 'Create join link' }).click()
  await expect(page.getByTestId('created-join-link-url')).toBeVisible()

  // The list shows what was chosen — a real future date, not the permanent
  // default the test above covers.
  await expect(page.getByText(/^Expires /)).toBeVisible()

  // Read back through the real database — proves the panel's own value
  // round-tripped through `courseJoinLinks.create` and was actually
  // persisted, not merely rendered from client-side state.
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const ownerAccount = accounts.getAccountByEmail(ownerEmail, db)
    if (!ownerAccount) throw new Error('verify failed: owner account not found')
    const [ownerMembership] = memberships.listMembershipsForAccount(
      ownerAccount.id,
      db
    )
    if (!ownerMembership) throw new Error('verify failed: membership not found')
    const organizationId = ownerMembership.organizationId

    const project = projects
      .listProjects(organizationId, db)
      .find((candidate) => candidate.name === projectName)
    if (!project) throw new Error('verify failed: project not found')
    const course = courses
      .listCourses(organizationId, db, { projectId: project.id })
      .find((candidate) => candidate.title === courseTitle)
    if (!course) throw new Error('verify failed: course not found')

    const [joinLink] = courseJoinLinks.listJoinLinks(
      organizationId,
      course.id,
      db
    )
    if (!joinLink) throw new Error('verify failed: join link not found')
    expect(joinLink.expiresAt).not.toBeNull()
    // Strictly in the future at the moment it was sent, and consistent with
    // the one-week duration chosen — not merely "some number".
    expect(joinLink.expiresAt as number).toBeGreaterThan(before)
    expect(joinLink.expiresAt as number).toBeLessThanOrEqual(
      before + weekMs + 60_000
    )
  } finally {
    closeDatabase(db)
  }
})

/**
 * ENRL-12, end to end: the journey the requirement itself names — an
 * instructor issues a link, the tab that showed the secret once closes (a
 * reload, standing in for that the same way the WEB-20 test above already
 * does for its own step 4), and the secret is still recoverable later, from
 * the list alone, through a real reveal that a real second visitor then
 * redeems. `e2e/support/start-api.ts` configures a real
 * `joinLinkEncryptionKey` for this harness — without it, `revealable` is
 * `false` for every link this process ever creates and this journey has no
 * control to click at all (`components/JoinLinks.tsx`'s own module
 * comment).
 *
 * Real, the same three things the WEB-20 test above is real for: the
 * browser, `apps/api` unmodified, and a real database — plus the redemption
 * round trip through the *revealed* URL specifically, not the one shown at
 * creation, which is the one thing only this test proves.
 */
test('an owner issues a join link, closes the tab that showed it, then reveals it again later and a real visitor redeems that revealed URL (ENRL-12)', async ({
  page,
  browser,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const ownerEmail = `owner-enrl12-${suffix}@example.edu`
  const studentEmail = `student-enrl12-${suffix}@example.edu`
  const projectName = `ENRL-12 — ${suffix}`
  const courseTitle = `ENRL-12 Course — ${suffix}`

  await page.goto('/')
  await page.getByLabel('Email').fill(ownerEmail)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(ownerEmail)
  const ownerToken = await readSignInToken(ownerEmail)
  await page.goto(`/sign-in/${ownerToken}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await page.getByRole('button', { name: 'Projects' }).click()
  await page.getByLabel('New project name').fill(projectName)
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('button', { name: projectName }).click()

  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(courseTitle)
  await page.getByLabel('File prefix').fill(`e12-${suffix}`)
  await page.getByLabel('Admins role').fill(`admins-e12-${suffix}`)
  await page.getByLabel('Students role').fill(`students-e12-${suffix}`)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible()

  // 1. Issue — the secret is shown once, right here, exactly as WEB-20's own
  //    test above proves. Deliberately never copied or read in this test:
  //    the point is that this instructor loses it the ordinary way (closing
  //    the tab), not that they saved it somewhere else first.
  await expect(page.getByRole('heading', { name: 'Join links' })).toBeVisible()
  await page.getByRole('button', { name: 'Create join link' }).click()
  await expect(page.getByTestId('created-join-link-url')).toBeVisible()

  // 2. Close — a real reload, the same stand-in the WEB-20 test above uses
  //    for "closed the tab, came back later": this app routes most screens
  //    through client-side state, not a URL, so a reload always lands back
  //    on Projects (`App.tsx`'s own module comment). The once-shown secret
  //    is genuinely gone from this page now, not merely hidden.
  await page.reload()
  await page.getByRole('button', { name: projectName }).click()
  await page.getByRole('button', { name: courseTitle }).click()
  await expect(page.getByRole('heading', { name: 'Join links' })).toBeVisible()
  await expect(page.getByTestId('created-join-link-url')).not.toBeVisible()

  // 3. Reveal — the control this slice adds. Fails without it: before
  //    ENRL-12, nothing in this panel could ever put the secret back on
  //    screen, and the journey this test proves would have nowhere to go
  //    from here but a dead end.
  await page.getByRole('button', { name: /^Show join link/ }).click()
  const revealedUrlNode = page.getByTestId('revealed-join-link-url')
  await expect(revealedUrlNode).toBeVisible()
  const revealedUrl = (await revealedUrlNode.textContent())?.trim()
  if (!revealedUrl) throw new Error('the panel never rendered the revealed URL')
  expect(revealedUrl).toContain('/join/')

  // 4. Prove it by redeeming, not by comparing strings — a real, independent
  //    visitor (a fresh browser context; sign-in is cookie-based) follows
  //    the *revealed* URL specifically and lands connected, the same
  //    outcome `join-link.spec.ts` already proves for an ordinary,
  //    just-created link.
  const studentContext = await browser.newContext()
  try {
    const studentPage = await studentContext.newPage()
    await studentPage.goto(revealedUrl)
    await expect(
      studentPage.getByRole('heading', { name: 'Sign in to Bloombot' })
    ).toBeVisible()
    await studentPage.getByLabel('Email').fill(studentEmail)
    await studentPage
      .getByRole('button', { name: 'Email me a sign-in link' })
      .click()
    await expect(studentPage.getByTestId('link-requested')).toContainText(
      studentEmail
    )
    const studentToken = await readSignInToken(studentEmail)
    await studentPage.goto(`/sign-in/${studentToken}`)
    await expect(
      studentPage.getByTestId('organization-switcher')
    ).toContainText('(connected)')
  } finally {
    await studentContext.close()
  }

  // 5. Read back directly: the revealed secret really is the same one
  //    `.create` issued — `secretHash` never changed, only a second,
  //    encrypted copy was added alongside it (`docs/DECISIONS.md` D-74).
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const ownerAccount = accounts.getAccountByEmail(ownerEmail, db)
    if (!ownerAccount) throw new Error('verify failed: owner account not found')
    const [ownerMembership] = memberships.listMembershipsForAccount(
      ownerAccount.id,
      db
    )
    if (!ownerMembership) throw new Error('verify failed: membership not found')
    const organizationId = ownerMembership.organizationId

    const project = projects
      .listProjects(organizationId, db)
      .find((candidate) => candidate.name === projectName)
    if (!project) throw new Error('verify failed: project not found')
    const course = courses
      .listCourses(organizationId, db, { projectId: project.id })
      .find((candidate) => candidate.title === courseTitle)
    if (!course) throw new Error('verify failed: course not found')

    const [joinLink] = courseJoinLinks.listJoinLinks(
      organizationId,
      course.id,
      db
    )
    if (!joinLink) throw new Error('verify failed: join link not found')
    // The revealed secret's own hash is the row's own secretHash — the
    // property ENRL-12's own "the hash stays the lookup path" decision
    // rests on, checked here directly rather than only through the browser.
    const revealedSecret = revealedUrl.split('/join/')[1]
    if (!revealedSecret) {
      throw new Error('verify failed: could not parse the revealed secret')
    }
    expect(createHash('sha256').update(revealedSecret).digest('hex')).toBe(
      joinLink.secretHash
    )
  } finally {
    closeDatabase(db)
  }
})
