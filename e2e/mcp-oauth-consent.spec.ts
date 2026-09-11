/**
 * MCP-7, end to end: the consent screen `apps/mcp`'s own OAuth
 * `authorize()` redirects a browser to, reached through the *exact*
 * routing a real browser uses — `vite preview`'s own proxy
 * (`apps/web/vite.config.ts`), the same shape nginx's own `location`
 * blocks reproduce in production (`docs/DEPLOY_DROPLET.md`).
 *
 * **Why this spec exists — a defect this repository's own supertest-only
 * coverage could not see.** A security review found that
 * `apps/mcp/src/index.ts` builds `authorize()`'s consent URL as
 * `${PUBLIC_APP_URL}/oauth/mcp/authorize`, but nothing routed `/oauth/` to
 * `apps/api` at all: `apps/web/vite.config.ts`'s own proxy allowlist (and
 * the matching nginx block) omitted it, so a real browser following that
 * redirect got the SPA's own `index.html` fallback — a `200` with no route
 * the client-side router recognises, not the consent screen, and the OAuth
 * flow could never complete in any environment. `apps/api/tests/routes/mcp-oauth-consent.test.ts`
 * drives the API app directly with `supertest`, bypassing the proxy
 * entirely, so it stayed green the whole time this was broken. This spec
 * is what actually proves a browser reaching this URL the way it really
 * would — through `vite preview`'s own proxy — gets the real page.
 *
 * **What is real, and what is a harness stand-in**, the same discipline
 * `connect.spec.ts`'s own module comment holds itself to:
 *  - Real: the browser, a real `apps/web` build served by `vite preview`
 *    (through the *same* proxy config production's nginx reproduces), a
 *    real `apps/api`, a real throwaway SQLite database, and the whole
 *    sign-in round trip (an emailed link, actually redeemed, through the
 *    panel's own `SignIn.tsx`).
 *  - **Not real**: `apps/mcp` itself, and the MCP client side of the OAuth
 *    dance — the pending authorization this spec's own browser completes
 *    is seeded directly against the e2e database, standing in for what a
 *    real `authorize()` call would have written, the same "prove the
 *    mechanism, not the transport" split `connect.spec.ts`'s own module
 *    comment already draws for the MCP-issued token it drives through the
 *    browser. `apps/mcp/tests/oauth-http.test.ts` is where the OAuth
 *    protocol itself — PKCE, `redirect_uri` exactness, single-use codes —
 *    is proven, over real HTTP, against a real (in-process) `apps/mcp`.
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import { beginAuthorization, registerOauthClient } from '@bloombot/auth'
import { closeDatabase, openDatabase } from '@bloombot/db'

import { E2E_DATABASE_PATH } from './support/env.js'
import { signIn } from './support/sign-in.js'

test('a browser reaching the consent URL through the real proxy sees the consent screen, not the SPA fallback', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `mcp-oauth-${suffix}@example.edu`

  // 1. Seed a pending authorization directly — standing in for a real
  //    `apps/mcp` `authorize()` call (this spec's own module comment on
  //    why `apps/mcp` itself is not part of this harness).
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

  // 2. Sign in through the real panel first, in this same browser — this
  //    spec is not exercising the sign-in round trip itself
  //    (`apps/api/tests/routes/mcp-oauth-consent.test.ts` already does,
  //    directly), only that the consent screen renders once a session
  //    cookie already exists. Waiting for the organization switcher (the
  //    same device every other spec in this suite uses after `signIn`) is
  //    load-bearing, not decorative — `RedeemLink.tsx` redeems the token
  //    in a `useEffect` after `page.goto` has already resolved, so
  //    navigating away immediately can outrun the `Set-Cookie` this
  //    consent screen depends on.
  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // 3. The redirect a real `authorize()` call issues — reached through
  //    `vite preview`'s own proxy, the exact routing this spec exists to
  //    prove. Before the fix, this 200'd into the SPA's own shell with no
  //    matching route; the assertions below fail against that page.
  await page.goto(`/oauth/mcp/authorize?request=${pendingId}`)

  await expect(
    page.getByText('Connect this assistant to your Bloombot account')
  ).toBeVisible()
  await expect(page.getByText(`E2E Assistant ${suffix}`)).toBeVisible()
  await expect(page.getByText('assistant.example')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Allow' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible()
})
