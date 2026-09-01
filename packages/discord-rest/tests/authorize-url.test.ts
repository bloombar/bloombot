/**
 * `buildDiscordAuthorizationUrl` — pure string construction, no network at
 * all, so unlike `client.test.ts` this needs no fake server.
 */

import { describe, expect, it } from 'vitest'

import { buildDiscordAuthorizationUrl } from '../src/authorize-url.js'

describe('buildDiscordAuthorizationUrl', () => {
  it('builds an authorize URL with response_type, client_id, redirect_uri, state and the S256 PKCE challenge', () => {
    const url = new URL(
      buildDiscordAuthorizationUrl({
        oauthBase: 'http://127.0.0.1:9999',
        clientId: 'test-client-id',
        redirectUri: 'https://app.bloombot.test/discord/callback',
        state: 'the-state',
        codeChallenge: 'the-challenge',
      })
    )

    expect(url.origin + url.pathname).toBe('http://127.0.0.1:9999/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('test-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.bloombot.test/discord/callback'
    )
    expect(url.searchParams.get('state')).toBe('the-state')
    expect(url.searchParams.get('code_challenge')).toBe('the-challenge')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    // Default scope — TEN-4's own three needs: install the bot, and read
    // enough to verify the caller administers the guild being installed
    // into.
    expect(url.searchParams.get('scope')).toBe('bot identify guilds')
  })

  it('omits permissions entirely when not given, rather than sending an empty value', () => {
    const url = new URL(
      buildDiscordAuthorizationUrl({
        oauthBase: 'http://127.0.0.1:9999',
        clientId: 'test-client-id',
        redirectUri: 'https://app.bloombot.test/discord/callback',
        state: 'the-state',
        codeChallenge: 'the-challenge',
      })
    )

    expect(url.searchParams.has('permissions')).toBe(false)
  })

  it('includes permissions when given', () => {
    const url = new URL(
      buildDiscordAuthorizationUrl({
        oauthBase: 'http://127.0.0.1:9999',
        clientId: 'test-client-id',
        redirectUri: 'https://app.bloombot.test/discord/callback',
        state: 'the-state',
        codeChallenge: 'the-challenge',
        permissions: '8',
      })
    )

    expect(url.searchParams.get('permissions')).toBe('8')
  })

  it('strips a trailing slash from oauthBase before appending /authorize', () => {
    const url = buildDiscordAuthorizationUrl({
      oauthBase: 'http://127.0.0.1:9999/',
      clientId: 'test-client-id',
      redirectUri: 'https://app.bloombot.test/discord/callback',
      state: 'the-state',
      codeChallenge: 'the-challenge',
    })

    expect(url.startsWith('http://127.0.0.1:9999/authorize?')).toBe(true)
  })
})
