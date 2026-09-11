/**
 * SURF-9 follow-up — an in-process set of Discord message ids the live path
 * (`message-handler.ts#onMessageCreate`) has *begun* handling but has not
 * yet recorded to `discord_handled_messages`.
 *
 * Why this exists (`docs/DECISIONS.md` D-105 addendum): discord.js queues
 * every non-whitelisted gateway dispatch while `client.ws.status !==
 * Status.Ready`, and only drains that queue (via `setImmediate`) *after*
 * `triggerClientReady()` runs — which is *after* `catch-up.ts`'s own
 * `sessionStart` is captured in the `ShardReady` handler. A mention posted
 * during the brief hydration window after a restart therefore has
 * `createdTimestamp < sessionStart` (so it passes the catch-up scan's own
 * upper bound, MF-C) while its live handling only *starts* running once the
 * scan has already begun — after the scan's own pre-fetch
 * `discordHandledMessages` snapshot, and (until the live handling finishes)
 * before `recordHandledMessage` has written anything either. Both of
 * catch-up's own existing guards (the snapshot and the pre-dispatch
 * `isMessageHandled` re-check, MF3) miss a message in exactly that gap —
 * this set is what closes it: the live path adds a message's id here before
 * it does anything else, and catch-up's own pre-dispatch check consults it
 * alongside `isMessageHandled`.
 *
 * Deliberately in-process and non-durable: a restart empties it completely,
 * and that is fine by design — `discord_handled_messages` remains the one
 * durable, cross-restart record. This set only ever needs to survive the
 * few milliseconds between the live path claiming a message and finishing
 * its own durable write, a window a restart cannot straddle (the live path
 * that started it no longer exists to finish it after one).
 */
export type InFlightMessageIds = Set<string>

/** A fresh, empty set — one instance built in `main()` and threaded into both `MessageHandlerDeps` and `CatchUpDependencies`, rather than a module-level singleton, so a test can supply its own. */
export function createInFlightMessageIds(): InFlightMessageIds {
  return new Set()
}
