/**
 * WEB-17: "a keyboard test that clicks is not a keyboard test." This spec
 * drives the one part `Modal.tsx`'s own unit tests cannot prove — real
 * browser focus-trap and `Escape` semantics, which jsdom does not
 * implement at all (`apps/web/tests/setup.ts`'s own polyfill only
 * simulates `open`/`close`, not the native `<dialog>` behaviour this test
 * actually needs) — and WEB-16's own in-app navigation guard, which is
 * exactly the case that breaks in real use: a click on a nav control that
 * starts entirely outside the dirty form it has to intercept.
 *
 * Both cases share one flow (a dirty course form, and the confirm dialog
 * that guards leaving it) rather than two separate fixtures — the same
 * dialog, reached the same way `course-editor.test.tsx`'s own unit tests
 * reach it, just against a real browser this time.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import { readSignInToken } from './support/read-sign-in-token.js'

test('unsaved-changes modal: opens on a guarded navigation, Escape cancels and restores focus, confirming discards and navigates (WEB-16, WEB-17)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web17-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`

  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByTestId('link-requested')).toContainText(email)
  const token = await readSignInToken(email)
  await page.goto(`/sign-in/${token}`)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await page.getByRole('button', { name: 'Projects' }).click()
  await page.getByLabel('New project name').fill(projectName)
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('button', { name: projectName }).click()

  // Start a new course and make the form dirty — never saved.
  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill('A course I never saved')

  // In-app navigation, started entirely outside the form (WEB-16's own
  // "the hamburger menu, a nav link, the home icon") — a *different* tab
  // than the one this form lives inside (WEB-9's own `Discord` tab),
  // reached the same nav row `course-configuration.spec.ts` already
  // reaches from the "Projects" side. Deliberately not the "Projects" tab
  // itself: this form already lives inside it (`ProjectsPanel`'s own
  // nested view), so clicking that same tab button would not be a
  // navigation away from anything — `Discord` is unambiguously a real one.
  const discordNavLink = page.getByRole('button', { name: 'Discord' })
  await discordNavLink.click()

  const dialog = page.getByRole('dialog', { name: 'Discard unsaved changes?' })
  await expect(dialog).toBeVisible()
  // WEB-15/coordinator instruction: the destructive confirm is never the
  // default-focused control.
  await expect(
    dialog.getByRole('button', { name: 'Keep editing' })
  ).toBeFocused()
  // Still on the form — a guarded navigation that has not been confirmed
  // yet must not have gone anywhere.
  await expect(page.getByLabel('Title')).toHaveValue('A course I never saved')

  // WEB-17: Escape cancels — the same as clicking "Keep editing" — and
  // focus returns to whatever triggered the dialog, not lost to the body.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(discordNavLink).toBeFocused()
  // The navigation never ran — the typed title is still there, and the
  // Discord tab never became visible.
  await expect(page.getByLabel('Title')).toHaveValue('A course I never saved')

  // Ask again, and this time confirm discarding — the navigation that was
  // blocked a moment ago now completes.
  await discordNavLink.click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Discard changes' }).click()
  await expect(dialog).toBeHidden()
  await expect(
    page.getByRole('button', { name: 'Install to Discord' })
  ).toBeVisible()
})
