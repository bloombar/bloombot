/**
 * WEB-47 defect: pure resolution logic for `vite.config.ts`'s root-`.env`
 * fallback, split out so it can be unit-tested against temporary
 * directories under `tmp/` rather than the developer's own `.env` files
 * (`apps/web/.env`, the repository root `.env`) — the same rule
 * `apps/web/tests/mcp.test.tsx` already holds itself to (WEB-47 defect
 * #409's own commit message: "the MCP tests must not read the developer's
 * own .env").
 *
 * Given the two directories `loadEnv` would read from (`apps/web` and the
 * repository root) and the current mode, this returns the `VITE_`-prefixed
 * keys that are present in the root's env files but absent from both the
 * local env files and `process.env` — i.e. the keys `vite.config.ts` should
 * inject into `process.env` before calling its own `loadEnv`, so Vite picks
 * them up as if they had been set on the command line.
 *
 * Local-over-root precedence is deliberate, not incidental: `apps/web`'s own
 * `VITE_GOOGLE_CLIENT_ID` arrangement (`apps/web/.env.production`,
 * `docs/DEPLOY_DROPLET.md` §4.3) already relies on that file winning, and
 * `docs/CONTRIBUTING.md`'s table documents `VITE_MCP_PUBLIC_URL` the same
 * way — a key set locally must keep overriding the same key set at the
 * root, not the other way round.
 */

import { loadEnv } from 'vite'

/**
 * Resolve the `VITE_`-prefixed keys to inject into `process.env` so that a
 * subsequent `loadEnv(mode, webDir, 'VITE_')` sees the repository root's
 * `.env`/`.env.<mode>` values as a fallback for anything `webDir`'s own env
 * files and the ambient `process.env` do not already set.
 *
 * `loadEnv` itself prioritises `process.env` over file values (that is how
 * Vite's own local-vs-file precedence already works) — so only keys absent
 * from *both* the local file result and the current `process.env` are
 * returned; injecting a key either of those already has would invert the
 * precedence this exists to preserve.
 */
export function resolveRootEnvFallback(
  mode: string,
  webDir: string,
  rootDir: string,
  currentEnv: Record<string, string | undefined> = process.env
): Record<string, string> {
  const local = loadEnv(mode, webDir, 'VITE_')
  const root = loadEnv(mode, rootDir, 'VITE_')

  const fallback: Record<string, string> = {}
  for (const [key, value] of Object.entries(root)) {
    if (key in local) continue
    if (currentEnv[key] !== undefined) continue
    fallback[key] = value
  }
  return fallback
}
