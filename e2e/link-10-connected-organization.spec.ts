/**
 * LINK-10, end to end: a signed-in account whose only relationship to an
 * institution's organization is a *connected person* — not a membership —
 * can see that organization in the panel's own switcher and reach its
 * course's chat, and the panel withholds every tab that organization's own
 * server-side authority would refuse (Discord, Projects, Transcripts).
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `chat.spec.ts`/`connect.spec.ts` already hold themselves to):
 *
 *  - Real: the browser (`pages/Shell.tsx`, `components/OrganizationSwitcher.tsx`,
 *    `pages/Chat.tsx`), a real `apps/api` (`e2e/support/start-api.ts`), a
 *    real throwaway SQLite database, and every route the browser calls
 *    (`GET /auth/me`, `GET .../chat/courses`, `POST .../chat/courses/:id/messages`)
 *    — unmodified.
 *  - **Not real**: the model (`e2e/support/fake-model-client.ts`, the same
 *    stand-in `chat.spec.ts` uses) and Discord's own OAuth consent screen.
 *    Driving a real browser through `/discord/begin` → Discord →
 *    `/discord/confirm` would need a second, fake OAuth provider standing
 *    in for discord.com, which this harness does not build
 *    (`e2e/connect.spec.ts`'s own module comment states the identical
 *    limitation; `e2e/support/start-api.ts` already points `apps/api`'s own
 *    Discord configuration at unreachable loopback addresses on purpose).
 *    `apps/api/tests/routes/person-link.test.ts`'s own acceptance test
 *    proves that connect mechanism end to end, over real HTTP, starting
 *    from the identical real starting point this spec's own setup uses
 *    below (a roster-admitted `discord`-surface person). This spec picks up
 *    from the state a completed Discord connect leaves behind, built with
 *    the *same* repository functions `/discord/confirm` calls internally
 *    (`people.mergePeople`, `people.connectIdentity` — never a raw
 *    `connectedAt` column write), so the database this browser reads is
 *    shaped exactly the way a real connect leaves it, not a shortcut this
 *    read surface happens to resolve.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  courses,
  enrolments,
  openDatabase,
  organizations,
  people,
  projects,
  type Database,
} from '@bloombot/db'

import { E2E_DATABASE_PATH } from './support/env.js'
import { readSignInToken } from './support/read-sign-in-token.js'

/**
 * A course in `organizationId`, with an active enrolment admitting a
 * `discord`-surface person via `enrolViaRoster` — the same admission path a
 * real roster import uses (`apps/worker/src/roster-import.ts`), the only
 * kind of person any real enrolment in this system ever belongs to
 * (`apps/api/tests/routes/person-link.test.ts`'s own identical helper and
 * module comment).
 */
function seedRosterAdmittedCourse(
  db: Database,
  organizationId: string,
  discordExternalId: string
): { courseTitle: string; discordPersonId: string } {
  const project = projects.createProject(
    organizationId,
    { name: `Term ${randomUUID()}` },
    db
  )
  const courseTitle = `Intro to Testing — ${randomUUID().slice(0, 8)}`
  const unique = randomUUID()
  const created = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: courseTitle,
      filePrefix: 'testing',
      enabled: true,
      adminsRole: `Staff-${unique}`,
      studentsRole: `Students-${unique}`,
      promptId: 'prompt-1',
      categories: [],
    },
    db
  )
  if (!created.ok) throw new Error('setup failed: course creation refused')

  const discordPerson = people.resolvePersonByIdentity(
    organizationId,
    { surface: 'discord', externalId: discordExternalId },
    db
  )
  enrolments.enrolViaRoster(
    organizationId,
    { courseId: created.course.id, personId: discordPerson.id },
    db
  )

  return { courseTitle, discordPersonId: discordPerson.id }
}

test('a student connected into an institution the account does not administer reaches the switcher, sees only Chat there, and gets an answer (LINK-10)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `link10-${suffix}@example.edu`
  const discordExternalId = `discord-${suffix}`

  // 1. The real starting point (this spec's own module comment) — an
  //    institution's own organization, and a discord-surface person a
  //    roster import already admitted into a course there. Nobody has
  //    signed in yet.
  const institutionOrganizationId = randomUUID()
  const seedDb = openDatabase(E2E_DATABASE_PATH)
  let courseTitle: string
  let discordPersonId: string
  try {
    organizations.createOrganization(
      institutionOrganizationId,
      { name: 'A University', isPersonal: false },
      seedDb
    )
    const seeded = seedRosterAdmittedCourse(
      seedDb,
      institutionOrganizationId,
      discordExternalId
    )
    courseTitle = seeded.courseTitle
    discordPersonId = seeded.discordPersonId
    expect(
      people.getPerson(institutionOrganizationId, discordPersonId, seedDb)
        ?.connectedAt
    ).toBeNull()
  } finally {
    closeDatabase(seedDb)
  }

  // 2. Sign in — a brand-new account, own personal organization only, no
  //    relationship at all yet to the institution's organization.
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(email)
  const token = await readSignInToken(email)
  await page.goto(`/sign-in/${token}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // 3. The real merge, built from the same repository functions
  //    `/discord/confirm` calls internally (this spec's own module
  //    comment) — not a shortcut the read surface under test happens to
  //    resolve.
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const account = accounts.getAccountByEmail(email, db)
    if (!account) throw new Error('setup failed: account not found')

    // `resolveOrCreateBareDiscordSurvivor`'s own shape (`routes/person-link.ts`)
    // — a bare person for this account in this organization, before the
    // merge that gives it the roster-admitted identity.
    const survivor = people.createPerson(institutionOrganizationId, {}, db)
    const merge = people.mergePeople(
      institutionOrganizationId,
      survivor.id,
      discordPersonId,
      db
    )
    if (!merge) throw new Error('setup failed: mergePeople refused')

    // `/discord/confirm`'s own second step (`attachWebIdentityOrMerge`) —
    // the account's own web identity, attached to the same survivor.
    const connected = people.connectIdentity(
      institutionOrganizationId,
      survivor.id,
      { surface: 'web', externalId: account.id },
      db
    )
    if (!connected) throw new Error('setup failed: connectIdentity refused')
  } finally {
    closeDatabase(db)
  }

  // 4. The browser's own part — reload so `GET /auth/me` reflects the
  //    connect this spec's setup just wrote.
  await page.reload()
  const switcher = page.getByTestId('organization-switcher')
  await expect(switcher).toContainText('A University')
  await expect(switcher).toContainText('connected')

  await page
    .getByRole('combobox', { name: 'Organization' })
    .selectOption({ label: 'A University (connected)' })

  // LINK-10's own withholding, proven in a real browser: nothing this
  // account's every click against would refuse is offered.
  await expect(page.getByRole('button', { name: 'Discord' })).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Projects' })).not.toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Transcripts' })
  ).not.toBeVisible()

  // 5. Chat is what this account can actually reach here — the course the
  //    roster admitted the merged-in identity to before this account ever
  //    signed in.
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
