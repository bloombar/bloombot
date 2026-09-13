/**
 * ENRL-17: the named expiry durations a course join link may be issued
 * with — the single definition `packages/actions`' `courseJoinLinks.create`
 * (`expiresIn`) and `apps/web/src/components/JoinLinks.tsx`'s own picker
 * both read, replacing the duration table that used to live only in
 * `JoinLinks.tsx` (`EXPIRY_OPTIONS`, that component's own module comment on
 * the client-side arithmetic this file now replaces). Two copies of the
 * same value/label/duration table is exactly the kind of thing that drifts
 * the moment one is edited and the other is not — the same "shared
 * definition, not two independent tables" reasoning `web-source-domain.ts`'s
 * own module comment gives for living in `@bloombot/schemas` rather than in
 * whichever package happened to need it first.
 *
 * Rework round 1, must-fix 1: `JOIN_LINK_EXPIRY_OPTIONS` is now the *only*
 * table — `JoinLinkExpiryValue` (the type `expiresIn` is checked against)
 * and `joinLinkExpirySchema` (the zod enum) are both derived from it, below,
 * rather than a second, hand-maintained list of the same values that could
 * silently drift from the options table (add a row to one, forget the
 * other, and either a real option becomes impossible to select, or a value
 * validates that names no real duration at all — see `resolveJoinLinkExpiry`'s
 * own doc comment for what the second half of that used to do).
 *
 * `durationMs: null` (`'none'`) means no expiry — the default, and the one
 * option every other consumer already treats as "omit the field entirely"
 * rather than a duration to add to anything. Every other option's
 * `durationMs` is only ever meaningful added to the clock *at the moment a
 * link is actually created* — `resolveJoinLinkExpiry`, below, takes `now`
 * as an explicit argument rather than reading `Date.now()` itself, so a
 * caller controls exactly when that addition happens (`courseJoinLinks.create`'s
 * own `execute` calls it against the clock at the moment that action runs,
 * never earlier).
 */

import { z } from 'zod'

/**
 * The one source of truth: `courseJoinLinks.create`'s `expiresIn` accepts
 * any of these `value`s, and `JoinLinks.tsx`'s picker shows exactly these
 * `label`s, in this order. Anything longer than "1 term" is left to an
 * instructor choosing an absolute `expiresAt` directly, which
 * `courseJoinLinks.create` still accepts — this table exists to name the
 * durations an instructor is actually thinking in (WEB-23's own "weeks, not
 * timestamps"), not to be the only way to set an expiry at all.
 *
 * `as const`, not merely typed `JoinLinkExpiryOption[]`: `JoinLinkExpiryValue`
 * and `joinLinkExpirySchema` (below) both read their values off this array's
 * own literal types, which only exist because of `as const` — a plain
 * `JoinLinkExpiryOption[]` would widen every `value` to `string`, and there
 * would be nothing left to derive an enum from.
 */
export const JOIN_LINK_EXPIRY_OPTIONS = [
  { value: 'none', label: 'Never', durationMs: null },
  { value: '1d', label: '1 day', durationMs: 24 * 60 * 60 * 1000 },
  { value: '1w', label: '1 week', durationMs: 7 * 24 * 60 * 60 * 1000 },
  { value: '1mo', label: '1 month', durationMs: 30 * 24 * 60 * 60 * 1000 },
  {
    value: '1term',
    label: '1 term (16 weeks)',
    durationMs: 16 * 7 * 24 * 60 * 60 * 1000,
  },
] as const

/** One of the durations a join link's `expiresIn` may name. `'none'` — no expiry. Derived from `JOIN_LINK_EXPIRY_OPTIONS`'s own `value`s, not a second, independently-typed list. */
export type JoinLinkExpiryValue =
  (typeof JOIN_LINK_EXPIRY_OPTIONS)[number]['value']

/** One named duration option: the value a caller sends, the label a picker shows, and the duration in milliseconds to add to the clock at creation time — `null` for "never". */
export type JoinLinkExpiryOption = (typeof JOIN_LINK_EXPIRY_OPTIONS)[number]

/**
 * Validates a caller-supplied `expiresIn` against `JoinLinkExpiryValue` —
 * used by `courseJoinLinks.create`'s own input schema and reusable by any
 * other caller that needs the same check. Built from `JOIN_LINK_EXPIRY_OPTIONS`'s
 * own `value`s (`.map`, cast to the tuple shape `z.enum` requires — safe here
 * only because the source is the same `as const` array `JoinLinkExpiryValue`
 * itself is derived from, so the cast cannot introduce a value the options
 * table does not actually carry), not a second, hand-typed tuple that could
 * fall out of step with it.
 */
export const joinLinkExpirySchema = z.enum(
  JOIN_LINK_EXPIRY_OPTIONS.map((option) => option.value) as [
    JoinLinkExpiryValue,
    ...JoinLinkExpiryValue[],
  ]
)

/**
 * `value` resolved against the clock at `now` — `null` for "no expiry"
 * (`'none'`), otherwise `now + durationMs`. `courseJoinLinks.create`'s own
 * `execute` is the one caller that matters: it calls this with `Date.now()`
 * at the moment a link is actually created, never earlier, the same "never
 * computed ahead of when it is used" discipline `JoinLinks.tsx` used to
 * hold itself to by hand before this file existed.
 *
 * Rework round 1, must-fix 1: fails closed, not open. `option` can only be
 * missing here if `value` is not one of `JOIN_LINK_EXPIRY_OPTIONS`'s own
 * literal `value`s — impossible for any caller that went through
 * `joinLinkExpirySchema` first, since that schema is derived from this same
 * table (above) — but this used to return `null` ("no expiry") for that
 * case anyway, the same value it returns for a deliberate `'none'`. A future
 * edit that let the two drift (a value added to `joinLinkExpirySchema`
 * without a matching options row, however that happened) would then have
 * `courseJoinLinks.create` report success while silently issuing a link
 * that never expires — the exact failure mode this function must not have.
 * Throwing instead means that kind of drift is loud wherever it first
 * reaches this function, rather than indistinguishable from an instructor's
 * own choice of "never."
 */
export function resolveJoinLinkExpiry(
  value: JoinLinkExpiryValue,
  now: number
): number | null {
  const option = JOIN_LINK_EXPIRY_OPTIONS.find(
    (candidate) => candidate.value === value
  )
  if (!option) {
    throw new Error(
      `resolveJoinLinkExpiry: "${value}" names no row in JOIN_LINK_EXPIRY_OPTIONS`
    )
  }
  if (option.durationMs === null) return null
  return now + option.durationMs
}
