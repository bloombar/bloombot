/**
 * The two published legal documents at `/privacy` and `/terms`.
 *
 * Two things are worth pinning here, and neither is "the page renders".
 *
 * **They must render signed out.** A privacy policy reachable only with an
 * account is not published, and Google's OAuth review asks for one at a public
 * address. `App.tsx` matches these routes above every session-dependent
 * branch; a later refactor that moves them below one would break that
 * silently, because a signed-in developer would never notice.
 *
 * **They must not promise what the platform cannot do.** The instruction these
 * documents were written under was explicit: no promise of data deletion or
 * other strong privacy protections, because no per-person deletion path
 * exists. That is a claim about the words, so it is tested as one — a future
 * edit that quietly adds "we will delete your data on request" should fail
 * here rather than ship.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { App } from '../src/App.js'
import { privacyDocument } from '../src/content/privacy.js'
import { termsDocument } from '../src/content/terms.js'

// `App` reads the session on mount for every other route. `{ account: null }`
// is this API's own "nobody is signed in" answer — the same shape
// `tests/app.test.tsx` uses — so these pages are asserted against a real
// signed-out session rather than a rejected promise nothing awaits.
vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    fetchMe: vi.fn().mockResolvedValue({ account: null }),
  }
})

/**
 * A document's body with every run of whitespace collapsed to one space.
 * The bodies are hand-wrapped Markdown, so a sentence asserted on below is
 * routinely split across a line break — matching the raw text would make each
 * assertion depend on where its paragraph happened to wrap.
 */
function flat(body: string): string {
  return body.replace(/\s+/g, ' ')
}

function renderAt(pathname: string) {
  window.history.pushState({}, '', pathname)
  return render(<App />)
}

describe('/privacy and /terms (published legal documents)', () => {
  it('renders the privacy policy without a session', async () => {
    renderAt('/privacy')

    expect(await screen.findByTestId('privacy-page')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 1, name: 'Privacy policy' })
    ).toBeInTheDocument()
  })

  it('renders the terms without a session', async () => {
    renderAt('/terms')

    expect(await screen.findByTestId('terms-page')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 1, name: 'Terms & conditions' })
    ).toBeInTheDocument()
  })

  it('renders the Markdown body as headings, not as literal source', async () => {
    renderAt('/privacy')
    await screen.findByTestId('privacy-page')

    // A `##` that reached the DOM as text would mean the renderer is missing.
    expect(
      screen.getByRole('heading', { level: 2, name: 'What we record' })
    ).toBeInTheDocument()
    expect(screen.queryByText(/^## /)).not.toBeInTheDocument()
  })

  it('marks both documents as unreviewed drafts', () => {
    for (const doc of [privacyDocument, termsDocument]) {
      expect(flat(doc.body)).toMatch(/Draft, pending legal review/)
    }
  })

  describe('the promises these documents deliberately withhold', () => {
    it('does not promise deletion of a person, a conversation or a message', () => {
      // Phrased as the claims a template would have made, since that is what a
      // future edit is most likely to reintroduce.
      const forbidden = [
        /we will delete your data/i,
        /permanently erase/i,
        /right to be forgotten/i,
        /deleted within \d+ days/i,
        /we honou?r (?:them|erasure)/i,
      ]
      for (const pattern of forbidden) {
        expect(flat(privacyDocument.body)).not.toMatch(pattern)
      }
    })

    it('says plainly that per-student deletion does not exist', () => {
      expect(flat(privacyDocument.body)).toMatch(
        /do not currently offer a way to delete an individual student's data/i
      )
    })

    it('promises no retention window', () => {
      expect(flat(privacyDocument.body)).toMatch(/no retention window/i)
    })

    it('promises no availability level in the terms', () => {
      expect(flat(termsDocument.body)).toMatch(
        /do not promise any level of availability/i
      )
    })

    it('warns that student questions reach the model provider un-redacted', () => {
      expect(flat(privacyDocument.body)).toMatch(/sent as written/i)
      expect(flat(privacyDocument.body)).not.toMatch(/de-identified/i)
    })

    it('discloses that instructors can read student conversations', () => {
      expect(flat(privacyDocument.body)).toMatch(
        /instructor can read their own students' conversations/i
      )
      expect(flat(termsDocument.body)).toMatch(
        /can read your students' conversations/i
      )
    })
  })
})
