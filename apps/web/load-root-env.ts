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
 *
 * WEB-47 rework (round 1) — `loadEnv` is not a pure read of the directory it
 * is pointed at. Regardless of the `'VITE_'` prefix filter this module
 * passes it, Vite's own `loadEnv` (`node_modules/vite/dist/node/chunks/
 * node.js`) always looks for three *unprefixed* keys — `NODE_ENV`,
 * `BROWSER`, `BROWSER_ARGS` — and, if one is present in the parsed file and
 * not already set, writes it straight onto `process.env` as a side effect
 * (`VITE_USER_NODE_ENV`, `BROWSER`, `BROWSER_ARGS` respectively) before
 * returning. That is fine the one time Vite calls it itself, against the
 * project's own env dir — it is not fine here, where this module calls it a
 * *second* time against the repository root purely to read `VITE_`-prefixed
 * values back out. The repository root `.env` ships `NODE_ENV=development`
 * by default (`env.example`), so an unguarded root `loadEnv` call set
 * `process.env.VITE_USER_NODE_ENV = 'development'` on every build — which
 * `resolveConfig` (`node.js`) then reads to force `process.env.NODE_ENV =
 * 'development'` whenever the ambient shell had not already set `NODE_ENV`
 * itself (true for every path that invokes this build: `npm run build`,
 * `scripts/deploy.sh`, `pree2e`), producing a development React build the
 * prerender plugin then crashed on (`dispatcher.getOwner is not a
 * function`) — or, where the root `.env` said `NODE_ENV=production`
 * instead, Vite's own "NODE_ENV=production is not supported in the .env
 * file" warning on every build.
 *
 * Fixed by snapshotting these three keys immediately before the root
 * `loadEnv` call and restoring them immediately after — "was absent"
 * restored as *deleted*, not as the string `"undefined"`, so a key genuinely
 * set by the ambient shell before this function ran is left exactly as it
 * was. `dotenv.parse`-ing the root's own env files directly (skipping
 * `loadEnv` for the root entirely) was the other option considered; the
 * snapshot/restore was chosen instead because it keeps exactly one code
 * path responsible for "what files does an env dir's mode resolve to, and
 * in what precedence" — `loadEnv` itself — rather than growing a second,
 * hand-rolled implementation of that logic here that could drift from
 * Vite's own as Vite is upgraded.
 *
 * Restoring `process.env` after the call is not, on its own, enough:
 * `loadEnv`'s *return value* — not just its `process.env` side effect — can
 * already contain the leaked key by the time the call returns.
 * `VITE_USER_NODE_ENV` itself starts with `'VITE_'`, so `loadEnv`'s own last
 * pass (`node.js`: `for (const key in process.env) if (prefixes.some(...))
 * env[key] = process.env[key]`) copies whatever it just wrote at line 5917
 * straight into the object it hands back — reproduced while writing this
 * fix: a root `.env.production` with `NODE_ENV=production` (this
 * repository's own root `.env.production`) produced a `loadEnv` return
 * value containing `VITE_USER_NODE_ENV: 'production'` even though
 * `process.env.VITE_USER_NODE_ENV` was correctly restored to `undefined`
 * immediately afterwards — `vite.config.ts` would still have assigned that
 * value onto `process.env` itself, permanently, from `resolveRootEnvFallback`'s
 * own return object. `loadEnvWithoutSideEffects` below strips
 * `LOAD_ENV_SIDE_EFFECT_KEYS` from the returned record for this reason, not
 * only from `process.env`.
 *
 * One caveat, not a behaviour change: this side effect is a `process.env`
 * write, and Vite's dev server only watches `apps/web`'s own env files for
 * changes, not the repository root's — so editing the root `.env` while
 * `vite dev`/`vite preview` is already running needs the process restarted
 * (not merely saved) before the new value takes effect, the same as any
 * other `process.env` change would.
 */

import { loadEnv } from 'vite'

// WEB-47 rework (round 1) — the exact unprefixed keys `loadEnv` writes onto
// `process.env` as a side effect when it finds them in a parsed env file
// (see the module comment above). Kept as a named list, not re-derived from
// Vite's source, so a Vite upgrade that changes this set fails loudly here
// rather than silently reopening the leak.
const LOAD_ENV_SIDE_EFFECT_KEYS = [
  'VITE_USER_NODE_ENV',
  'BROWSER',
  'BROWSER_ARGS',
] as const

/**
 * Call `loadEnv` against a directory while suppressing the unprefixed
 * `process.env` side effects described in the module comment above — both
 * on `process.env` itself (restoring each of `LOAD_ENV_SIDE_EFFECT_KEYS` to
 * exactly what it was, present or absent, once `loadEnv` returns) and on
 * the record `loadEnv` hands back, which can already contain the leaked
 * `VITE_USER_NODE_ENV` value (the module comment above has the
 * reproduction — `loadEnv`'s own last pass copies whatever it just wrote to
 * `process.env` into its return value before this function gets a chance to
 * restore anything).
 */
function loadEnvWithoutSideEffects(
  mode: string,
  dir: string,
  prefix: string
): Record<string, string> {
  const snapshot = new Map(
    LOAD_ENV_SIDE_EFFECT_KEYS.map((key) => [key, process.env[key]])
  )
  try {
    const result = loadEnv(mode, dir, prefix)
    for (const key of LOAD_ENV_SIDE_EFFECT_KEYS) delete result[key]
    return result
  } finally {
    for (const [key, previousValue] of snapshot) {
      if (previousValue === undefined) delete process.env[key]
      else process.env[key] = previousValue
    }
  }
}

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
  // WEB-47 rework (round 1) — a test-determinism hatch, not a general
  // feature: `apps/web/tests/bundle.test.ts` shells out to a real `vite
  // build`, which loads this module for real (not mocked). Without an
  // opt-out, that build reads whatever root `.env`/`.env.production`/
  // `.env.local` files happen to exist on the machine running the test —
  // present on a developer's checkout, absent in CI — so the same test
  // built a different bundle depending on who ran it. Setting this in the
  // child `env` that `execFileSync` already controls makes the bundle
  // `bundle.test.ts` builds identical everywhere, the same rule
  // `963661d`/`apps/web/tests/mcp.test.tsx` already hold themselves to for
  // `import.meta.env`.
  if (currentEnv['BLOOMBOT_SKIP_ROOT_ENV_FALLBACK']) return {}

  // The local call is guarded the same way as the root call immediately
  // below purely for symmetry and to avoid a premature/duplicate write —
  // Vite's own subsequent internal `loadEnv(mode, webDir, ...)` (inside
  // `resolveConfig`, after this config function returns) still produces the
  // real, intended side effect for `apps/web`'s own env files; this call
  // exists only to read `VITE_`-prefixed values back out early.
  const local = loadEnvWithoutSideEffects(mode, webDir, 'VITE_')
  // The root call is the one that must never leak unprefixed keys (`NODE_ENV`
  // → `VITE_USER_NODE_ENV`, `BROWSER`, `BROWSER_ARGS`) onto `process.env` —
  // see the module comment above for the full reproduction.
  const root = loadEnvWithoutSideEffects(mode, rootDir, 'VITE_')

  const fallback: Record<string, string> = {}
  for (const [key, value] of Object.entries(root)) {
    if (key in local) continue
    if (currentEnv[key] !== undefined) continue
    fallback[key] = value
  }
  return fallback
}
