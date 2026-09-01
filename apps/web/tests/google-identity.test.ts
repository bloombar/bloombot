/**
 * `api/google-identity.ts`: loads Google's Identity Services script once,
 * and — the thing under test here — lets a *later* call recover from an
 * earlier failed load (cheap-fix 5 of the WEB-1..6 rework). Before this
 * fix, `scriptLoadPromise ??=` cached the rejected promise from one failed
 * load forever, so `pages/SignIn.tsx`'s own "Try again" could never
 * actually succeed without a full page reload — this test drives the
 * module directly, at the level the bug lived at, rather than through
 * `SignIn`'s own UI.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadGoogleIdentityServices } from '../src/api/google-identity.js'

/** The `<script>` tag `loadGoogleIdentityServices` most recently appended to `document.head`, or `undefined` if none has been. */
function lastScriptTag(): HTMLScriptElement | undefined {
  const scripts = document.head.querySelectorAll<HTMLScriptElement>(
    'script[src="https://accounts.google.com/gsi/client"]'
  )
  return scripts[scripts.length - 1]
}

afterEach(() => {
  delete (window as { google?: unknown }).google
  document.head
    .querySelectorAll('script[src="https://accounts.google.com/gsi/client"]')
    .forEach((node) => node.remove())
})

describe('loadGoogleIdentityServices', () => {
  it('a later call can still succeed after an earlier one failed to load the script', async () => {
    const firstAttempt = loadGoogleIdentityServices()
    const firstScript = lastScriptTag()
    expect(firstScript).toBeDefined()
    firstScript?.onerror?.(new Event('error'))
    await expect(firstAttempt).rejects.toThrow(
      'Could not load Google Identity Services'
    )

    const secondAttempt = loadGoogleIdentityServices()
    const secondScript = lastScriptTag()
    // A second `<script>` tag was actually appended — the fix is not just
    // "the promise resolves eventually," it is that a fresh load is
    // attempted at all, rather than the cached rejection being replayed.
    expect(secondScript).toBeDefined()
    expect(secondScript).not.toBe(firstScript)

    const fakeGoogle = {
      accounts: { id: { initialize: vi.fn(), prompt: vi.fn() } },
    }
    window.google = fakeGoogle
    secondScript?.onload?.(new Event('load'))

    await expect(secondAttempt).resolves.toBe(fakeGoogle)
  })
})
