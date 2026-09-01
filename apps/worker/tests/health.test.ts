/**
 * JOB-5's health endpoint — reports whether this process can actually
 * work: the database reachable, and how deep the queue currently is.
 * Proven by making the database itself unreachable and checking the
 * endpoint notices, not by reading `health.ts`'s own source (the same
 * discipline `apps/api/tests/health.test.ts` holds itself to). No network
 * beyond loopback.
 */

import { randomUUID } from 'node:crypto'

import { closeDatabase, jobs, organizations } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  checkWorkerHealth,
  startHealthServer,
  workerHealthStatus,
  type HealthServer,
} from '../src/health.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase | undefined
let server: HealthServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  testDb?.cleanup()
  testDb = undefined
})

/** Finds a free loopback port, the same device `apps/bot/tests/health.test.ts` uses. */
async function findFreePort(): Promise<number> {
  const { createServer } = await import('node:http')
  const probe = createServer()
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        throw new Error('findFreePort: could not read the assigned port')
      }
      resolve(address.port)
    })
  })
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

describe('checkWorkerHealth', () => {
  it('reports ready and the queue depth when the database is reachable', () => {
    testDb = createTestDatabase()
    const organizationId = randomUUID()
    organizations.createOrganization(
      organizationId,
      { name: 'Org', isPersonal: false },
      testDb.db
    )
    jobs.enqueueJob(
      organizationId,
      { kind: 'noop', payload: {}, maxAttempts: 1 },
      testDb.db
    )

    const status = checkWorkerHealth(testDb.db)

    expect(status).toEqual({ ready: true, database: true, queueDepth: 1 })
  })

  it('reports not-ready, and no queue depth read, when the database is unreachable', () => {
    testDb = createTestDatabase()
    // The connection is closed underneath this call — the same "reachable
    // one moment, gone the next" shape a real outage takes, closer than
    // never opening a database at all (the same device
    // `apps/api/tests/health.test.ts` uses).
    closeDatabase(testDb.db)

    const status = checkWorkerHealth(testDb.db)

    expect(status).toEqual({ ready: false, database: false, queueDepth: 0 })
  })
})

describe('workerHealthStatus (rework finding 6)', () => {
  it('reports the database as reachable while draining, not hardcoded false', () => {
    testDb = createTestDatabase()

    const status = workerHealthStatus(testDb.db, true)

    // Before this fix, `index.ts` hardcoded `database: false` for the whole
    // drain — untrue here, since the connection is still open — which read
    // to an operator as a database outage rather than an orderly shutdown.
    expect(status).toEqual({ ready: false, database: true, queueDepth: 0 })
  })

  it('still reports the database unreachable while draining once it is actually closed', () => {
    testDb = createTestDatabase()
    closeDatabase(testDb.db)

    const status = workerHealthStatus(testDb.db, true)

    expect(status).toEqual({ ready: false, database: false, queueDepth: 0 })
  })

  it('matches checkWorkerHealth exactly when not shutting down', () => {
    testDb = createTestDatabase()

    expect(workerHealthStatus(testDb.db, false)).toEqual(
      checkWorkerHealth(testDb.db)
    )
  })
})

describe('startHealthServer (JOB-5)', () => {
  it('reports 200 when ready, 503 when not, from whatever getStatus returns fresh on each request', async () => {
    let ready = false
    const port = await findFreePort()
    server = await startHealthServer(port, () => ({
      ready,
      database: ready,
      queueDepth: 0,
    }))

    const before = await fetch(`http://127.0.0.1:${port}`)
    expect(before.status).toBe(503)
    expect(await before.json()).toEqual({
      ready: false,
      database: false,
      queueDepth: 0,
    })

    ready = true
    const after = await fetch(`http://127.0.0.1:${port}`)
    expect(after.status).toBe(200)
    expect(await after.json()).toMatchObject({ ready: true })
  })

  it('binds only the loopback interface, not every interface', async () => {
    const { Server } = await import('node:http')
    const { vi } = await import('vitest')
    const listenSpy = vi.spyOn(Server.prototype, 'listen')
    const port = await findFreePort()
    server = await startHealthServer(port, () => ({
      ready: true,
      database: true,
      queueDepth: 0,
    }))

    const call = listenSpy.mock.calls.find((args) => args[0] === port)
    expect(call?.[1]).toBe('127.0.0.1')
    listenSpy.mockRestore()
  })

  it('rejects clearly, rather than throwing an uncaught exception, when the port is already in use (PLAT-4)', async () => {
    const port = await findFreePort()
    server = await startHealthServer(port, () => ({
      ready: true,
      database: true,
      queueDepth: 0,
    }))

    await expect(
      startHealthServer(port, () => ({
        ready: true,
        database: true,
        queueDepth: 0,
      }))
    ).rejects.toThrow(/already in use/)
  })
})
