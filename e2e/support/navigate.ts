/**
 * WEB-29: the primary navigation moved into a drawer, at every width — the
 * header row this suite's specs used to click directly
 * (`getByRole('button', { name: 'Projects' }).click()`, and the same for
 * every other tab) no longer exists (`components/AppShell.tsx`'s own
 * module comment). Every spec that reaches a tab needs the identical two
 * extra steps: open the drawer from the hamburger, then click the item —
 * pulled out here, once, rather than pasted into each of the specs this
 * broke (the same "one shared place, not twenty edits" discipline
 * `read-sign-in-token.ts`'s own module comment already gives the mail-
 * reading helper).
 */

import { expect, type Page } from '@playwright/test'

/** Opens the navigation drawer from the hamburger control (WEB-14/WEB-29). */
export async function openDrawer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open navigation menu' }).click()
}

/**
 * Opens the drawer and clicks the nav item named `label` — Discord,
 * Projects, Chat, Transcripts, Usage, Team or Jobs
 * (`pages/Shell.tsx`'s own two nav groups). Waits for the drawer to
 * actually finish closing before returning, not merely for the click to
 * register: `e2e/keyboard.spec.ts`'s own module comment has the "why" —
 * WEB-29's own slide transition defers the underlying `dialog.close()`
 * briefly rather than calling it immediately, and a native modal
 * `<dialog>` makes the rest of the document inert for as long as it is
 * open, so a caller that does not wait risks its very next interaction
 * landing on an inert element (confirmed directly while building this
 * helper — see `docs/DECISIONS.md`'s own WEB-29/WEB-30 entry).
 */
export async function navigateTo(page: Page, label: string): Promise<void> {
  await openDrawer(page)
  await page
    .getByRole('dialog', { name: 'Navigation' })
    .getByRole('button', { name: label })
    .click()
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeHidden()
}

/**
 * Opens the drawer and clicks Sign out — the drawer's own foot
 * (`components/AppShell.tsx`'s `drawerFooter` slot), not the header, since
 * WEB-30 moved it there alongside the organization switcher's own move to
 * `headerStart`. No wait for the drawer to close afterward, unlike
 * `navigateTo` above — a successful sign-out navigates the whole screen
 * away (`pages/Shell.tsx#handleSignOut`), so there is no longer a drawer,
 * or a page, left for that wait to matter to.
 */
export async function signOut(page: Page): Promise<void> {
  await openDrawer(page)
  await page
    .getByRole('dialog', { name: 'Navigation' })
    .getByRole('button', { name: 'Sign out' })
    .click()
}
