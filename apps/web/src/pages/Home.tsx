/**
 * The signed-out home page at `/`.
 *
 * **Why this page exists at all.** Until it did, a signed-out visitor to `/`
 * got the sign-in form and nothing else, which Google's OAuth verification
 * refuses outright: "The homepage must describe your app's functionality to
 * its users. Your homepage can not be only a login page." The same review
 * requires the homepage to identify the app and to link the privacy policy at
 * the address given on the consent screen. Each section below answers one of
 * those requirements, and the sign-in form is still here — at the bottom,
 * after the description, rather than instead of it.
 *
 * **Why the privacy summary is here and not only on `/privacy`.** Google asks
 * that privacy disclosures be prominent rather than buried, and a summary a
 * visitor meets before signing in is the honest place to say that an
 * instructor can read their conversations. It is a summary, not a substitute:
 * every point links onward to the policy itself, which governs.
 *
 * Everything it claims is deliberately checkable against the software — see
 * `content/privacy.ts` for the same statements at length, and
 * `tests/home.test.tsx` for the ones pinned so they cannot quietly soften.
 */

import { Logo } from '../components/Logo.js'
import { SiteFooter } from '../components/SiteFooter.js'
import { SignIn } from './SignIn.js'

/** One "what it does" item. Plain data so the list reads as content, not markup. */
const CAPABILITIES: readonly { title: string; body: string }[] = [
  {
    title: 'Answers course questions',
    body: 'Students ask in their own Discord channel or in the web chat, and get an answer drawn from the material their instructor supplied — the syllabus, notes, readings and links attached to that course.',
  },
  {
    title: 'One private channel per student',
    body: 'Each student gets their own channel in the course’s Discord server, visible to them and their instructors, so asking a question is not a performance in front of the class.',
  },
  {
    title: 'Run by the instructor, not by us',
    body: 'Instructors create courses, attach material, import a roster, set what the assistant is told to do, and read what their students asked.',
  },
  {
    title: 'Bounded spending',
    body: 'Every course has a spending cap and a daily request limit. When a cap is reached the assistant stops answering for that course rather than running up a bill.',
  },
]

/**
 * The privacy points a visitor should meet before signing in — the ones that
 * would change someone's mind, not the reassuring ones.
 */
const PRIVACY_SUMMARY: readonly string[] = [
  'We record every question asked and every answer given, and keep them.',
  'An instructor can read their own students’ conversations in full. Each time one is read or exported, that access is logged.',
  'Questions are sent to an AI provider (OpenAI) as written, to produce an answer. They are not stripped of names first.',
  'If you sign in with Google, we receive only your email address, name and profile picture, and use them only to identify your account. We request no other Google data, and we never post or read anything in your Google account.',
  'We do not sell this data, and we do not use it for advertising or profiling.',
  'We cannot yet delete an individual student’s data on request, and this service does not promise that it can.',
]

export interface HomeProps {
  /** Passed through to the embedded sign-in form. */
  onSignedIn: () => void
  /**
   * Passed straight through to the embedded `SignIn`'s own `googleClientId`
   * prop — omitted in every ordinary render (`App.tsx` never sets it), so
   * `SignIn` falls back to its own build-time env read exactly as it always
   * has. Set only by the prerender step (`prerender-plugin.ts`), to a
   * placeholder value: the static HTML a `vite build` writes for `/` must
   * never contain SignIn's "not configured" text, because a non-JavaScript
   * crawler (the same Google OAuth reviewer this page exists for) would read
   * that as this service's own sign-in being broken, in a build that simply
   * has not set `VITE_GOOGLE_CLIENT_ID` yet — see `SignIn.tsx`'s own module
   * comment and `docs/DECISIONS.md`'s prerendering entry for why a neutral
   * shell is the fix rather than failing the build.
   */
  googleClientId?: string
}

export function Home({ onSignedIn, googleClientId }: HomeProps) {
  return (
    <div className="min-h-screen bg-neutral-50" data-testid="home-page">
      <main className="mx-auto max-w-3xl px-4 py-12">
        <header className="flex flex-col items-center text-center">
          <Logo className="size-16" title="Bloombot" />
          <h1 className="mt-4 text-2xl font-semibold text-neutral-900">
            Bloombot
          </h1>
          <p className="mt-2 max-w-xl text-base text-neutral-700">
            A teaching assistant that answers students’ course questions on
            Discord and on the web, using the material their instructor
            supplies.
          </p>
        </header>

        {/* Sign-in sits directly under the header, above the explanation: a
            visitor who already knows what this is should not have to scroll
            past a description to get in. The page still describes the service
            before anything else — the header does that — which is what
            Google's homepage requirement actually asks for. */}
        <section aria-labelledby="sign-in" className="mt-10">
          <h2 id="sign-in" className="sr-only">
            Sign in
          </h2>
          {/* Instructors sign in here; students reach the service through
              Discord or an emailed invitation and never see this page. */}
          <SignIn
            onSignedIn={onSignedIn}
            {...(googleClientId !== undefined ? { googleClientId } : {})}
          />
        </section>

        <section aria-labelledby="what-it-does" className="mt-12">
          <h2
            id="what-it-does"
            className="text-lg font-semibold text-neutral-900"
          >
            What it does
          </h2>
          <dl className="mt-4 grid gap-5 sm:grid-cols-2">
            {CAPABILITIES.map((item) => (
              <div key={item.title}>
                <dt className="text-sm font-semibold text-neutral-900">
                  {item.title}
                </dt>
                <dd className="mt-1 text-sm leading-6 text-neutral-700">
                  {item.body}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="privacy-summary" className="mt-12">
          <h2
            id="privacy-summary"
            className="text-lg font-semibold text-neutral-900"
          >
            Privacy, in short
          </h2>
          <p className="mt-2 text-sm leading-6 text-neutral-700">
            The short version, so nobody has to read the full policy to learn
            the parts that matter most:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-neutral-700">
            {PRIVACY_SUMMARY.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <p className="mt-4 text-sm leading-6 text-neutral-700">
            This is a summary and nothing more. The{' '}
            <a href="/privacy" className="text-brand-600 underline">
              privacy policy
            </a>{' '}
            is what actually governs, and the{' '}
            <a href="/terms" className="text-brand-600 underline">
              terms &amp; conditions
            </a>{' '}
            set out the agreement.
          </p>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
