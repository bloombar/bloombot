/**
 * `api/client.ts` (WEB-2, WEB-5): every call sends credentials and no
 * `Authorization` header, and a non-2xx response becomes an `ApiError`
 * carrying the API's own body unchanged — nothing here reinterprets it.
 * `global.fetch` is mocked directly rather than reaching a real server:
 * this is a unit test of the client's own request/error shape, not of
 * `apps/api` (that is `apps/api/tests`' own job, and `e2e/`'s for the
 * signed-in path end to end, QA-7).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, fetchMe, requestSignInLink } from '../src/api/client.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api/client.ts', () => {
  it('sends credentials and no Authorization header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { account: null }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchMe()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.credentials).toBe('include')
    const headers = new Headers(init.headers)
    expect(headers.has('authorization')).toBe(false)
  })

  it('a non-2xx response throws an ApiError carrying the response body unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(400, {
        error: 'invalid_request',
        issues: [{ path: ['email'], message: 'Invalid email' }],
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestSignInLink('not-an-email')).rejects.toMatchObject({
      status: 400,
      body: {
        error: 'invalid_request',
        issues: [{ path: ['email'], message: 'Invalid email' }],
      },
    })
  })

  it('is an instance of ApiError so callers can narrow with instanceof', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(404, { error: 'action_refused' }))
    vi.stubGlobal('fetch', fetchMock)

    try {
      await fetchMe()
      expect.unreachable('fetchMe should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
    }
  })

  it('a 204 response resolves with no body, rather than throwing on empty JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      requestSignInLink('student@example.edu')
    ).resolves.toBeUndefined()
  })
})
