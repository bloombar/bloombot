/**
 * Wires the health endpoint's `gatewayConnected` flag (SURF-7, `health.ts`)
 * to the gateway's actual lifecycle.
 *
 * Finding 4 of the SURF-1 rework: the flag used to be set `true` on
 * `Events.ClientReady` and never cleared — the endpoint reported "has ever
 * connected", not "is connected". Six hours later the token is rotated or
 * the socket drops: no message is delivered, but the endpoint still answers
 * `200`, so nothing restarts it — exactly the state `health.ts`'s own
 * comment says this endpoint exists to catch. `Events.ShardDisconnect` and
 * `Events.ShardReconnecting` now clear it; `Events.ShardResume` (alongside
 * `ClientReady`) sets it again.
 */

import { Events, type ClientEvents } from 'discord.js'

/**
 * The handful of `Client` methods this needs — a fake emitter satisfies this
 * with no gateway connection at all, which is how this is tested.
 */
export interface GatewayEventSource {
  once<K extends keyof ClientEvents>(
    event: K,
    listener: (...args: ClientEvents[K]) => void
  ): unknown
  on<K extends keyof ClientEvents>(
    event: K,
    listener: (...args: ClientEvents[K]) => void
  ): unknown
}

export function wireGatewayHealth(
  client: GatewayEventSource,
  setConnected: (connected: boolean) => void
): void {
  client.once(Events.ClientReady, () => setConnected(true))
  client.on(Events.ShardResume, () => setConnected(true))
  client.on(Events.ShardDisconnect, () => setConnected(false))
  client.on(Events.ShardReconnecting, () => setConnected(false))
}
