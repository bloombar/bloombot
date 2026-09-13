/**
 * WEB-48, end to end: the field report was "the panel is difficult to read
 * on mobile, and pages sometimes zoom in automatically" — this spec drives
 * a real phone-width browser (`playwright.config.ts`'s own `mobile`
 * project, 375x667) through the panel's main screens and checks the two
 * concrete things that report cashes out to:
 *
 *  - no screen ever grows wider than its own viewport (a page that scrolls
 *    sideways is the "difficult to read" half — a person has to pan left
 *    and right just to see a form), and
 *  - focusing a text input never changes `window.visualViewport.scale`
 *    (the "zooms in automatically" half — `fieldStyles.ts`'s own module
 *    comment on why a focused field's font size has to stay at or above
 *    16px, since a smaller one is what iOS Safari zooms in on and never
 *    zooms back out from).
 *
 * **What is real, and what is a harness stand-in — read this before
 * trusting what this test proves** (the same discipline
 * `navigation-drawer.spec.ts`'s own module comment holds itself to): the
 * browser, a real `apps/api`, and a real throwaway SQLite database are all
 * real — the same stack every other spec in this suite drives. This spec
 * adds nothing on top of that; it only changes the viewport it drives that
 * stack at, and reads two properties (`scrollWidth`,
 * `visualViewport.scale`) an emulated mobile Chromium already keeps
 * faithfully, rather than asserting anything about real iOS Safari itself.
 */

import { randomUUID } from 'node:crypto'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { navigateTo } from './support/navigate.js'
import { signIn } from './support/sign-in.js'

/**
 * `window`/`document` — Node's own type lib (`tsconfig.base.json` carries
 * no `dom` lib, only `ES2023`) declares neither, even though every
 * `page.evaluate` callback below runs in the real browser this page
 * controls, not in this test process — the same narrow, deliberate `as`
 * `chat-scroll.spec.ts`'s own module comment already uses for the same
 * reason. Cast inline, inside each callback: Playwright serializes an
 * `evaluate` callback and re-runs it in the browser, so it cannot close
 * over a helper type defined out here in a way that would let a bare
 * `window`/`document` typecheck.
 */
type BrowserWindow = {
  document: { documentElement: { scrollWidth: number } }
  innerWidth: number
  visualViewport?: { scale: number }
}

/**
 * The requirement's own standard: nothing on the page body should be wider
 * than the viewport itself. `scrollWidth` is the page's actual rendered
 * width, including anything that overflows without a scroll container of
 * its own — a value greater than `innerWidth` is exactly "the page scrolls
 * sideways."
 */
async function assertNoHorizontalOverflow(page: Page, screen: string) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => {
    const win = globalThis as unknown as BrowserWindow
    return {
      scrollWidth: win.document.documentElement.scrollWidth,
      innerWidth: win.innerWidth,
    }
  })
  expect(
    scrollWidth,
    `${screen} should not overflow horizontally`
  ).toBeLessThanOrEqual(innerWidth)
}

/**
 * The other half of the report: focusing a field must never change the
 * page's own zoom level. `visualViewport.scale` is the browser's own
 * record of that — unlike `document.documentElement.scrollWidth` above,
 * this is a property a real iOS Safari changes out from under a page (and
 * never restores) when a focused input's font-size falls under 16px; a
 * fixed `fieldStyles.ts` token is what keeps this assertion meaningful
 * rather than trivially true everywhere.
 */
async function assertFocusDoesNotZoom(field: Locator, page: Page) {
  const readScale = () =>
    page.evaluate(
      () => (globalThis as unknown as BrowserWindow).visualViewport?.scale
    )
  const before = await readScale()
  await field.focus()
  const after = await readScale()
  expect(after).toBe(before)
}

test('the panel is readable on a phone: no screen overflows sideways, and no field zooms the page on focus (WEB-48)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web48-${suffix}@example.edu`
  const projectName = `Mobile QA — ${suffix}`
  const courseTitle = `Mobile Course — ${suffix}`

  // 1. The shell itself — header, drawer, footer — right after signing in.
  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()
  await assertNoHorizontalOverflow(
    page,
    'the shell (Projects, the default tab)'
  )

  // The drawer is the only nav at every width (WEB-29) — opening it should
  // not itself widen the page (a drawer bug here would be a regression in
  // `components/AppShell.tsx`, not this slice, but the assertion is cheap
  // and the drawer is exactly the kind of fixed-width overlay that risks
  // it).
  await page.getByRole('button', { name: 'Open navigation menu' }).click()
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible()
  await assertNoHorizontalOverflow(page, 'the shell with the drawer open')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeHidden()

  // 2. A modal: "New project" (WEB-27). Also the first focused text field
  //    this spec drives, so the zoom assertion rides along with it.
  await page.getByRole('button', { name: 'New project' }).click()
  const newProjectDialog = page.getByRole('dialog', { name: 'New project' })
  await expect(newProjectDialog).toBeVisible()
  await assertNoHorizontalOverflow(page, 'the "New project" modal')
  const projectNameField = newProjectDialog.getByLabel('Project name')
  await assertFocusDoesNotZoom(projectNameField, page)
  await projectNameField.fill(projectName)
  await newProjectDialog.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: projectName, exact: true }).click()
  await assertNoHorizontalOverflow(page, 'a project (no courses yet)')

  // 3. The course editor (WEB-35): five tabs in a row, and several of the
  //    panel's own text inputs.
  await page.getByRole('button', { name: 'New course' }).click()
  await assertNoHorizontalOverflow(page, 'the course editor (General tab)')
  const titleField = page.getByLabel('Title')
  await assertFocusDoesNotZoom(titleField, page)
  await titleField.fill(courseTitle)
  await page.getByLabel('Admins role').fill(`admins-${suffix}`)
  await page.getByLabel('Students role').fill(`students-${suffix}`)
  await page.getByRole('button', { name: 'Save course' }).click()
  await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()
  await assertNoHorizontalOverflow(page, 'the course editor after saving')

  // Every tab, not only the first — WEB-35's own tab row is five buttons
  // wide, the highest-risk row in this screen at 375px.
  for (const tabName of ['AI', 'Discord', 'Roster', 'People', 'General']) {
    await page.getByRole('tab', { name: tabName }).click()
    await assertNoHorizontalOverflow(page, `the course editor (${tabName} tab)`)
  }

  // 4. A table-bearing screen: Team, which lists every member of this
  //    organization as a row with a name, a role and (where permitted) a
  //    control.
  await navigateTo(page, 'Team')
  await expect(page.getByTestId('team-panel')).toBeVisible()
  await assertNoHorizontalOverflow(page, 'the Team panel')
})
