/**
 * `src/prerender/inject.ts`'s pure HTML-injection helpers, exercised
 * directly rather than through a real `vite build` — the build itself is
 * checked end to end in `tests/bundle.test.ts`'s own `beforeAll`, which
 * already runs one real `vite build` for WEB-6; this file is what makes the
 * injection logic itself fail fast, in milliseconds, on a change to how it
 * finds or replaces the root div.
 */

import { describe, expect, it } from 'vitest'

import {
  buildRobotsTxt,
  buildSitemapXml,
  injectPrerenderedPage,
} from '../src/prerender/inject.js'

const TEMPLATE = `<!doctype html>
<html>
  <head>
    <title>Bloombot</title>
    <meta name="description" content="The shell's own description." />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/index-abc123.js"></script>
  </body>
</html>
`

describe('injectPrerenderedPage', () => {
  it('replaces the empty root div with the rendered markup', () => {
    const result = injectPrerenderedPage(TEMPLATE, '<p>hello</p>')

    expect(result).toContain('<div id="root"><p>hello</p></div>')
    expect(result).not.toContain('<div id="root"></div>')
    // The bundle's own script tag survives untouched — the SPA still takes
    // over on mount (`prerender-plugin.ts`'s own module comment).
    expect(result).toContain('/assets/index-abc123.js')
  })

  it('throws rather than silently no-op when the root div is not found', () => {
    // A template that does not match this function's own expectation must
    // fail loudly — a silent no-op here would ship an unprerendered page
    // with nobody the wiser.
    expect(() =>
      injectPrerenderedPage(
        '<div id="root">already has content</div>',
        '<p>x</p>'
      )
    ).toThrow()
  })

  it('leaves title/description/canonical untouched when no meta is given', () => {
    const result = injectPrerenderedPage(TEMPLATE, '<p>home</p>')

    expect(result).toContain('<title>Bloombot</title>')
    expect(result).toContain('content="The shell\'s own description."')
    expect(result).not.toContain('rel="canonical"')
  })

  it('overwrites title/description and adds a canonical link when meta is given', () => {
    const result = injectPrerenderedPage(TEMPLATE, '<p>privacy</p>', {
      title: 'Privacy policy — Bloombot',
      description: 'What Bloombot records, and who can see it.',
      canonical: 'https://bloombot.wonkledge.com/privacy',
    })

    expect(result).toContain('<title>Privacy policy — Bloombot</title>')
    expect(result).toContain(
      'content="What Bloombot records, and who can see it."'
    )
    expect(result).toContain(
      '<link rel="canonical" href="https://bloombot.wonkledge.com/privacy" />'
    )
  })

  it('escapes HTML-significant characters in injected meta', () => {
    const result = injectPrerenderedPage(TEMPLATE, '<p>x</p>', {
      title: 'A & B <script>',
      description: 'quote " ampersand &',
      canonical: 'https://example.com/?a=1&b=2',
    })

    expect(result).not.toContain('<script>')
    expect(result).toContain('A &amp; B &lt;script&gt;')
    expect(result).toContain('href="https://example.com/?a=1&amp;b=2"')
  })
})

describe('buildRobotsTxt', () => {
  it('allows crawling and points at the sitemap for the given origin', () => {
    const robots = buildRobotsTxt('https://bloombot.wonkledge.com')

    expect(robots).toContain('User-agent: *')
    expect(robots).toContain('Allow: /')
    expect(robots).toContain(
      'Sitemap: https://bloombot.wonkledge.com/sitemap.xml'
    )
  })
})

describe('buildSitemapXml', () => {
  it('lists every given path under the origin', () => {
    const sitemap = buildSitemapXml('https://bloombot.wonkledge.com', [
      '/',
      '/privacy',
      '/terms',
    ])

    expect(sitemap).toContain('<loc>https://bloombot.wonkledge.com/</loc>')
    expect(sitemap).toContain(
      '<loc>https://bloombot.wonkledge.com/privacy</loc>'
    )
    expect(sitemap).toContain('<loc>https://bloombot.wonkledge.com/terms</loc>')
  })
})
