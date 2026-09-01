/** vitest setup for `apps/web`'s jsdom project: extends `expect` with `@testing-library/jest-dom`'s DOM matchers, and cleans up whatever the previous test rendered so tests never see each other's DOM. */

import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'

afterEach(() => {
  cleanup()
})
