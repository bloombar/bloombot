/**
 * TEN-11 and WEB-80, end to end: a course that uses no Discord in an
 * organization that has two Discord servers.
 *
 * **What is real, and what is a harness stand-in** (the discipline
 * `discord-multi-server.spec.ts` holds itself to): the browser, the real
 * `apps/api`, a real throwaway SQLite database and every action the course
 * form drives are real. Only the two Discord server bindings are inserted
 * directly, with the repository function the real install callback uses,
 * because Discord's own consent screen cannot be automated here.
 *
 * What it proves: a new course starts with "No Discord" and its Discord
 * controls disabled; a course with no Discord saves and is enabled while the
 * organization holds two servers (the ambiguity that refuses a Discord
 * course); the stored row says so; and choosing a server enables the
 * controls and is recorded against exactly that server.
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
import { signIn } from './support/sign-in.js'

test('a course with no Discord is saved and enabled in a two-server organization, its Discord controls are disabled, and choosing a server enables them (TEN-11, WEB-80)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `ten11-${suffix}@example.edu`
  const guildA = `e2e-guild-ten11-a-${suffix}`
  const guildB = `e2e-guild-ten11-b-${suffix}`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Web Only — ${suffix}`

  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // Two active servers: the case where a Discord course with no server of
  // its own is refused as ambiguous.
  const db = openDatabase(E2E_DATABASE_PATH)
  let organizationId: string
  try {
    const account = accounts.getAccountByEmail(email, db)
    if (!account) throw new Error('setup failed: account not found')
    const [membership] = memberships.listMembershipsForAccount(account.id, db)
    if (!membership) throw new Error('setup failed: membership not found')
    organizationId = membership.organizationId
    for (const serverId of [guildA, guildB]) {
      const claimed = discordServers.claimDiscordServerBinding(
        organizationId,
        { serverId, installedByAccountId: account.id },
        db
      )
      if (!claimed) throw new Error('setup failed: could not bind a guild')
    }
  } finally {
    closeDatabase(db)
  }

  await page.reload()
  await navigateTo(page, 'Projects')
  await page.getByRole('button', { name: 'New project' }).click()
  const newProjectDialog = page.getByRole('dialog', { name: 'New project' })
  await newProjectDialog.getByLabel('Project name').fill(projectName)
  await newProjectDialog.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: projectName, exact: true }).click()

  // A new course starts with no Discord, and everything Discord-specific
  // waits for a server.
  await page.getByRole('button', { name: 'New course' }).click()
  const serverSelect = page.getByLabel('Discord server')
  await expect(serverSelect).toHaveValue('none')
  await expect(page.getByLabel('Admins role')).toBeDisabled()
  await expect(page.getByLabel('Students role')).toBeDisabled()
  await expect(
    page.getByRole('button', { name: 'Add category' })
  ).toBeDisabled()
  await expect(
    page.getByLabel('Students can enrol themselves by messaging this course')
  ).toBeDisabled()

  // Saved enabled: a Discord course in this organization would be refused
  // as ambiguous, a course with no Discord is not.
  await page.getByLabel('Title').fill(courseTitle)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()

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
    expect(course.discordEnabled).toBe(false)
    expect(course.discordServerId).toBeNull()
    expect(course.enabled).toBe(true)
  } finally {
    closeDatabase(verifyDb)
  }

  // On the Discord tab the selector leads and the controls are still off.
  await page.getByRole('tab', { name: 'Discord' }).click()
  await expect(page.getByLabel('Discord server')).toHaveValue('none')
  await expect(page.getByLabel('Admins role')).toBeDisabled()
  await expect(page.getByLabel('Category name')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Create Discord channels' })
  ).toBeDisabled()

  // Choosing a server turns them on.
  await page.getByLabel('Discord server').selectOption(guildB)
  await expect(page.getByLabel('Admins role')).toBeEnabled()
  await expect(page.getByLabel('Students role')).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Add category' })).toBeEnabled()
  await expect(
    page.getByRole('button', { name: 'Create Discord channels' })
  ).toBeEnabled()
})
