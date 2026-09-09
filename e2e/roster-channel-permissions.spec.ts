/**
 * ROST-16, end to end: a per-student channel exists so one student can ask
 * questions nobody else can read, and this is the test that reads back what
 * the channel actually permits rather than trusting the code that built the
 * overwrites. It drives a real import through the panel and then asserts on
 * the guild's own state — every overwrite on every channel the run created.
 *
 * ROST-16's own words are the assertion list: a channel created by a roster
 * import denies `@everyone`, grants the course's admins role, grants the
 * individual student, and **does not** grant the course's students role —
 * so a student reaches their own channel and no other student's, while
 * every instructor reaches all of them. A row whose Discord handle could
 * not be resolved still gets a channel with the admin grant rather than one
 * that quietly grants nobody. And it must hold for a disambiguated name
 * (ROST-14) exactly as for a bare one.
 *
 * **What is real, and what is a harness stand-in** — the same discipline
 * `roster-import-panel.spec.ts`'s own module comment holds itself to, for
 * the identical reason:
 *
 *  - Real: the browser, a real `apps/api`, a real throwaway SQLite
 *    database, and `roster.import` reached the way any caller reaches it.
 *  - Real: `apps/worker`'s own `createRosterImportHandler` and
 *    `@bloombot/jobs`'s `runNextJob`, unmodified.
 *  - Not real: no `apps/worker` *process* runs here; this spec claims and
 *    runs the job itself.
 *  - Not real: Discord. `e2e/support/fake-discord-guild-server.ts` is a
 *    loopback fake (QA-3's "no network beyond loopback"). It does store and
 *    return each channel's `permission_overwrites` verbatim as the handler
 *    posted them, which is exactly what makes this spec worth writing:
 *    the bytes asserted below are the bytes Discord would have received.
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
  type Database,
} from '@bloombot/db'
import {
  createDiscordRestClient,
  type DiscordRestClient,
} from '@bloombot/discord-rest'
import { HandlerRegistry, runNextJob, type RetryPolicy } from '@bloombot/jobs'

import { createRosterImportHandler } from '../apps/worker/src/handlers/roster-import.js'
import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { FakeDiscordGuildServer } from './support/fake-discord-guild-server.js'
import { signIn } from './support/sign-in.js'

const RETRY_POLICY: RetryPolicy = { baseDelayMs: 1000, backoffFactor: 2 }

/** Discord's own `VIEW_CHANNEL` bit, as the string a permission overwrite carries it in — `packages/discord-rest/src/channel-overwrites.ts` builds every overwrite this spec reads back. */
const VIEW_CHANNEL = 0x400n

interface Overwrite {
  id: string
  type: number
  allow: string
  deny: string
}
interface GuildChannel {
  id: string
  type: number
  name: string
  parent_id: string | null
  permission_overwrites?: Overwrite[]
}

function allowsView(overwrite: Overwrite | undefined): boolean {
  return (
    overwrite !== undefined && (BigInt(overwrite.allow) & VIEW_CHANNEL) !== 0n
  )
}
function deniesView(overwrite: Overwrite | undefined): boolean {
  return (
    overwrite !== undefined && (BigInt(overwrite.deny) & VIEW_CHANNEL) !== 0n
  )
}

/** Claims and runs exactly one `roster.import` job — this spec's stand-in for a live worker process, the same device `roster-import-panel.spec.ts` uses and for the same reason. */
async function claimAndRunRosterImportJob(
  db: Database,
  discordServer: FakeDiscordGuildServer
) {
  const discordRestClient: DiscordRestClient = createDiscordRestClient({
    clientId: 'unused',
    clientSecret: 'unused',
    apiBase: discordServer.baseUrl,
    oauthBase: discordServer.baseUrl,
  })
  const handlers = new HandlerRegistry()
  handlers.register(
    'roster.import',
    createRosterImportHandler({ discordRestClient, botToken: 'bot-token' })
  )
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await runNextJob({
      db,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      handlers,
      owner: 'e2e-worker',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      retryPolicy: RETRY_POLICY,
    })
    if (result.outcome !== 'empty') return result
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    'claimAndRunRosterImportJob: no eligible job appeared within 2s'
  )
}

test("a roster import's channels are private to their own student, their instructors, and nobody else (ROST-16)", async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `rost16-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Web Design — ${suffix}`
  const categoryName = `${courseTitle} - STUDENTS 01`
  const adminsRole = `admins-wd-${suffix}`
  const studentsRole = `students-wd-${suffix}`

  const discordServer = await FakeDiscordGuildServer.start()
  try {
    await signIn(page, email)
    await expect(page.getByTestId('organization-switcher')).toBeVisible()

    await navigateTo(page, 'Projects')
    await page.getByRole('button', { name: 'New project' }).click()
    const newProjectDialog = page.getByRole('dialog', { name: 'New project' })
    await newProjectDialog.getByLabel('Project name').fill(projectName)
    await newProjectDialog.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: projectName, exact: true }).click()

    await page.getByRole('button', { name: 'New course' }).click()
    await page.getByLabel('Title').fill(courseTitle)
    await page.getByLabel('Admins role').fill(adminsRole)
    await page.getByLabel('Students role').fill(studentsRole)
    await page.getByRole('button', { name: 'Add category' }).click()
    await page.getByLabel('Category name').fill(categoryName)
    await page.getByRole('button', { name: 'Save course' }).click()
    await page.getByRole('tab', { name: 'Roster' }).click()
    await expect(page.getByRole('heading', { name: 'Roster' })).toBeVisible()

    const db = openDatabase(E2E_DATABASE_PATH)
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

    const guildId = `e2e-guild-${suffix}`
    const claimed = discordServers.claimDiscordServerBinding(
      organizationId,
      { serverId: guildId, installedByAccountId: account.id },
      db
    )
    if (!claimed) throw new Error('setup failed: could not bind guild')
    discordServer.setGuildChannels(guildId, [
      { id: 'cat-1', type: 4, name: categoryName, parent_id: null },
    ])
    discordServer.setGuildRoles(guildId, [
      { id: 'role-admins', name: adminsRole },
      { id: 'role-students', name: studentsRole },
    ])
    // Ada resolves to a real guild member; Grace's handle matches nobody,
    // and Bea shares Ada's email local part so ROST-14 must disambiguate
    // both of their channel names.
    discordServer.setGuildMembers(guildId, [
      { user: { id: 'snowflake-ada', username: `ada-${suffix}` } },
      { user: { id: 'snowflake-bea', username: `bea-${suffix}` } },
    ])
    closeDatabase(db)

    const csvText = [
      'First,Last,Email,Discord,GitHub',
      `Ada,Lovelace,ada-${suffix}@school.edu,ada-${suffix},`,
      `Bea,Adams,ada-${suffix}@gmail.com,bea-${suffix},`,
      `Grace,Hopper,grace-${suffix}@school.edu,nobody-${suffix},`,
    ].join('\n')

    await page
      .getByTestId('roster-import')
      .locator('input[type="file"]')
      .setInputFiles({
        name: 'roster.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(csvText),
      })
    await page.getByRole('button', { name: 'Import roster' }).click()
    await expect(page.getByText('Queued…')).toBeVisible()

    const workerDb = openDatabase(E2E_DATABASE_PATH)
    try {
      const run = await claimAndRunRosterImportJob(workerDb, discordServer)
      expect(run.outcome).toBe('succeeded')
      await expect(page.getByTestId('roster-import-report')).toBeVisible({
        timeout: 10_000,
      })

      // The assertion this spec exists for: read the guild back and check
      // every channel the run created, overwrite by overwrite.
      const channels = discordServer.guildChannelsFor(guildId) as GuildChannel[]
      const studentChannels = channels.filter((channel) => channel.type === 0)
      expect(studentChannels).toHaveLength(3)

      for (const channel of studentChannels) {
        const overwrites = channel.permission_overwrites ?? []
        const byId = (id: string) => overwrites.find((entry) => entry.id === id)

        // `@everyone` shares the guild's own id (Discord's own rule) and is
        // denied view — without this every other grant is decoration.
        expect(deniesView(byId(guildId))).toBe(true)
        // Every instructor reaches every student's channel.
        expect(allowsView(byId('role-admins'))).toBe(true)
        // And the students role is never granted: a student who reached
        // another student's channel would do it through this one.
        expect(byId('role-students')).toBeUndefined()
      }

      // ROST-14 disambiguated the two colliding addresses, and the
      // permission rules hold for a disambiguated name exactly as for a
      // bare one — the loop above already covered all three, this names
      // which is which.
      const names = studentChannels.map((channel) => channel.name).sort()
      expect(names).toHaveLength(3)
      expect(
        names.filter((name) => name.startsWith(`ada-${suffix}`))
      ).toHaveLength(2)

      // Each resolved student is granted their own channel and no other's.
      const grantedTo = (memberId: string) =>
        studentChannels.filter((channel) =>
          allowsView(
            (channel.permission_overwrites ?? []).find(
              (entry) => entry.id === memberId && entry.type === 1
            )
          )
        )
      expect(grantedTo('snowflake-ada')).toHaveLength(1)
      expect(grantedTo('snowflake-bea')).toHaveLength(1)
      expect(grantedTo('snowflake-ada')[0]?.id).not.toBe(
        grantedTo('snowflake-bea')[0]?.id
      )

      // ROST-12/ROST-16: Grace's handle resolved to nobody, so her channel
      // carries no individual grant at all — but it still exists, still
      // denies `@everyone` and still grants the admins role, rather than
      // being skipped or left granting nobody. The report says so.
      const withoutIndividualGrant = studentChannels.filter(
        (channel) =>
          !(channel.permission_overwrites ?? []).some(
            (entry) => entry.type === 1 && entry.id.startsWith('snowflake-')
          )
      )
      expect(withoutIndividualGrant).toHaveLength(1)
      await expect(page.getByTestId('roster-import-report')).toContainText(
        `nobody-${suffix}`
      )
    } finally {
      closeDatabase(workerDb)
    }
  } finally {
    await discordServer.stop()
  }
})
