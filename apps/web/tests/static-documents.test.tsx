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

  it('does not open with a draft-pending-review banner', () => {
    // Google's OAuth review reads a page that announces itself as an
    // unreviewed draft as evidence it is not a published policy at all
    // (`content/document.ts`'s own module comment on why the banner is
    // gone) — this is what stops that banner from quietly coming back.
    for (const doc of [privacyDocument, termsDocument]) {
      expect(flat(doc.body)).not.toMatch(/draft, pending legal review/i)
      expect(flat(doc.body)).not.toMatch(/has not been reviewed by a lawyer/i)
    }
  })

  it('carries no square-bracket placeholder', () => {
    // `[Operator legal name]`-style text is exactly what a reviewer reads as
    // "no real party stands behind this policy" — the failure this policy
    // was rejected for. Excludes Markdown's own `[label](url)` link syntax
    // (`[Privacy policy](/privacy)` is a real, intentional link, not a
    // placeholder) by requiring the bracketed text not be followed by `(`.
    for (const doc of [privacyDocument, termsDocument]) {
      expect(doc.body).not.toMatch(/\[[^\]]*\](?!\()/)
    }
  })

  it('identifies the operator by name', () => {
    for (const doc of [privacyDocument, termsDocument]) {
      expect(flat(doc.body)).toMatch(/Bloombot/)
    }
  })

  describe('Google account data', () => {
    it('describes what Google Sign-In gives this service, and that it never receives a password', () => {
      expect(flat(privacyDocument.body)).toMatch(
        /email address, your\s*name and your profile picture/i
      )
      expect(flat(privacyDocument.body)).toMatch(/never receive a password/i)
    })

    it('states Google account data is never used for advertising, profiling or credit decisions', () => {
      expect(flat(privacyDocument.body)).toMatch(
        /not used for advertising or profiling/i
      )
      expect(flat(privacyDocument.body)).toMatch(
        /never a factor in a credit decision/i
      )
    })

    it('states Google account data is never used to train an AI or machine-learning model', () => {
      expect(flat(privacyDocument.body)).toMatch(
        /never used to train any AI or machine-learning model/i
      )
      expect(flat(privacyDocument.body)).toMatch(
        /never sent to the model provider/i
      )
    })

    it('gives a concrete deletion path for a Google-linked account, without promising a finer-grained one than the software has', () => {
      // The manual path is real (tenant-level deletion, described below in
      // "How long we keep it"), but it deletes the whole organization, not
      // only the Google-linked account — this must not read as a per-account
      // delete button the platform does not have.
      expect(flat(privacyDocument.body)).toMatch(
        /ask for your whole organization to be deleted/i
      )
      expect(flat(privacyDocument.body)).toMatch(
        /no button that deletes only your account/i
      )
    })
  })

  describe('the promises these documents deliberately withhold', () => {
    // Phase 44 (DATA-7..DATA-9, WEB-72, WEB-73) built deletion, so the three
    // assertions that used to live here — "per-student deletion does not
    // exist", "no retention window", and a ban on the word "erase" — pinned
    // claims that are now false. What replaces them guards the two ways this
    // section can still go wrong: claiming a statutory compliance nobody has
    // established, and claiming an expiry the sweep does not perform.
    it('claims compliance with no statute', () => {
      const forbidden = [
        /(?:FERPA|GDPR|CCPA|COPPA)[- ]compliant/i,
        /we comply with (?:FERPA|GDPR|CCPA|COPPA)/i,
        /right to be forgotten/i,
        /we honou?r (?:them|erasure)/i,
      ]
      for (const doc of [privacyDocument, termsDocument]) {
        for (const pattern of forbidden) {
          expect(flat(doc.body)).not.toMatch(pattern)
        }
      }
    })

    it('does not claim live content expires on its own — only deleted content is swept', () => {
      const body = flat(privacyDocument.body)
      expect(body).toMatch(/We keep what you give us until it is deleted/i)
      expect(body).toMatch(/Nothing expires on its own/i)
    })

    it('states what deletion does and when it becomes permanent', () => {
      const body = flat(privacyDocument.body)
      // Who can delete what — the screens the product actually offers.
      expect(body).toMatch(
        /A person can delete their own conversation history in a course/i
      )
      expect(body).toMatch(/delete their own account/i)
      // The window, stated as a number rather than as "a short time".
      expect(body).toMatch(/that window is \*\*30 days\*\*/i)
      expect(body).toMatch(/permanently erases the records and the files/i)
      // And that the provider's copies go too, which is the part a reader
      // cannot verify for themselves.
      expect(body).toMatch(/including the copies held by the AI provider/i)
    })

    // D-142: the sweep cannot remove the `people` row of anyone who has ever
    // asked a question, because the usage record that question created holds a
    // non-null reference to it. Their conversations and messages *are* swept.
    // Saying only the first half would make this page false in exactly the way
    // the pre-phase-44 text was, so the page says both — and this pins it.
    it('names the limit on erasing a person who has asked a question', () => {
      const body = flat(privacyDocument.body)
      expect(body).toMatch(
        /Their conversations and messages are erased on the schedule above/i
      )
      expect(body).toMatch(/that naming record is not/i)
    })

    it('says which records survive a deletion, and why', () => {
      const body = flat(privacyDocument.body)
      expect(body).toMatch(/accounts of \*?events\*? rather than content/i)
      expect(body).toMatch(
        /a record of an action cannot be erasable by the person who took it/i
      )
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

    // The platform-administrator console gained organization, project, course
    // and account screens in SPEC §45 (ADMIN-7..ADMIN-14). The policy used to
    // say that console "does not display any course, student or message",
    // which those screens made false for two of the three. These pin the
    // corrected claim from both sides: the disclosure must stay, and the old
    // sentence must not come back.
    it('discloses that the administration console shows courses and the people on the platform', () => {
      const body = flat(privacyDocument.body)
      expect(body).toMatch(
        /administration console covering the whole platform/i
      )
      expect(body).toMatch(/course's settings, instructions and the material/i)
      expect(body).toMatch(
        /names, email addresses, the courses they belong to/i
      )
    })

    it('does not claim the administration console hides courses or students', () => {
      expect(flat(privacyDocument.body)).not.toMatch(
        /console does not display any course/i
      )
    })

    // The console cannot reach a transcript today (ADMIN-4), and an earlier
    // version of this policy said so. That is a boundary a future release may
    // move — platform-wide transcript access is a feature the operator may
    // choose to add — so the policy deliberately does not promise it. It goes
    // further, because it has to: whatever any screen shows, an operator or
    // developer holds the server and the database file and can read every
    // record in it. These stop either promise from being written back in.
    it('promises no limit on what an operator can see, transcripts included', () => {
      const body = flat(privacyDocument.body)
      const forbidden = [
        /conversations are the exception/i,
        /cannot see what that student asked/i,
        /(?:console|administrators?) (?:does |do )?not (?:display|show|reach)[^.]*(?:message|conversation|transcript)/i,
        /(?:message|conversation|transcript)s? (?:are|is|stay|remain)[^.]*(?:out of reach|beyond the reach)/i,
      ]
      for (const pattern of forbidden) {
        expect(body).not.toMatch(pattern)
      }
    })

    it('says the operator holds the server and database and can read every record', () => {
      const body = flat(privacyDocument.body)
      expect(body).toMatch(/hold the server it runs on and the database file/i)
      expect(body).toMatch(
        /reaches every record the service keeps, students' conversations included/i
      )
      expect(body).toMatch(
        /makes no promise of privacy from the people who operate the service, for any data it holds/i
      )
    })

    it("does not offer the Security section's measures as protection from the operator", () => {
      expect(flat(privacyDocument.body)).toMatch(
        /guard the service against people outside it\. They are not, and are not offered as, protection against the people who run it/i
      )
    })

    it('warns an instructor in the terms that the operator can reach their course data', () => {
      expect(flat(termsDocument.body)).toMatch(
        /We can reach everything the service stores for your course/i
      )
      expect(flat(termsDocument.body)).toMatch(
        /no privacy guarantee against that/i
      )
    })

    // The researched position (see `terms.ts`'s own module comment): never
    // assert non-compliance, never claim a consent that does not exist, and do
    // say the factual § 99.31(a)(1)(i)(B) thing. These pin both halves.
    it('makes no representation of FERPA suitability, and asserts no non-compliance', () => {
      const body = flat(termsDocument.body)
      expect(body).toMatch(
        /make no representation that the service is suitable for education records/i
      )
      expect(body).not.toMatch(/not FERPA[- ]compliant/i)
      expect(body).not.toMatch(/we are not compliant/i)
    })

    it('states the school-official position as a fact about a written agreement', () => {
      expect(flat(termsDocument.body)).toMatch(
        /not acting as a "school official"[^.]*99\.31\(a\)\(1\)\(i\)\(B\)/i
      )
    })

    it('denies that anything here is a consent given for a student', () => {
      expect(flat(termsDocument.body)).toMatch(
        /Nothing in these terms is a consent given on behalf of any student/i
      )
      expect(flat(privacyDocument.body)).toMatch(
        /is a consent given on behalf of a student under FERPA/i
      )
      for (const doc of [privacyDocument, termsDocument]) {
        expect(flat(doc.body)).not.toMatch(
          /(?:using|use of) the service (?:constitutes|is) (?:your )?consent/i
        )
      }
    })

    it('offers a route to a data protection agreement rather than a dead end', () => {
      expect(flat(termsDocument.body)).toMatch(
        /data protection agreement, a FERPA addendum, or a completed HECVAT/i
      )
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
