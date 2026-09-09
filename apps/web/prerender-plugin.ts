/**
 * A `vite build`-only plugin that prerenders the pages a signed-out visitor
 * or crawler can reach — `/`, `/privacy`, `/terms` — into real HTML, after
 * the ordinary client bundle has already been written.
 *
 * **Why a build plugin rather than a runtime SSR server.** The deploy is a
 * static nginx `root` with no Node process in front of it
 * (`docs/DEPLOY_DROPLET.md` §5) — introducing runtime SSR would mean a new
 * pm2 entry and a new `proxy_pass`, purely so Google's OAuth verifier and
 * search crawlers (neither of which execute JavaScript) can read three
 * pages that never change between requests. Rendering them once, at build
 * time, into static files nginx already knows how to serve gives a crawler
 * identical markup with none of that operational surface. Recorded as
 * `docs/DECISIONS.md` D-92.
 *
 * **How it renders `apps/web`'s own components under Node.** `closeBundle`
 * fires after the outer (browser-targeted) build has finished writing
 * `dist/`, at which point this plugin opens a *second*, short-lived Vite
 * dev server in middleware mode and uses `ssrLoadModule` to import
 * `pages/Home.tsx`/`pages/StaticDocument.tsx`/`content/privacy.ts`/
 * `content/terms.ts` directly from source. `ssrLoadModule` runs the same
 * TypeScript/JSX transform and the same `import.meta.env` replacement the
 * browser build already used, so `OPERATOR`'s `VITE_OPERATOR_*` reads
 * (`content/document.ts`) resolve exactly as they did in the bundle just
 * written — a plain Node `import()` of a `.tsx` file could do neither.
 * `react-dom/server`'s `renderToStaticMarkup` then turns each component into
 * a plain HTML string; nothing here needs `renderToString`'s extra
 * hydration bookkeeping, because `main.tsx` mounts with `createRoot`, not
 * `hydrateRoot` (`src/prerender/inject.ts`'s own comment on why).
 *
 * `Home`/`StaticDocument` are rendered directly, not `<App />`: `App.tsx`
 * reads `window.location`, fetches the session, and holds client-only state
 * for the rest of the panel — none of which exists, or should exist, for a
 * signed-out crawler reading three public pages. Rendering the same
 * components the SPA already uses for these routes (rather than a second,
 * parallel copy of their markup) is what keeps the prerendered HTML and the
 * client-rendered HTML from drifting apart.
 */

import { createServer, loadEnv, type Plugin, type ResolvedConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// `content/document.ts` is a plain `.ts` file, JSX-free — safe to type-import
// from this Node-side project without pulling any of `tsconfig.app.json`'s
// browser-only requirements in (the JSX types `Home`/`StaticDocument` need
// below are deliberately *not* imported this way; see the cast just below).
import type { StaticDocument as StaticDocumentContent } from './src/content/document.js'
import {
  buildRobotsTxt,
  buildSitemapXml,
  injectPrerenderedPage,
} from './src/prerender/inject.js'

/** Where a deployment's own origin comes from — `apps/web`'s own build-time
 * equivalent of the root `.env`'s `PUBLIC_APP_URL` (`docs/CONTRIBUTING.md`
 * documents this alongside `VITE_GOOGLE_CLIENT_ID`): `apps/api` reads the
 * former at request time, this Vite build reads the latter at build time,
 * the same split that variable already draws. Defaults to the one origin
 * this platform is actually deployed at, rather than a placeholder — an
 * unconfigured build still ships a `sitemap.xml`/`robots.txt` that resolve
 * to something real. */
const DEFAULT_ORIGIN = 'https://bloombot.wonkledge.com'

/** The public, signed-out addresses this slice prerenders — the same three
 * `closeBundle` below writes HTML for. */
const PUBLIC_PATHS = ['/', '/privacy', '/terms'] as const

export function prerenderPlugin(): Plugin {
  let config: ResolvedConfig

  return {
    name: 'bloombot:prerender',
    // Never runs under `vite dev`/`vite preview` — those already serve
    // `index.html` straight from disk with the dev server behind it, and a
    // developer editing `pages/Home.tsx` should see the change on refresh,
    // not a prerendered snapshot from the last build.
    apply: 'build',
    configResolved(resolved) {
      config = resolved
    },
    async closeBundle() {
      // `build.ssr` is unset for this app's own build (it has no SSR build
      // of its own) — guarded anyway so a future SSR build added to this
      // config for some other reason does not also trigger a second,
      // nonsensical prerender pass over its own output.
      if (config.build.ssr) return

      const root = config.root
      const distDir = join(root, config.build.outDir)
      const env = loadEnv(config.mode, root, '')
      const origin = env['VITE_PUBLIC_APP_URL'] || DEFAULT_ORIGIN

      // A second, throwaway dev server, never bound to a port
      // (`middlewareMode`) and never serving a request — `ssrLoadModule` is
      // the only thing it is used for, so it opens and closes within this
      // one hook.
      const server = await createServer({
        root,
        mode: config.mode,
        configFile: false,
        plugins: [react()],
        server: { middlewareMode: true },
        appType: 'custom',
      })

      try {
        const [homeModule, staticDocumentModule, privacyModule, termsModule] =
          await Promise.all([
            server.ssrLoadModule('/src/pages/Home.tsx'),
            server.ssrLoadModule('/src/pages/StaticDocument.tsx'),
            server.ssrLoadModule('/src/content/privacy.ts'),
            server.ssrLoadModule('/src/content/terms.ts'),
          ])
        // Typed loosely rather than via `typeof import('./src/pages/Home.js')`:
        // `Home.tsx`/`StaticDocument.tsx` belong to `tsconfig.app.json`'s own
        // browser project (JSX, DOM lib), and this file belongs to
        // `tsconfig.node.json`'s Node one — pulling their real types in here
        // would pull JSX's type requirements into a project that has no
        // reason to carry them. `ssrLoadModule`'s own return type is already
        // `Record<string, unknown>`; these two interfaces describe only the
        // shape this function actually calls.
        const { Home } = homeModule as {
          Home: (props: {
            onSignedIn: () => void
            googleClientId?: string
          }) => ReactElement
        }
        const { StaticDocument } = staticDocumentModule as {
          StaticDocument: (props: {
            document: StaticDocumentContent
            testId: string
          }) => ReactElement
        }
        const { privacyDocument } = privacyModule as {
          privacyDocument: StaticDocumentContent
        }
        const { termsDocument } = termsModule as {
          termsDocument: StaticDocumentContent
        }

        // The shared shell every prerendered page starts from — the same
        // file the outer build just finished writing, complete with the
        // hashed `<script>`/`<link>` tags for the real bundle.
        const template = readFileSync(join(distDir, 'index.html'), 'utf8')

        const homeHtml = renderToStaticMarkup(
          createElement(Home, {
            onSignedIn: () => {},
            // A placeholder, not this deployment's real `VITE_GOOGLE_CLIENT_ID`
            // (which may well be unset in the environment this build runs in,
            // e.g. before production secrets are configured, or in a CI/test
            // build like `tests/bundle.test.ts`'s own). `SignIn.tsx` renders a
            // "Google sign-in is not configured for this deployment" message
            // when it has no client id — accurate for a real, JavaScript-
            // running browser evaluating its own build-time env, but exactly
            // the "deployment failure" text that must never reach a
            // non-JavaScript crawler's static HTML (`Home.tsx`'s own
            // `googleClientId` doc comment; `docs/DECISIONS.md`'s
            // prerendering entry has the full reasoning). Forcing this truthy
            // renders the neutral "agree to the documents" shell instead —
            // the same shell a real, correctly-configured deployment shows
            // before its own script has loaded — and the client-side render
            // that replaces this markup on mount (`main.tsx`'s `createRoot`,
            // not `hydrateRoot`) uses the real client bundle's own env
            // regardless, so a genuinely unconfigured deployment still tells
            // an actual visitor the truth once JavaScript runs.
            googleClientId: 'prerender-placeholder-client-id',
          })
        )
        writeFileSync(
          join(distDir, 'index.html'),
          injectPrerenderedPage(template, homeHtml)
        )

        const privacyHtml = renderToStaticMarkup(
          createElement(StaticDocument, {
            document: privacyDocument,
            testId: 'privacy-page',
          })
        )
        mkdirSync(join(distDir, 'privacy'), { recursive: true })
        writeFileSync(
          join(distDir, 'privacy', 'index.html'),
          injectPrerenderedPage(template, privacyHtml, {
            title: `${privacyDocument.title} — Bloombot`,
            description: privacyDocument.summary,
            canonical: `${origin}/privacy`,
          })
        )

        const termsHtml = renderToStaticMarkup(
          createElement(StaticDocument, {
            document: termsDocument,
            testId: 'terms-page',
          })
        )
        mkdirSync(join(distDir, 'terms'), { recursive: true })
        writeFileSync(
          join(distDir, 'terms', 'index.html'),
          injectPrerenderedPage(template, termsHtml, {
            title: `${termsDocument.title} — Bloombot`,
            description: termsDocument.summary,
            canonical: `${origin}/terms`,
          })
        )

        writeFileSync(join(distDir, 'robots.txt'), buildRobotsTxt(origin))
        writeFileSync(
          join(distDir, 'sitemap.xml'),
          buildSitemapXml(origin, PUBLIC_PATHS)
        )
      } finally {
        await server.close()
      }
    },
  }
}
