/**
 * Table-driven tests for `normalizeWebSourceDomain` (WEB-31) — every case
 * this file's own module comment promises: accepted-and-reduced, and
 * refused.
 */

import { describe, expect, it } from 'vitest'

import { normalizeWebSourceDomain } from '../src/web-source-domain.js'

describe('normalizeWebSourceDomain: accepted and reduced to its bare domain (WEB-31)', () => {
  const cases: { input: string; domain: string }[] = [
    { input: 'example.edu', domain: 'example.edu' },
    { input: 'https://example.edu', domain: 'example.edu' },
    { input: 'http://example.edu', domain: 'example.edu' },
    { input: 'https://example.edu/', domain: 'example.edu' },
    {
      input: 'https://docs.python.org/3/library/index.html',
      domain: 'docs.python.org',
    },
    { input: 'https://example.edu?query=1', domain: 'example.edu' },
    { input: 'https://example.edu#section', domain: 'example.edu' },
    { input: 'https://example.edu:8080/path', domain: 'example.edu' },
    { input: 'EXAMPLE.EDU', domain: 'example.edu' },
    { input: 'Example.Edu', domain: 'example.edu' },
    { input: '  example.edu  ', domain: 'example.edu' },
    { input: 'example.edu.', domain: 'example.edu' },
    // Never stripped — a site served only at `www.` must not have its own
    // working domain rewritten to one that answers nothing.
    { input: 'www.example.edu', domain: 'www.example.edu' },
    { input: 'https://www.example.edu/', domain: 'www.example.edu' },
    { input: 'https://user:pass@example.edu/', domain: 'example.edu' },
    // A backslash counts as a path separator alongside `/`, `?` and `#` —
    // WHATWG URL parsing (a real browser) treats it as equivalent to `/`
    // in a special URL, so this must resolve to the same host a browser
    // would show an instructor, not to whatever follows it.
    {
      input: 'https://example.edu\\some\\path',
      domain: 'example.edu',
    },
  ]

  for (const { input, domain } of cases) {
    it(`"${input}" -> "${domain}"`, () => {
      const result = normalizeWebSourceDomain(input)
      expect(result).toEqual({ ok: true, domain })
    })
  }
})

describe('normalizeWebSourceDomain: refused (WEB-31)', () => {
  const cases: { input: string; label: string }[] = [
    { input: '', label: 'an empty string' },
    { input: '   ', label: 'whitespace only' },
    { input: 'https://', label: 'a scheme with nothing after it' },
    { input: '192.0.2.1', label: 'an IP-literal-only input' },
    { input: 'https://192.0.2.1/path', label: 'an IP literal with a path' },
    { input: 'localhost', label: 'a value with no dot' },
    { input: 'example', label: 'a single label with no dot' },
    { input: 'example .edu', label: 'a value with internal whitespace' },
    { input: 'exa mple.edu', label: 'a value with whitespace mid-label' },
    {
      input: 'exa_mple.edu',
      label: 'a value with an invalid host character (underscore)',
    },
    {
      input: `${'a'.repeat(250)}.edu`,
      label: 'a value over 253 characters once reduced',
    },
    { input: 'a..b.edu', label: 'an empty label' },
    { input: '.example.edu', label: 'a leading empty label' },
    { input: '-evil.edu', label: 'a label starting with a hyphen' },
    { input: 'example.edu-', label: 'a label ending with a hyphen' },
    {
      input: `${'a'.repeat(70)}.edu`,
      label: 'a label over 63 characters',
    },
  ]

  for (const { input, label } of cases) {
    it(`refuses ${label}`, () => {
      const result = normalizeWebSourceDomain(input)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0)
    })
  }
})
