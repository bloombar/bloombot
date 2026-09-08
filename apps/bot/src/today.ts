/**
 * `YYYY-MM-DD` for the daily allowance's own day boundary (BOT-11) — the one
 * clock `apps/bot` reads (`handleMention`'s own `day` is always supplied by
 * its caller, never read from a clock inside it, the same CORE-3 discipline
 * `answerQuestion` holds itself to).
 *
 * Finding 5 of the SURF-1 rework: this used to build the string with
 * `toISOString()`, which always reports UTC — a US-Eastern class's day
 * reset at 8pm local time, mid-evening, not midnight. `Date`'s own
 * `getFullYear`/`getMonth`/`getDate` read the runtime's local timezone
 * instead, which is what BOT-11 actually asks for; deployment sets the
 * process's own `TZ` to the class's timezone.
 */

/** `now` defaults to the real clock; a test supplies a fixed one. */
export function today(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
