/**
 * WEB-5: a refusal reads as not found, a validation failure names the
 * field, a conflict names what it collided with, and nothing renders a
 * stack trace, an internal message, or an identifier the caller has no
 * use for. This is the test that would fail if `describeApiError` started
 * passing through anything `apps/api` did not already put in the response
 * body — e.g. `error.message` (built from `error.body.error`, a code, not
 * prose a person should read) or a raw `internal_error`'s absent detail.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ApiError } from '../src/api/client.js'
import {
  describeApiError,
  ErrorMessage,
} from '../src/components/ErrorMessage.js'

describe('describeApiError (WEB-5)', () => {
  it('a refusal (action_refused) reads as not found — nothing about what it protected', () => {
    const error = new ApiError(404, { error: 'action_refused' })
    const { headline, details } = describeApiError(error)
    expect(headline).toMatch(/not found/i)
    expect(details).toEqual([])
  })

  it('action_unknown reads the same as action_refused — indistinguishable, per TEN-5', () => {
    const refused = describeApiError(
      new ApiError(404, { error: 'action_refused' })
    )
    const unknown = describeApiError(
      new ApiError(404, { error: 'action_unknown' })
    )
    expect(unknown.headline).toEqual(refused.headline)
  })

  it('a validation failure names the field that was wrong', () => {
    const error = new ApiError(400, {
      error: 'action_input_invalid',
      issues: [{ path: ['email'], message: 'Invalid email' }],
    })
    const { details } = describeApiError(error)
    expect(details).toEqual(['email: Invalid email'])
  })

  it('a conflict names what it collided with, from the API-supplied message', () => {
    const error = new ApiError(409, {
      error: 'action_conflict',
      conflict: { message: 'A course named "Intro" already exists.' },
    })
    const { headline } = describeApiError(error)
    expect(headline).toBe('A course named "Intro" already exists.')
  })

  // ADMIN-4/ADMIN-5 — new codes this slice's admin console reaches, named
  // plainly rather than falling through to the generic `default` case.
  it('not_platform_administrator names the reason (ADMIN-4)', () => {
    const error = new ApiError(403, { error: 'not_platform_administrator' })
    const { headline } = describeApiError(error)
    expect(headline).toMatch(/platform-administrator/i)
  })

  it('confirmation_name_mismatch says nothing was deleted (ADMIN-5)', () => {
    const error = new ApiError(409, { error: 'confirmation_name_mismatch' })
    const { headline } = describeApiError(error)
    expect(headline).toMatch(/did not match/i)
  })

  // ENRL-10 — named plainly, the same "no oracle" shape `join_link_not_found`
  // already gives ENRL-4: never issued, revoked, expired, already-redeemed,
  // wrong-account and already-a-member are all one code, one message.
  it('membership_invitation_not_found names the invitation, not the reason', () => {
    const error = new ApiError(404, {
      error: 'membership_invitation_not_found',
    })
    const { headline } = describeApiError(error)
    expect(headline).toMatch(/invitation/i)
  })

  it('an unexpected failure (internal_error) discloses nothing beyond a generic message', () => {
    const error = new ApiError(500, { error: 'internal_error' })
    const { headline, details } = describeApiError(error)
    expect(headline).not.toMatch(/internal_error/)
    expect(headline).not.toMatch(/stack/i)
    expect(details).toEqual([])
  })

  it('ErrorMessage renders the headline and, when present, the field details', () => {
    const error = new ApiError(400, {
      error: 'invalid_request',
      issues: [{ path: ['token'], message: 'Required' }],
    })
    render(<ErrorMessage error={error} />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That did not look right.'
    )
    expect(screen.getByText('token: Required')).toBeInTheDocument()
  })
})
