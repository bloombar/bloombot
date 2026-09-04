/**
 * TEN-9, end to end: an organization can bind more than one Discord server,
 * and a course names which one it routes in.
 *
 * **What is real, and what is a harness stand-in — read this before trusting
 * what this test proves** (the same discipline `course-configuration.spec.ts`/
 * `discord-install-panel.spec.ts` both hold themselves to):
 *
 *  - Real: the browser (`pages/Shell.tsx`, `components/InstallButton.tsx`,
 *    `pages/CourseEditor.tsx`), a real `apps/api` (`routes/actions.ts`,
 *    unmodified), a real throwaway SQLite database, and every action this
 *    UI drives — `discordServers.list`, `courses.save` (with its new
 *    `discordServerId` field) — reached exactly the way any other caller
 *    reaches them.
 *  - Not real: the OAuth+PKCE install flow itself. Both Discord server
 *    bindings this test needs are inserted directly with
 *    `discordServers.claimDiscordServerBinding` — the same repository
 *    function TEN-4's real install flow calls, just invoked here instead of
 *    walked through Discord's own consent screen twice, which this harness
 *    has no way to automate.
 *
 * So this test proves: the Discord screen lists every active binding, each
 * with its own Remove, still offering to install another; and a course
 * saved through the panel while the organization holds two bindings — with
 * a server explicitly chosen through the selector this slice added — is
 * recorded against exactly that binding, read back directly from the
 * database, not the other one.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  courses,
  discordServers,
  memberships,
  openDatabase,
  projects,
} from '@bloombot/db'

import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { readSignInToken } from './support/read-sign-in-token.js'

test('an organization with two active Discord bindings lists both, and a course assigned to one of them is recorded against that one, not the other (TEN-9)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `ten9-${suffix}@example.edu`
  const guildA = `e2e-guild-ten9-a-${suffix}`
  const guildB = `e2e-guild-ten9-b-${suffix}`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Web Design — ${suffix}`

  // 1. Sign in — the same emailed-link flow every other panel spec in this
  //    suite uses, which also creates this account's own personal
  //    organization (TEN-1).
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(email)
  const token = await readSignInToken(email)
  await page.goto(`/sign-in/${token}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // 2. Bind *two* Discord servers directly, bypassing the browser entirely
  //    (see this file's own module comment for why) — the organization this
  //    account administers now holds two active bindings, TEN-9's own
  //    scenario.
  const db = openDatabase(E2E_DATABASE_PATH)
  let organizationId: string
  try {
    const account = accounts.getAccountByEmail(email, db)
    if (!account) throw new Error('setup failed: account not found')
    const [membership] = memberships.listMembershipsForAccount(account.id, db)
    if (!membership) throw new Error('setup failed: membership not found')
    organizationId = membership.organizationId

    const claimedA = discordServers.claimDiscordServerBinding(
      organizationId,
      { serverId: guildA, installedByAccountId: account.id },
      db
    )
    const claimedB = discordServers.claimDiscordServerBinding(
      organizationId,
      { serverId: guildB, installedByAccountId: account.id },
      db
    )
    if (!claimedA || !claimedB) {
      throw new Error('setup failed: could not bind both guilds')
    }
  } finally {
    closeDatabase(db)
  }

  // 3. The Discord screen lists both, each with its own Remove — never the
  //    single Install/Remove pair this screen used to be — and still offers
  //    installing another.
  await page.reload()
  await navigateTo(page, 'Discord')
  await expect(page.getByText(guildA)).toBeVisible()
  await expect(page.getByText(guildB)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(2)
  await expect(
    page.getByRole('button', { name: 'Install to Discord' })
  ).toBeVisible()

  // 4. Define a course through the panel, choosing `guildB` explicitly
  //    through the selector this slice added — offered now because the
  //    organization holds more than one active binding
  //    (`pages/CourseEditor.tsx`'s own guard).
  await navigateTo(page, 'Projects')
  await page.getByRole('button', { name: 'New project' }).click()
  const newProjectDialog = page.getByRole('dialog', { name: 'New project' })
  await newProjectDialog.getByLabel('Project name').fill(projectName)
  await newProjectDialog.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: projectName, exact: true }).click()

  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(courseTitle)
  await page.getByLabel('File prefix').fill(`wd-${suffix}`)
  await page.getByLabel('Admins role').fill(`admins-wd-${suffix}`)
  await page.getByLabel('Students role').fill(`students-wd-${suffix}`)

  const serverSelect = page.getByLabel('Discord server')
  await expect(serverSelect).toBeVisible()
  await serverSelect.selectOption(guildB)

  await page.getByRole('button', { name: 'Save course' }).click()
  // The save succeeded once the dedicated enable/disable control appears —
  // it only renders once `courseId` is set, i.e. once `courses.save`
  // actually returned a saved course rather than a refusal.
  await expect(page.getByRole('button', { name: 'Enable' })).toBeVisible()

  // 5. Read back directly: the saved course names `guildB`, not `guildA` —
  //    the identity of which binding it was assigned to, not merely that
  //    some server field is set.
  const verifyDb = openDatabase(E2E_DATABASE_PATH)
  try {
    const project = projects
      .listProjects(organizationId, verifyDb)
      .find((candidate) => candidate.name === projectName)
    if (!project) throw new Error('verify failed: project not found')
    const course = courses
      .listCourses(organizationId, verifyDb, { projectId: project.id })
      .find((candidate) => candidate.title === courseTitle)
    if (!course) throw new Error('verify failed: course not found')
    expect(course.discordServerId).toBe(guildB)
    expect(course.discordServerId).not.toBe(guildA)
  } finally {
    closeDatabase(verifyDb)
  }
})
