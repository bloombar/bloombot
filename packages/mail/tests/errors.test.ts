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

  // Must-fix 1 of a second review round: `ECONNECTION` (one of
  // `connection_failed`'s own codes) is not always locally-generated —
  // nodemailer's own `smtp-connection` appends a server's trailing reply to
  // `.message` and sets `.response` to the same text whenever `_onClose`
  // catches one, reachable at any point in the conversation including
  // after `DATA`. A prior round's `KINDS_WITH_SAFE_MESSAGE` kept
  // `connection_failed`'s `message` unconditionally, on the (here, false)
  // assumption that the kind alone meant "generated locally, never a
  // server's own words" — this is the reproduction that disproved it.
  it('withholds message for connection_failed when the cause carries a response, even though connection_failed is normally safe', () => {
    const classified = classifySmtpError({
      code: 'ECONNECTION',
      command: 'CONN',
      responseCode: 550,
      response:
        '550 message rejected: body contains a blocked link https://app.example.test/sign-in?token=SUPERSECRETTOKEN12345',
      message:
        'Connection closed unexpectedly: 550 message rejected: body contains a blocked link https://app.example.test/sign-in?token=SUPERSECRETTOKEN12345',
    })

    expect(classified.kind).toBe('connection_failed')
    expect(classified.message).not.toContain('SUPERSECRETTOKEN12345')
    expect(classified.message).not.toContain('blocked link')
    expect(JSON.stringify(classified)).not.toContain('SUPERSECRETTOKEN12345')
    expect(classified.stack ?? '').not.toContain('SUPERSECRETTOKEN12345')
  })

  // The other half of the same fix, proven in the same breath so a future
  // tightening cannot silently regress the case this whole mechanism
  // exists to keep: an ordinary local connection failure — no `.response`
  // at all, the shape `ECONNREFUSED`/`ENOTFOUND` actually carry — still
  // keeps its message. Withholding *every* `connection_failed` message
  // regardless of `.response` would "fix" this round's finding by deleting
  // the diagnostic value the previous round added must-fix 3 for.
  it('still keeps message for connection_failed when the cause carries no response at all', () => {
    const classified = classifySmtpError({
      code: 'ECONNECTION',
      command: 'CONN',
      message: 'connect ECONNREFUSED 127.0.0.1:2525',
    })

    expect(classified.kind).toBe('connection_failed')
    expect(classified.message).toContain('connect ECONNREFUSED 127.0.0.1:2525')
  })
})
