/**
 * ADMIN-12, end to end: a platform administrator narrows the Users screen
 * to one account by typing into its own search field, then opens it —
 * proving the field actually filters the rows a real `GET /admin/accounts`
 * response returns, not only a fixture in `apps/web/tests/admin.test.tsx`.
 *
 * **What is real, and what is a harness stand-in:**
 *
 *  - Real: two browsers (one student signing in for real, one platform
 *    administrator), a real `apps/api`, a real throwaway SQLite database,
 *    and `routes/admin.ts`'s own `GET /accounts` — reached exactly the way
 *    any other caller reaches it.
 *  - **Not real**: nothing — this spec seeds no rows directly; the two
 *    accounts it searches over are both created by the ordinary sign-in
 *    flow, the ADMIN-4 boundary this console already holds itself to.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import { E2E_ADMIN_EMAIL } from './support/env.js'
import { signIn } from './support/sign-in.js'

test('a platform administrator filters the Users screen down to one account by name, then opens it (ADMIN-12)', async ({
  page,
  browser,
}) => {
  const suffix = randomUUID().slice(0, 8)
  // No `.`/`_`/`-` in the local part — `displayNameFromEmail`
  // (`@bloombot/auth`) capitalizes the first letter and lower-cases the
  // rest with no word breaks to reason about, so this spec can predict the
  // exact display name each student's own sign-in produces
  // (`admin-console-navigation.spec.ts`'s own module comment gives the
  // identical reasoning).
  const emailA = `searchablea${suffix}@example.edu`
  const emailB = `searchableb${suffix}@example.edu`
  const displayNameA = `Searchablea${suffix}`
  const displayNameB = `Searchableb${suffix}`

  // 1. Two students sign in for real, each in their own browser context —
  //    a second `signIn` on the same, already-authenticated `page` has no
  //    sign-in screen left to redeem a link on, the same reason this
  //    spec's own admin identity below gets a context of its own.
  await signIn(page, emailA)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  const studentBContext = await browser.newContext()
  const studentBPage = await studentBContext.newPage()
  try {
    await signIn(studentBPage, emailB)
    await expect(
      studentBPage.getByTestId('organization-switcher')
    ).toBeVisible()
  } finally {
    await studentBContext.close()
  }

  // 2. A platform administrator, in a third, independent browser context —
  //    the same device `admin-console-navigation.spec.ts` already uses for
  //    a second identity.
  const adminContext = await browser.newContext()
  try {
    const adminPage = await adminContext.newPage()
    await signIn(adminPage, E2E_ADMIN_EMAIL)
    await expect(adminPage.getByTestId('organization-switcher')).toBeVisible()

    // `getByRole('link', ...)` throughout, not `getByText` — a plain
    // `getByText(displayNameA)` also matches the row's own email cell
    // below it (Playwright's default text match is case-insensitive, and
    // the email is the same string, lower-cased).
    await adminPage.goto('/platform-admin/users')
    await expect(
      adminPage.getByRole('link', { name: displayNameA })
    ).toBeVisible()
    await expect(
      adminPage.getByRole('link', { name: displayNameB })
    ).toBeVisible()

    // 3. Typing the first student's own email narrows the table to that
    //    one row — the second student's own row disappears, not merely
    //    scrolled past.
    await adminPage.getByLabel('Search users').fill(emailA)
    await expect(
      adminPage.getByRole('link', { name: displayNameA })
    ).toBeVisible()
    await expect(
      adminPage.getByRole('link', { name: displayNameB })
    ).not.toBeVisible()

    // 4. Opening it from the filtered table reaches that exact account's
    //    own screen (ADMIN-11) — the search narrowed which row is visible,
    //    not which one a click actually reaches.
    await adminPage.getByRole('link', { name: displayNameA }).click()
    await expect(
      adminPage.getByRole('heading', { name: displayNameA })
    ).toBeVisible()
  } finally {
    await adminContext.close()
  }
})
