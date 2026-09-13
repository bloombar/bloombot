/**
 * MCP-12 — the emailed link's own URL shape. `pages/RedeemLink.tsx` reads
 * `?destination=` back off this URL, and until this was extracted from
 * `index.ts`'s process wiring nothing tested the function the deployment
 * actually runs: `packages/auth` proved `buildLink` *receives* a
 * destination using its own test-local builder, and the panel proved it
 * *reads* one, but nothing joined the two. A review finding — a `&` for a
 * `?`, or a missing `encodeURIComponent`, would have shipped green.
 */

import { describe, expect, it } from 'vitest'

import { buildSignInLink } from '../src/sign-in-link.js'

const APP = 'https://bloombot.example'

describe('buildSignInLink (MCP-12)', () => {
  it('omits the query entirely when there is nowhere to return to', () => {
    expect(buildSignInLink(APP, 'tok-abc')).toBe(
      'https://bloombot.example/sign-in/tok-abc'
    )
  })

  it('appends the destination as the first query parameter', () => {
    expect(buildSignInLink(APP, 'tok-abc', '/join/xyz')).toBe(
      'https://bloombot.example/sign-in/tok-abc?destination=%2Fjoin%2Fxyz'
    )
  })

  // The destination this flow actually carries — a connect-assistant path
  // whose own id is a URL-unsafe value if it is not encoded.
  it('percent-encodes the destination, so its own slashes and query cannot escape', () => {
    const url = buildSignInLink(APP, 'tok-abc', '/connect-assistant/req-1?a=b')
    expect(url).toBe(
      'https://bloombot.example/sign-in/tok-abc?destination=%2Fconnect-assistant%2Freq-1%3Fa%3Db'
    )
    // The whole destination is one parameter — nothing in it became a
    // second one that a reader could mistake for the app's own.
    expect([...new URL(url).searchParams.keys()]).toEqual(['destination'])
  })

  // The property `pages/RedeemLink.tsx` depends on: what it reads back out
  // of `window.location.search` is exactly what was put in.
  it('round-trips: the destination read back off the URL is the one supplied', () => {
    const destination = '/connect-assistant/req-1'
    const url = new URL(buildSignInLink(APP, 'tok-abc', destination))
    expect(url.searchParams.get('destination')).toBe(destination)
    expect(url.pathname).toBe('/sign-in/tok-abc')
  })
})
