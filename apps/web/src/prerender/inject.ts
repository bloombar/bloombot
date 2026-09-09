/**
 * Pure, dependency-free helpers for the post-build prerender step
 * (`../../prerender-plugin.ts`, wired into `vite.config.ts`'s own `plugins`
 * array).
 *
 * Deliberately kept free of React and of Vite's own APIs — everything here
 * is string manipulation over already-rendered HTML — so `tests/prerender.test.ts`
 * can exercise the injection logic directly, in milliseconds, without paying
 * for a real `vite build` on every run. The build itself is still checked
 * end to end, but that check lives in `tests/bundle.test.ts`'s own
 * `beforeAll` (which already runs one real `vite build` for WEB-6) rather
 * than a second one here.
 *
 * See `docs/DECISIONS.md` D-92 for why this is build-time prerendering
 * (static HTML, written once at build time) rather than a runtime SSR
 * server.
 */

/** What a prerendered page other than the homepage needs of its own — the
 * shell's `index.html` already carries a good enough title/description for
 * `/`, but `/privacy` and `/terms` are now their own documents and need
 * their own. */
export interface PageMeta {
  /** Replaces the built shell's `<title>`. */
  title: string
  /** Replaces the built shell's `<meta name="description">`. */
  description: string
  /** The page's own canonical address, written as `<link rel="canonical">`. */
  canonical: string
}

const ROOT_DIV = '<div id="root"></div>'

/**
 * Injects a page's server-rendered markup into the built `index.html`
 * template — the shared shell every route (`/`, `/privacy`, `/terms`) is
 * copied from before this runs — replacing the empty `<div id="root">`
 * `main.tsx` mounts into with real content.
 *
 * The SPA still takes over: `main.tsx` calls `createRoot(container).render(...)`,
 * not `hydrateRoot`, so React discards this markup and renders its own on
 * mount rather than reconciling against it — deliberately, since it avoids
 * every hydration-mismatch failure mode a mismatched server/client render
 * would otherwise risk, at the cost of a page that briefly holds prerendered
 * markup a fraction of a second before the bundle's own script replaces it.
 * A crawler that does not execute JavaScript only ever sees the markup this
 * function wrote.
 *
 * Throws if `template` does not contain the exact empty root div this
 * function expects — a silent no-op here would ship an unprerendered page
 * with nobody the wiser until Google's crawler found it again.
 */
export function injectPrerenderedPage(
  template: string,
  bodyHtml: string,
  meta?: PageMeta
): string {
  if (!template.includes(ROOT_DIV)) {
    throw new Error(
      `apps/web prerender: expected the built index.html to contain an empty "${ROOT_DIV}" — either it already has content in it, or the built markup no longer matches what this function expects.`
    )
  }

  let html = template.replace(ROOT_DIV, `<div id="root">${bodyHtml}</div>`)
  if (meta) html = injectPageMeta(html, meta)
  return html
}

/**
 * Replaces the shell's `<title>` and `<meta name="description">` with a
 * page-specific one, and adds a `<link rel="canonical">` right after the
 * description — every prerendered page is now its own document, and a
 * crawler reading `/privacy` should not see the homepage's own title.
 */
function injectPageMeta(html: string, meta: PageMeta): string {
  let result = html.replace(
    /<title>.*?<\/title>/s,
    `<title>${escapeHtml(meta.title)}</title>`
  )
  const descriptionTag = `<meta name="description" content="${escapeHtml(meta.description)}" />`
  result = result.replace(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/,
    `${descriptionTag}\n    <link rel="canonical" href="${escapeHtml(meta.canonical)}" />`
  )
  return result
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * `robots.txt`, pointing crawlers at the sitemap. Generated at build time
 * rather than shipped as a static `public/robots.txt`, because its one line
 * of real content — the `Sitemap:` URL — needs the deployment's own origin
 * (`VITE_PUBLIC_APP_URL`), which a file under `public/` is copied verbatim
 * and cannot carry.
 */
export function buildRobotsTxt(origin: string): string {
  return [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n')
}

/**
 * `sitemap.xml`, listing the public pages a signed-out visitor or crawler
 * can reach — not every address this app knows (most require a session),
 * just the three this slice prerenders.
 */
export function buildSitemapXml(
  origin: string,
  paths: readonly string[]
): string {
  const urls = paths
    .map((path) => `  <url><loc>${escapeHtml(origin + path)}</loc></url>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}
