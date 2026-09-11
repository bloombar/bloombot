/**
 * Vite config for the control panel (WEB-1): a static build, no server of
 * its own. `apps/api` is the only thing that ever touches the database —
 * in production nginx puts the built bundle and the API behind one origin
 * (PLAT-4); here, `server.proxy`/`preview.proxy` reproduce that same-origin
 * shape for `npm run dev` and for the Playwright harness (`e2e/`), which
 * drives a real `vite preview` against a real `apps/api` process rather
 * than a mock (QA-2's "end-to-end tests run the real API ... and a
 * throwaway database").
 *
 * `API_PORT` is read from `process.env` at config-load time, the same
 * variable `apps/api` itself listens on (`env.example`) — not a value this
 * file invents, so pointing the proxy at a different API instance (the
 * e2e harness's own throwaway one, `e2e/support/start-api.ts`) is a matter
 * of setting the same environment variable before starting Vite, nothing
 * this file needs to know about.
 *
 * `prerenderPlugin()` (below) is the one addition that runs only for `vite
 * build`, never `vite dev`/`vite preview` — see its own module comment
 * (`prerender-plugin.ts`) for why the public pages are prerendered at build
 * time rather than served by a runtime SSR process.
 *
 * WEB-47 defect: `VITE_*` also has to be readable from the **repository
 * root** `.env`, not only `apps/web`'s own. Vite's `envDir` defaults to the
 * project root it is invoked from — `apps/web` here — so a plain `vite
 * build` only ever loads `apps/web/.env`/`.env.production`, never the root
 * `.env` every other deployment setting lives in. That silently swallowed
 * an operator's `VITE_MCP_PUBLIC_URL`: they set it in the root `.env`
 * alongside `PUBLIC_MCP_URL` (the natural place, and the only place
 * `deploy/nginx/README.md` told them to), and the built bundle never saw
 * it — `pages/Mcp.tsx` correctly reported "not configured" about a build
 * that, from its own point of view, really was unconfigured.
 *
 * The fix calls `loadEnv` **twice** — once the way Vite already does
 * (`apps/web` itself), once against the repository root — and injects into
 * `process.env`, before Vite resolves its own env, only the root keys that
 * are missing from both the local result and `process.env` already
 * (`load-root-env.ts`'s own comment has the full precedence reasoning).
 * That ordering is what keeps `apps/web`'s own files winning: Vite's
 * `loadEnv` itself prioritises `process.env` over file values, so an
 * `apps/web/.env.production` entry (the existing `VITE_GOOGLE_CLIENT_ID`
 * arrangement, `docs/DEPLOY_DROPLET.md` §4.3) must keep overriding the same
 * key set at the root, exactly as it does today — only a key `apps/web`
 * never set at all should ever fall back to the root's value.
 *
 * Both directories are resolved from `import.meta.url`, not `process.cwd()`
 * — `scripts/deploy.sh` runs this build from the repository root,
 * `npm run build --workspace apps/web`/`npm run dev` run it from `apps/web`
 * itself, and a cwd-relative path would silently resolve to a different
 * directory depending on which one invoked it.
 */

import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import { prerenderPlugin } from './prerender-plugin.js'
import { resolveRootEnvFallback } from './load-root-env.js'

const WEB_DIR = fileURLToPath(new URL('.', import.meta.url))
const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url))

const apiPort = process.env['API_PORT'] ?? '3000'
const apiOrigin = `http://127.0.0.1:${apiPort}`

// Only the paths apps/api actually serves (server.ts) are proxied.
// `/discord/callback` is deliberately absent: it is this app's own page
// (Discord redirects the browser there — src/pages/DiscordCallback.tsx),
// not a route apps/api answers.
const proxy = {
  '/health': apiOrigin,
  '/auth': apiOrigin,
  '/organizations': apiOrigin,
  // ADMIN-4/ADMIN-5 — `apps/api`'s own `routes/admin.ts` mount. Deliberately
  // a different top-level segment from the browser's own `/platform-admin`
  // page path (`App.tsx`): the two must never share one, the same way
  // `/sign-in/:token` (a page) and `/auth/redeem` (the API it posts to)
  // already do not — a path this proxy forwards and a path this app's own
  // client-side router renders cannot be the same one.
  '/admin': apiOrigin,
  // ENRL-8 — `apps/api`'s own `routes/join-links.ts` mount, unscoped like
  // `/auth` (that file's own module comment has why). Deliberately a
  // different top-level segment from this app's own `/join/:secret` page
  // (`App.tsx`, `pages/JoinLink.tsx`) — the same "a proxied API path and a
  // page path cannot share one top-level segment" rule `/admin` and
  // `/platform-admin` already hold themselves to, just above.
  '/join-links': apiOrigin,
  // ENRL-10 — `apps/api`'s own `routes/membership-invitations.ts` mount,
  // unscoped like `/join-links` immediately above, for the identical
  // reason. Deliberately a different top-level segment from this app's own
  // `/invitations/:secret` page (`App.tsx`, `pages/Invitation.tsx`) — the
  // same "a proxied API path and a page path cannot share one top-level
  // segment" rule `/join-links`/`/join/:secret` already hold themselves to.
  '/membership-invitations': apiOrigin,
  // MCP-7 — `apps/api`'s own `routes/mcp-oauth-consent.ts` mount: the
  // browser lands here on the redirect `apps/mcp`'s own `authorize()`
  // issues, carrying a pending-authorization id — with no entry here, this
  // path falls through to the SPA's own `index.html` fallback (both this
  // dev proxy and the nginx block `docs/DEPLOY_DROPLET.md` documents), a
  // 200 with no route the client-side router recognises, and the OAuth
  // flow never completes in any environment. Deliberately a different
  // top-level segment from anything this app's own router renders, the
  // same "a proxied API path and a page path cannot share one top-level
  // segment" rule every entry above already holds itself to.
  '/oauth': apiOrigin,
}

export default defineConfig(({ mode }) => {
  // WEB-47 defect — see the module comment above for the full reasoning.
  // Injected before `defineConfig`'s own env resolution runs, so Vite's
  // subsequent internal `loadEnv(mode, WEB_DIR, ...)` sees these as
  // `process.env` entries and treats them exactly as it would a value set
  // on the command line.
  const rootFallback = resolveRootEnvFallback(mode, WEB_DIR, ROOT_DIR)
  for (const [key, value] of Object.entries(rootFallback)) {
    process.env[key] = value
  }

  return {
    // WEB-11: Tailwind is the one styling system — `@tailwindcss/vite`
    // builds `src/style.css`'s `@import "tailwindcss"` directly, no
    // separate `postcss.config` or `tailwind.config` file to keep in sync
    // with it.
    plugins: [react(), tailwindcss(), prerenderPlugin()],
    server: { proxy },
    preview: { proxy },
  }
})
