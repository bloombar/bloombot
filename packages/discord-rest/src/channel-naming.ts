/**
 * Discord's own slugging of a `GUILD_TEXT` channel's `name` at creation —
 * lowercased, every run of whitespace collapsed to a single `-`. Both
 * `apps/worker`'s job handlers that name a channel (`discord-scaffold.ts`,
 * `roster-import.ts`) need this exact transform before comparing a
 * *declared* name against what `listGuildChannels` actually returns, since
 * Discord itself already applied it server-side; every test fake that
 * stands in for the real API (`apps/worker/tests/helpers/
 * fake-discord-guild-server.ts`, `e2e/support/fake-discord-guild-server.ts`)
 * needs the identical transform for the same reason, on the other side of
 * the same comparison.
 *
 * This used to be four separate, hand-copied definitions — two handlers,
 * two fakes — on the theory that an app does not share this kind of thing
 * with another app, or with a test helper, via a package it does not own.
 * That theory held right up until one of the four drifted from the other
 * three (a fake that echoed a posted name verbatim, unslugged), which hid a
 * real bug — a declared channel with a space in its name duplicating on
 * every run — for a week, because the fake no longer disagreed with the
 * handler that was wrong. A single misspelling here is now a compile error
 * everywhere it matters, not a silent divergence discovered by accident:
 * `packages/discord-rest` is a boundary every one of those four already
 * crosses (three import a real client from it; the fourth, `e2e`'s own
 * fake, stands in for the same client's own server), so exporting this one
 * pure function through it costs nothing structurally and closes the gap
 * for good.
 */
export function normalizeChannelName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-')
}
