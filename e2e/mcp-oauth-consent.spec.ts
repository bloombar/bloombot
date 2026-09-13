/**
 * MCP-7/MCP-11, end to end: connecting an assistant, reached through the
 * *exact* routing a real browser uses — `vite preview`'s own proxy
 * (`apps/web/vite.config.ts`), the same shape nginx's own `location` blocks
 * reproduce in production (`docs/DEPLOY_DROPLET.md`).
 *
 * **Why this spec exists — a defect this repository's own supertest-only
 * coverage could not see.** A security review found that
 * `apps/mcp/src/index.ts` builds `authorize()`'s consent URL as
 * `${PUBLIC_APP_URL}/oauth/mcp/authorize` (now `/connect-assistant/:id`,
 * MCP-11), but nothing routed the API half of this flow to `apps/api` at
 * all: `apps/web/vite.config.ts`'s own proxy allowlist (and the matching
 * nginx block) omitted `/oauth/`, so a real browser calling
 * `GET /oauth/mcp/request` got the SPA's own `index.html` fallback — a `200`
 * with no matching JSON, not the consent data — and the OAuth flow could
 * never complete in any environment. `apps/api/tests/routes/mcp-oauth-consent.test.ts`
 * drives the API app directly with `supertest`, bypassing the proxy
 * entirely, so it stayed green the whole time this was broken. This spec is
 * what actually proves a browser reaching this page the way it really
 * would — through `vite preview`'s own proxy — gets a working page, not the
 * SPA fallback silently swallowing a JSON 404.
 *
 * **MCP-11 rework — this used to be `apps/api`'s own server-rendered HTML at
 * `/oauth/mcp/authorize`; it is now a real page of the panel
 * (`pages/ConnectAssistant.tsx`) at `/connect-assistant/:requestId`,
 * embedding the panel's own `SignIn` for the signed-out half of this walk —
 * this spec exercises that whole round trip, not merely the page a
 * signed-in browser lands on.**
 *
 * **What is real, and what is a harness stand-in**, the same discipline
 * `connect.spec.ts`'s own module comment holds itself to:
 *  - Real: the browser, a real `apps/web` build served by `vite preview`
 *    (through the *same* proxy config production's nginx reproduces), a
 *    real `apps/api`, a real throwaway SQLite database, and the whole
 *    sign-in round trip (an emailed link, actually redeemed, through the
 *    panel's own `SignIn.tsx`).
 *  - **Not real**: `apps/mcp` itself, and the MCP client side of the OAuth
 *    dance — the pending authorization this spec's own browser completes is
 *    seeded directly against the e2e database, standing in for what a real
 *    `authorize()` call would have written, the same "prove the mechanism,
 *    not the transport" split `connect.spec.ts`'s own module comment already
 *    draws for the MCP-issued token it drives through the browser.
 *    `apps/mcp/tests/oauth-http.test.ts` is where the OAuth protocol
 *    itself — PKCE, `redirect_uri` exactness, single-use codes — is proven,
 *    over real HTTP, against a real (in-process) `apps/mcp`. This harness
 *    also has no Google client id configured (no other spec in this suite
 *    does either), so the Google button renders its own "not configured"
 *    state rather than a live or gated one — the gated-vs-live behaviour
 *    itself is `tests/sign-in.test.tsx`'s job, at the unit level where a
 *    fake client id is safe to supply without reaching accounts.google.com
 *    (QA-2).
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import { beginAuthorization, registerOauthClient } from '@bloombot/auth'
import { closeDatabase, openDatabase } from '@bloombot/db'

import { E2E_DATABASE_PATH } from './support/env.js'
import { completeSignIn } from './support/sign-in.js'

test('a signed-out browser lands on the real connect-assistant page, signs in, and is sent back to the client with a code', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `mcp-oauth-${suffix}@example.edu`

  // 1. Seed a pending authorization directly — standing in for a real
  //    `apps/mcp` `authorize()` call (this spec's own module comment on why
  //    `apps/mcp` itself is not part of this harness).
  const seedDb = openDatabase(E2E_DATABASE_PATH)
  let pendingId: string
  try {
    const client = registerOauthClient(
      {
        redirectUris: ['https://assistant.example/callback'],
        clientName: `E2E Assistant ${suffix}`,
      },
      seedDb
    )
    const begun = beginAuthorization(
      {
        clientId: client.id,
        redirectUri: 'https://assistant.example/callback',
        codeChallenge: 'e2e-fake-challenge',
      },
      seedDb
    )
    pendingId = begun.id
  } finally {
    closeDatabase(seedDb)
  }

  // 2. A signed-out visit — the address a real `authorize()` redirect would
  //    have sent this browser to (MCP-11: a path segment, not a query
  //    string — `routing/route.ts`'s own module comment on why). The
  //    panel's own header (logo, name) and `SignIn` render here, not the
  //    generic bare sign-in a deep link with nowhere in particular to name
  //    would get.
  await page.goto(`/connect-assistant/${pendingId}`)
  await expect(
    page.getByRole('heading', { name: 'Sign in to Bloombot to connect' })
  ).toBeVisible()
  await expect(page.getByTestId('bloombot-logo')).toBeVisible()
  await expect(page.getByText(`E2E Assistant ${suffix}`)).toBeVisible()

  // 3. Sign in, on this same page — `completeSignIn` requests and redeems
  //    the link without navigating away first (the "already on the page
  //    `SignIn` renders inline" case `support/sign-in.ts`'s own module
  //    comment describes), so `destination` carries the browser back to
  //    this exact `/connect-assistant/:id` address once redeemed.
  await completeSignIn(page, email)

  // 4. Now signed in: the consent screen, naming the client and the
  //    redirect host — the security review's must-fix 2, still enforced
  //    after the JSON rewrite.
  await expect(
    page.getByText('Connect this assistant to your Bloombot account')
  ).toBeVisible()
  await expect(page.getByText(`E2E Assistant ${suffix}`)).toBeVisible()
  await expect(page.getByText('assistant.example')).toBeVisible()

  // 5. Allow — `window.location.assign` to the client's own `redirect_uri`,
  //    carrying a `code`. `assistant.example` does not exist (RFC 2606's own
  //    reserved TLD), so this browser's real navigation there is intercepted
  //    and fulfilled locally — proving the *address* the browser was actually
  //    sent to, without this harness needing a fake server to stand in for a
  //    real assistant's own callback endpoint.
  await page.route('https://assistant.example/**', (route) =>
    route.fulfill({ status: 200, body: 'ok' })
  )
  await page.getByRole('button', { name: 'Allow' }).click()
  await page.waitForURL(/^https:\/\/assistant\.example\//)
  const finalUrl = new URL(page.url())
  expect(finalUrl.origin).toBe('https://assistant.example')
  expect(finalUrl.searchParams.get('code')).toBeTruthy()
})
