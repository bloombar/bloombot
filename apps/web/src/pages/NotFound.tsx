/**
 * WEB-32: rendered for an address `routing/route.ts#parseRoute` could not
 * recognise at all, and for one that names an organization this signed-in
 * account has no relationship to (neither a membership nor a connected
 * identity — `App.tsx`'s own check, since only it holds the account summary
 * needed to answer that). The brief's own words: "a not-found screen that
 * says so and offers a link home" — never an empty shell, and never a leak
 * of which organizations *do* exist by rendering differently for one that
 * simply isn't offered to this account than for one that never existed at
 * all.
 */

import { Button } from '../components/Button.js'

export interface NotFoundProps {
  onHome: () => void
}

export function NotFound({ onHome }: NotFoundProps) {
  return (
    <div
      className="flex flex-col items-start gap-3 p-6"
      data-testid="not-found-page"
    >
      <h1 className="text-page-title font-semibold text-neutral-900">
        Not found
      </h1>
      <p className="text-sm text-neutral-600">
        There is nothing here — the address may be mistyped, or this account
        does not have access to it.
      </p>
      <Button variant="primary" onClick={onHome}>
        Go home
      </Button>
    </div>
  )
}
