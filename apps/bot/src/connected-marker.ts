/**
 * SURF-9 rework round 2, MF-B — keeps `discord_gateway_status`'s one row
 * (`@bloombot/db`'s `discordGatewayStatus`) approximately current: the
 * durable "last known connected" marker `catch-up.ts`'s own scan floors its
 * window on, replacing the previous round's `discord_handled_messages`-
 * derived floor, which a quiet server's own prune sweep emptied out from
 * under it (see `docs/DECISIONS.md` D-100's own MF-B note for the fuller
 * reasoning).
 *
 * Updated from three places, all in `index.ts`:
 *  - immediately, whenever the gateway actually becomes connected
 *    (`wireGatewayHealth`'s own callback) — so the marker is never stale by
 *    more than the time since the last genuine connect, not up to a whole
 *    heartbeat interval behind;
 *  - periodically, by the heartbeat this file starts, while connected — so
 *    an ungraceful crash (no clean shutdown ever runs: `SIGKILL`, a power
 *    loss) still leaves a marker no older than one interval, rather than
 *    stuck at whenever this process happened to start;
 *  - once more, directly in `index.ts`'s own shutdown handler, on a clean
 *    shutdown — marking the exact moment this process stopped serving.
 */

import { discordGatewayStatus, type Database } from '@bloombot/db'

/**
 * How often the marker is refreshed while connected. Generous rather than
 * tight on purpose: the marker only has to be within this margin of the
 * truth (SURF-9's own tolerance is a lookback measured in hours, not
 * seconds), and a shorter interval just means more writes for no
 * observable benefit — this needs no configuration of its own.
 */
export const CONNECTED_MARKER_HEARTBEAT_MS = 60_000

export interface ConnectedMarkerHeartbeat {
  /** Stops the heartbeat. Idempotent — a second call is a no-op. */
  stop: () => void
}

/**
 * Starts a timer that records `Date.now()` as the last known connected
 * moment every `intervalMs`, but only while `isConnected()` reports `true` —
 * the marker must never advance while this process is *not* actually
 * connected, or a later catch-up scan would wrongly believe messages sent
 * during the outage had already been seen.
 */
export function startConnectedMarkerHeartbeat(
  db: Database,
  isConnected: () => boolean,
  intervalMs: number = CONNECTED_MARKER_HEARTBEAT_MS
): ConnectedMarkerHeartbeat {
  const timer = setInterval(() => {
    if (isConnected()) {
      discordGatewayStatus.recordLastKnownConnected(Date.now(), db)
    }
  }, intervalMs)
  // Node keeps the process alive for a pending timer by default; `unref()`
  // means a caller that forgets to `stop()` this (a test, most often) never
  // blocks the process from exiting on that account alone. `index.ts`'s own
  // shutdown path still calls `stop()` explicitly, so a live timer never
  // outlives an intentional shutdown either.
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}
