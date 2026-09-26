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
 * Opens the drawer and clicks the nav item named `label` — Projects, Chat,
 * Transcripts, MCP or "Organization settings"
 * (`pages/Shell.tsx`'s own two nav groups). Waits for the drawer to
 * actually finish closing before returning, not merely for the click to
 * register: `e2e/keyboard.spec.ts`'s own module comment has the "why" —
 * WEB-29's own slide transition defers the underlying `dialog.close()`
 * briefly rather than calling it immediately, and a native modal
 * `<dialog>` makes the rest of the document inert for as long as it is
 * open, so a caller that does not wait risks its very next interaction
 * landing on an inert element (confirmed directly while building this
 * helper — see `docs/DECISIONS.md`'s own WEB-29/WEB-30 entry).
 *
 * WEB-69 — Discord, Team, Usage and Jobs are no longer their own nav item;
 * a spec that used to reach one of the four directly now reaches the one
 * "Organization settings" item and picks its own tab —
 * `navigateToOrganizationSettingsTab`, below, is what does both steps.
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
 * WEB-69 — the drawer's own "Organization settings" entry, followed by a
 * click on `tab` (General, Discord, Team, Usage or Jobs) in the tablist it
 * opens on — the two-step replacement for what used to be a single
 * `navigateTo(page, 'Discord')` (or Team/Usage/Jobs) before those four
 * became tabs on one screen rather than their own drawer entries. Skips the
 * tab click when `tab` is General — the first tab, and so already showing
 * once the drawer item lands — the same way `pages/Shell.tsx`'s own
 * `ORGANIZATION_SETTINGS_TABS[0]` default works everywhere else in this
 * app. Rework round 1 gave the Danger zone its own tab, reachable here as
 * `'Danger zone'`; the user's own final decision put it back at the bottom
 * of General instead, so reaching it is `'General'`, the same as the name
 * field above it.
 */
export async function navigateToOrganizationSettingsTab(
  page: Page,
  tab: 'General' | 'Discord' | 'Team' | 'Usage' | 'Jobs'
): Promise<void> {
  await navigateTo(page, 'Organization settings')
  if (tab === 'General') return
  await page.getByRole('tab', { name: tab }).click()
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
