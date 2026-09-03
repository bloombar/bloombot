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
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
}

export default defineConfig({
  // WEB-11: Tailwind is the one styling system — `@tailwindcss/vite` builds
  // `src/style.css`'s `@import "tailwindcss"` directly, no separate
  // `postcss.config` or `tailwind.config` file to keep in sync with it.
  plugins: [react(), tailwindcss()],
  server: { proxy },
  preview: { proxy },
})
