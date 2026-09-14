/**
 * MCP-11: the app's own logo, name and one-line description — the header
 * every sign-in surface shows above the panel's own `SignIn`, exactly once.
 *
 * Extracted from `pages/Home.tsx`, which used to hand-write this same markup
 * itself while every *other* signed-out surface (`App.tsx`'s own generic
 * fallback, `pages/JoinLink.tsx`, `pages/Invitation.tsx`, and
 * `pages/Connect.tsx`'s own smaller, separately hand-written `BrandHeader`)
 * rendered a bare `SignIn` with no header at all — one screen identified the
 * service before asking someone to sign into it, and every other one just
 * asked. `Home`'s own rendered output is unchanged by this extraction (same
 * elements, same classes, now behind one shared component instead of
 * hand-written twice), which is what `tests/home.test.tsx` and Google's own
 * OAuth homepage requirement both depend on.
 */

import { Logo } from './Logo.js'

export function SignInHeader() {
  return (
    <header className="flex flex-col items-center text-center">
      <Logo className="size-16" title="Bloombot" />
      <h1 className="mt-4 text-2xl font-semibold text-neutral-900">Bloombot</h1>
      <p className="mt-2 max-w-xl text-base text-neutral-700">
        A teaching assistant that answers students’ course questions on Discord,
        on the web, and through ChatGPT, Claude and other assistants, using the
        material their instructor supplies.
      </p>
    </header>
  )
}
