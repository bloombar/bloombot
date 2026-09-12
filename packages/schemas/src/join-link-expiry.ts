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

// The values a caller may name — a plain tuple, not derived from
// `JOIN_LINK_EXPIRY_OPTIONS` below, so `z.enum` gets the literal tuple type
// it needs rather than a widened `string[]`.
const JOIN_LINK_EXPIRY_VALUES = ['none', '1d', '1w', '1mo', '1term'] as const

/** One of the durations a join link's `expiresIn` may name. `'none'` — no expiry. */
export type JoinLinkExpiryValue = (typeof JOIN_LINK_EXPIRY_VALUES)[number]

/** Validates a caller-supplied `expiresIn` against `JoinLinkExpiryValue` — used by `courseJoinLinks.create`'s own input schema and reusable by any other caller that needs the same check. */
export const joinLinkExpirySchema = z.enum(JOIN_LINK_EXPIRY_VALUES)

/** One named duration option: the value a caller sends, the label a picker shows, and the duration in milliseconds to add to the clock at creation time — `null` for "never". */
export interface JoinLinkExpiryOption {
  value: JoinLinkExpiryValue
  label: string
  durationMs: number | null
}

/**
 * The durations offered end to end: `courseJoinLinks.create`'s `expiresIn`
 * accepts any of these `value`s, and `JoinLinks.tsx`'s picker shows exactly
 * these `label`s, in this order. Anything longer than "1 term" is left to
 * an instructor choosing an absolute `expiresAt` directly, which
 * `courseJoinLinks.create` still accepts — this table exists to name the
 * durations an instructor is actually thinking in (WEB-23's own "weeks, not
 * timestamps"), not to be the only way to set an expiry at all.
 */
export const JOIN_LINK_EXPIRY_OPTIONS: readonly JoinLinkExpiryOption[] = [
  { value: 'none', label: 'Never', durationMs: null },
  { value: '1d', label: '1 day', durationMs: 24 * 60 * 60 * 1000 },
  { value: '1w', label: '1 week', durationMs: 7 * 24 * 60 * 60 * 1000 },
  { value: '1mo', label: '1 month', durationMs: 30 * 24 * 60 * 60 * 1000 },
  {
    value: '1term',
    label: '1 term (16 weeks)',
    durationMs: 16 * 7 * 24 * 60 * 60 * 1000,
  },
]

/**
 * `value` resolved against the clock at `now` — `null` for "no expiry"
 * (`'none'`, or any value this table does not carry a positive duration
 * for), otherwise `now + durationMs`. `courseJoinLinks.create`'s own
 * `execute` is the one caller that matters: it calls this with `Date.now()`
 * at the moment a link is actually created, never earlier, the same "never
 * computed ahead of when it is used" discipline `JoinLinks.tsx` used to
 * hold itself to by hand before this file existed.
 */
export function resolveJoinLinkExpiry(
  value: JoinLinkExpiryValue,
  now: number
): number | null {
  const option = JOIN_LINK_EXPIRY_OPTIONS.find(
    (candidate) => candidate.value === value
  )
  if (!option || option.durationMs === null) return null
  return now + option.durationMs
}
