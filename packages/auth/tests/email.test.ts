/**
 * The mail port and its recording fake — no SMTP client, no network.
 */

import { describe, expect, it } from 'vitest'

import { RecordingEmailSender } from '../src/email.js'

describe('RecordingEmailSender', () => {
  it('records every send instead of transmitting anything', async () => {
    const sender = new RecordingEmailSender()

    await sender.send('student@example.edu', 'Sign in to Bloombot', 'Link: …')
    await sender.send('other@example.edu', 'Sign in to Bloombot', 'Link: …')

    expect(sender.sent).toEqual([
      {
        to: 'student@example.edu',
        subject: 'Sign in to Bloombot',
        body: 'Link: …',
      },
      {
        to: 'other@example.edu',
        subject: 'Sign in to Bloombot',
        body: 'Link: …',
      },
    ])
  })
})
