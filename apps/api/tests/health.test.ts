/**
 * API-6: the health endpoint reports whether this process can actually
 * serve, not merely that it is running — proven by making the database
 * itself unreachable and checking the endpoint notices, not by reading
 * `health.ts`'s own source.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { closeDatabase, openDatabase, runMigrations } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { buildTestApp } from './helpers/build-test-app.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase | undefined

afterEach(() => {
  testDb?.cleanup()
  testDb = undefined
})

describe('API-6 — the health endpoint', () => {
  it('reports ready when the database is reachable', async () => {
    testDb = createTestDatabase()
    const app = buildTestApp(testDb.db)

    const response = await request(app).get('/health')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ ready: true, database: true })
  })

  it('reports not-ready (503) when the database is unreachable', async () => {
    // Managed independently of the shared `testDb`/`afterEach` above: the
    // database connection itself is closed *underneath* the app as this
    // test's own way of making it unreachable, so it must not be closed a
    // second time by the shared cleanup.
    const tmpRoot = join(process.cwd(), 'tmp', 'api-tests')
    mkdirSync(tmpRoot, { recursive: true })
    const path = join(tmpRoot, `${randomUUID()}.db`)
    const db = openDatabase(path)
    runMigrations(db)
    const app = buildTestApp(db)

    // The connection is closed while the app still holds a reference to
    // it — the same "reachable one moment, gone the next" shape a real
    // outage takes, closer than never opening a database at all.
    closeDatabase(db)

    const response = await request(app).get('/health')

    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ ready: false, database: false })

    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { force: true })
    }
  })
})
