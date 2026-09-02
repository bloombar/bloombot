/**
 * `classifySmtpError`'s own mapping, unit-tested directly against the
 * shapes `tests/smtp.test.ts`'s module comment says were reproduced by hand
 * against a real loopback server before this file was written — this suite
 * covers the same mapping without paying for a live SMTP conversation per
 * case, plus the one property that matters most: `response` (the field that
 * carried a spam filter's own free-text quote-back in that exploration)
 * never reaches the classified error at all.
 */

import { describe, expect, it } from 'vitest'

import { classifySmtpError, MailTransportError } from '../src/errors.js'

describe('classifySmtpError', () => {
  it.each([
    ['EAUTH', 'auth_failed'],
    ['ECONNECTION', 'connection_failed'],
    ['ESOCKET', 'connection_failed'],
    ['EDNS', 'connection_failed'],
    ['ETLS', 'connection_failed'],
    ['ETIMEDOUT', 'timed_out'],
    ['EENVELOPE', 'rejected'],
    ['EMESSAGE', 'rejected'],
    ['ESOMETHINGNEW', 'unknown'],
    [undefined, 'unknown'],
  ] as const)('classifies code %s as %s', (code, kind) => {
    const classified = classifySmtpError({ code, command: 'DATA' })
    expect(classified.kind).toBe(kind)
  })

  it('is a MailTransportError carrying command and responseCode, never the raw response text', () => {
    const classified = classifySmtpError({
      code: 'EMESSAGE',
      command: 'DATA',
      responseCode: 550,
      // The field this whole file exists to keep out of the classified
      // error — a real relay's free-text reply, which can echo back
      // rejected content.
      response: '550 message rejected: contains SECRET-TOKEN-abc123',
    })

    expect(classified).toBeInstanceOf(MailTransportError)
    expect(classified.command).toBe('DATA')
    expect(classified.responseCode).toBe(550)
    expect(classified.message).not.toContain('SECRET-TOKEN-abc123')
    expect(classified.message).not.toContain('message rejected')
  })

  it('never throws on a cause with no recognizable shape at all', () => {
    expect(() =>
      classifySmtpError('a plain string, not an object')
    ).not.toThrow()
    expect(classifySmtpError(undefined).kind).toBe('unknown')
  })
})
