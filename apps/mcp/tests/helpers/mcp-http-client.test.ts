/**
 * A regression test for the harness itself, not for `apps/mcp`'s own code —
 * `mcp-http-client.ts`'s own module comment, and `docs/DECISIONS.md` D-24,
 * have the full account of the collision this guards against.
 *
 * `supertest`'s own `app.listen(0)` binds the wildcard address with no
 * host, and `SO_REUSEADDR` lets the OS hand that an ephemeral port some
 * *other* process already holds bound specifically to `127.0.0.1` — the
 * more specific binding then wins every connection, so a test's requests
 * reach that other process instead of the app under test, silently.
 * `startTestServer` fixes this by binding to `127.0.0.1` itself before
 * handing supertest an already-listening server — but a fix like that is
 * only as good as the proof that it fails loudly on a genuine collision
 * rather than finding some other quiet way to shadow it. This test forces
 * that exact collision: a squatter bound to a specific `127.0.0.1` port,
 * then `startTestServer` asked for that same port. Copied from
 * `apps/api/tests/helpers/build-test-app.test.ts` (D-24's own "Limits"
 * section names this exact test as the regression to bring along with the
 * fix, for the first future package to need it — MCP-6 is that package),
 * duplicated rather than imported across an app boundary test helpers are
 * not published through (`test-db.ts`'s own module comment).
 */

import { createServer } from 'node:http'

import express from 'express'
import { describe, expect, it } from 'vitest'

import { startTestServer } from './mcp-http-client.js'

describe('startTestServer — the port-collision fix (MCP-6, D-24)', () => {
  it('fails loudly (EADDRINUSE) on an already-bound loopback port rather than silently shadowing it', async () => {
    // The squatter: an ordinary server bound to a specific `127.0.0.1`
    // port, the same shape as the VS Code helper sockets and other local
    // processes D-24's own investigation found already doing exactly this.
    const squatter = createServer((_req, res) => res.end('squatter'))
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject)
      squatter.listen(0, '127.0.0.1', () => resolve())
    })

    const address = squatter.address()
    if (address === null || typeof address === 'string') {
      throw new Error('test setup: squatter did not bind a loopback port')
    }
    const { port } = address

    try {
      // Asking `startTestServer` for the exact port the squatter holds must
      // reject with `EADDRINUSE` — the property that makes this whole class
      // of bug impossible rather than merely unlikely, and the one a fix
      // that only reduced the odds (a retry loop, a different but
      // still-shared address) would not have. A silent success here (e.g.
      // landing on some other port, or on the squatter itself) would be
      // this test failing to catch a regression of the fix.
      await expect(startTestServer(express(), port)).rejects.toMatchObject({
        code: 'EADDRINUSE',
      })
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()))
    }
  })
})
