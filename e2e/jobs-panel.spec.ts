/**
 * JOB-2, end to end: a job that failed permanently in a session this
 * browser never held — read from the Jobs tab, not from any id the panel
 * happened to remember.
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `team-panel.spec.ts`'s own module comment holds itself to):
 *
 *  - Real: the browser (`pages/Jobs.tsx`), a real `apps/api`
 *    (`routes/actions.ts`, unmodified), a real throwaway SQLite database,
 *    and the whole round trip: `jobs.list` dispatched exactly the way any
 *    other caller reaches it.
 *  - Not real: the job's own claim and failure — this spec claims and
 *    fails it directly through `@bloombot/db`'s own `jobs.claimNextJob`/
 *    `markJobFailed`, the same repository functions a real worker calls,
 *    the same "no live `apps/worker` process in this harness" stand-in
 *    `roster-import-panel.spec.ts`'s own module comment already explains.
 *    This is deliberate, not merely convenient: JOB-2's own defect was a
 *    job the panel's *own browser session never dispatched*, so seeding
 *    the failure outside the browser entirely — never once clicking
 *    "Import roster" or polling a job id this page ever held — is what
 *    actually proves the fix rather than merely exercising `jobs.get` on
 *    an id already in hand.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  jobs,
  memberships,
  openDatabase,
} from '@bloombot/db'

import { E2E_DATABASE_PATH } from './support/env.js'
import { readSignInToken } from './support/read-sign-in-token.js'

test('a job that failed permanently in an earlier session is visible on the Jobs tab, with its error and attempt count (JOB-2)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const ownerEmail = `owner-${suffix}@example.edu`

  // 1. Sign in — the same panel-only path every other spec in this suite
  //    establishes.
  await page.goto('/')
  await page.getByLabel('Email').fill(ownerEmail)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(ownerEmail)
  const ownerToken = await readSignInToken(ownerEmail)
  await page.goto(`/sign-in/${ownerToken}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // 2. Seed a `roster.import` job directly, claim it, and fail it
  //    permanently — this spec's own stand-in for "a session that
  //    dispatched a roster import yesterday, then closed" (this file's own
  //    module comment). The payload carries a real-looking email, the same
  //    class of PII JOB-6 exists to stop this exact screen from ever
  //    surfacing.
  let organizationId: string
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const ownerAccount = accounts.getAccountByEmail(ownerEmail, db)
    if (!ownerAccount) throw new Error('setup failed: owner account not found')
    const [ownerMembership] = memberships.listMembershipsForAccount(
      ownerAccount.id,
      db
    )
    if (!ownerMembership) throw new Error('setup failed: membership not found')
    organizationId = ownerMembership.organizationId

    jobs.enqueueJob(
      organizationId,
      {
        kind: 'roster.import',
        payload: {
          courseId: 'course-1',
          csvText: `Ada,Lovelace,ada-${suffix}@example.edu,adalovelace,`,
        },
        maxAttempts: 1,
      },
      db
    )
    const claimed = jobs.claimNextJob(
      ['roster.import'],
      { owner: 'e2e-worker', leaseMs: 60_000 },
      db
    )
    if (!claimed) throw new Error('setup failed: could not claim job')
    jobs.markJobFailed(
      organizationId,
      claimed.id,
      { owner: 'e2e-worker', claimExpiresAt: claimed.claimExpiresAt! },
      'exhausted attempts: upstream timed out',
      db
    )
  } finally {
    closeDatabase(db)
  }

  // 3. The Jobs tab — reached fresh, this browser session having never
  //    dispatched anything and never held this job's own id — lists it
  //    anyway: failed, distinguishable from pending/running, with its own
  //    attempt count and the reason it stopped.
  await page.getByRole('button', { name: 'Jobs' }).click()
  await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible()
  const row = page
    .getByTestId('jobs-list')
    .getByRole('listitem')
    .filter({ hasText: 'roster.import' })
  await expect(row).toContainText('Failed')
  await expect(row).toContainText('exhausted attempts: upstream timed out')
  await expect(row).toContainText('Attempt 1 of 1')

  // JOB-6: the roster CSV this job was given never reaches the page —
  // asserted against the page's own rendered content, not merely the type.
  await expect(page.locator('body')).not.toContainText(
    `ada-${suffix}@example.edu`
  )
})
