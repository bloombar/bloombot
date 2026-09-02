/** vitest setup for `apps/web`'s jsdom project: extends `expect` with `@testing-library/jest-dom`'s DOM matchers, and cleans up whatever the previous test rendered so tests never see each other's DOM. */

import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'

afterEach(() => {
  cleanup()
})

/**
 * jsdom (as of the version this app pins) parses `<dialog>` but does not
 * implement `HTMLDialogElement#showModal`/`#close` — both are simply
 * missing methods, not behaviour jsdom gets wrong (verified against this
 * app's own pinned jsdom version while adding `ConfirmDialog.tsx`/
 * `AppShell.tsx`'s mobile drawer, both built on the native element). This
 * polyfill is deliberately minimal: it only reflects `open` the way the
 * real element already does (jsdom's own attribute reflection already
 * works) and fires the events this app's own components listen for
 * (`close`), so a component test can drive "open the dialog, close it" the
 * same way a real browser test does. It does *not* attempt to reproduce
 * the browser's own focus trap or `Escape`-to-cancel behaviour — those are
 * exactly what `e2e/`'s Playwright suite exercises against a real browser
 * instead (WEB-17's own "a keyboard test that clicks is not a keyboard
 * test" applies doubly to a jsdom polyfill of it).
 */
// `tests/bundle.test.ts` overrides this project's own default `jsdom`
// environment back to `node` (its own module comment says why), so
// `HTMLDialogElement` does not exist for every file this setup module
// runs ahead of — guarded rather than assumed.
if (typeof HTMLDialogElement !== 'undefined') {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (
      this: HTMLDialogElement
    ): void {
      this.setAttribute('open', '')
    }
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (
      this: HTMLDialogElement
    ): void {
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    }
  }
}
