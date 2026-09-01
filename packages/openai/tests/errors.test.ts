/**
 * `errors.ts` — MDL-5's retry classification and MDL-4's unknown-conversation
 * detection, tested against plain HTTP status/body pairs with no network.
 */

import { describe, expect, it } from 'vitest'

import {
  classifyHttpError,
  ModelRequestError,
  timeoutError,
} from '../src/errors.js'

describe('classifyHttpError (MDL-5): retryable vs. not', () => {
  it('classifies 429 as a retryable rate_limit', () => {
    const error = classifyHttpError(429, {
      error: { message: 'Rate limit exceeded' },
    })
    expect(error.kind).toBe('rate_limit')
    expect(error.retryable).toBe(true)
    expect(error.message).toBe('Rate limit exceeded')
  })

  it('classifies 500 and other 5xx as a retryable server_error', () => {
    expect(classifyHttpError(500, {}).kind).toBe('server_error')
    expect(classifyHttpError(503, {}).retryable).toBe(true)
  })

  it('classifies an ordinary 400 as a non-retryable client_error', () => {
    const error = classifyHttpError(400, {
      error: { message: 'Invalid request: bad model' },
    })
    expect(error.kind).toBe('client_error')
    expect(error.retryable).toBe(false)
    expect(error.message).toBe('Invalid request: bad model')
  })

  it('classifies a 404 naming the conversation as unknown_conversation, not a plain client_error', () => {
    const error = classifyHttpError(404, {
      error: {
        message: 'No conversation found with id conv_gone',
        code: 'conversation_not_found',
      },
    })
    expect(error.kind).toBe('unknown_conversation')
    expect(error.retryable).toBe(false)
  })

  it('classifies a 404 identified by param rather than code as unknown_conversation too', () => {
    const error = classifyHttpError(404, {
      error: { message: 'Unknown conversation', param: 'conversation' },
    })
    expect(error.kind).toBe('unknown_conversation')
  })

  it('classifies a 404 on something other than a conversation as an ordinary client_error', () => {
    const error = classifyHttpError(404, {
      error: { message: 'No such model', code: 'model_not_found' },
    })
    expect(error.kind).toBe('client_error')
  })

  it('falls back to a placeholder message when the body has no error.message', () => {
    const error = classifyHttpError(500, {})
    expect(error.message).toContain('OpenAI request failed')
  })
})

describe('timeoutError (MDL-5)', () => {
  it('is retryable and carries the timeout in its message', () => {
    const error = timeoutError(5000)
    expect(error).toBeInstanceOf(ModelRequestError)
    expect(error.kind).toBe('timeout')
    expect(error.retryable).toBe(true)
    expect(error.message).toContain('5000')
  })
})
