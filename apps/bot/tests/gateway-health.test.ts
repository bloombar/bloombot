/**
 * `wireGatewayHealth` (finding 4 of the SURF-1 rework): the health
 * endpoint's `gatewayConnected` flag tracks the gateway's actual state, not
 * just "has it ever connected". Exercised against a fake emitter — no real
 * discord.js `Client`, no gateway connection at all.
 */

import { Events } from 'discord.js'
import { describe, expect, it } from 'vitest'

import {
  wireGatewayHealth,
  type GatewayEventSource,
} from '../src/gateway-health.js'

/**
 * The smallest fake that behaves like `GatewayEventSource` — records
 * listeners and lets a test fire them directly, the same shape a real
 * discord.js `Client` (or `EventEmitter`) exposes. Not typed against
 * `GatewayEventSource` itself: its generic, per-event-name overload is
 * awkward to restate exactly on a fake, so this is cast at the one call site
 * that needs it, the same way `packages/discord/tests/helpers/fake-logger.ts`
 * casts a fake pino `Logger`.
 */
class FakeGatewayEventSource {
  private readonly listeners = new Map<
    string,
    ((...args: unknown[]) => void)[]
  >()

  once(event: string, listener: (...args: unknown[]) => void): this {
    return this.on(event, listener)
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event) ?? []
    existing.push(listener)
    this.listeners.set(event, existing)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  asEventSource(): GatewayEventSource {
    return this as unknown as GatewayEventSource
  }
}

describe('wireGatewayHealth (finding 4)', () => {
  it('sets connected true on ClientReady', () => {
    const source = new FakeGatewayEventSource()
    let connected = false
    wireGatewayHealth(source.asEventSource(), (value) => {
      connected = value
    })

    source.emit(Events.ClientReady)

    expect(connected).toBe(true)
  })

  // The regression this rework fixes: the flag used to be set once and
  // never cleared, so it reported "has ever connected" rather than "is
  // connected".
  it('clears connected on ShardDisconnect, after having been connected', () => {
    const source = new FakeGatewayEventSource()
    let connected = false
    wireGatewayHealth(source.asEventSource(), (value) => {
      connected = value
    })
    source.emit(Events.ClientReady)
    expect(connected).toBe(true)

    source.emit(Events.ShardDisconnect, { code: 1006 }, 0)

    expect(connected).toBe(false)
  })

  it('clears connected on ShardReconnecting', () => {
    const source = new FakeGatewayEventSource()
    let connected = false
    wireGatewayHealth(source.asEventSource(), (value) => {
      connected = value
    })
    source.emit(Events.ClientReady)

    source.emit(Events.ShardReconnecting, 0)

    expect(connected).toBe(false)
  })

  it('sets connected true again on ShardResume', () => {
    const source = new FakeGatewayEventSource()
    let connected = false
    wireGatewayHealth(source.asEventSource(), (value) => {
      connected = value
    })
    source.emit(Events.ClientReady)
    source.emit(Events.ShardDisconnect, { code: 1006 }, 0)
    expect(connected).toBe(false)

    source.emit(Events.ShardResume, 0, 3)

    expect(connected).toBe(true)
  })
})
