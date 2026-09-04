/**
 * WEB-31 — the one place an instructor-typed website is turned into the
 * bare domain form `course_web_sources.domain` (`@bloombot/db`'s schema)
 * stores and `@bloombot/openai`'s adapter sends as a `web_search` tool's
 * `filters.allowed_domains` entry (MDL-9). "Accepted and reduced to its
 * domain rather than refused" is the requirement's own phrase: a full URL
 * pasted from a browser's address bar (`https://docs.python.org/3/`) is a
 * success, not a refusal — an instructor should never have to know that a
 * scheme or a trailing path is not itself the "domain" this stores.
 *
 * Lives in `@bloombot/schemas`, not `@bloombot/core`: `packages/actions`
 * (the one caller that needs this at the input-validation boundary,
 * `actions/course-web-sources.ts`) already depends on `zod` directly but
 * has no dependency on `@bloombot/core` today, and `@bloombot/core` is the
 * surface-agnostic *answering pipeline* (`packages/core/src/answer.ts`'s
 * own module comment) — routing, the daily allowance, the model port —
 * none of which this helper has anything to do with. `@bloombot/schemas`
 * is already this repo's home for a small, dependency-free (zod alone)
 * validation helper reused by more than one package
 * (`packages/legacy-import` already depends on it for the same reason);
 * adding this one here costs `packages/actions` a single new dependency on
 * a package that already depends on nothing but `zod`, rather than a new
 * dependency on the entire answering pipeline just to normalize a string.
 *
 * Deliberately narrow: this never fetches, resolves DNS, or checks a
 * domain actually exists — it is a pure, syntactic reduction, the same
 * "never more than what the requirement asks" discipline every schema in
 * this package already holds itself to (`roster.ts`'s own module comment).
 */

/** What `normalizeWebSourceDomain` hands back — never both. */
export type WebSourceDomainResult =
  { ok: true; domain: string } | { ok: false; reason: string }

// WEB-31's own ceiling — a domain name's own limit (RFC 1035 §3.1), not
// anything about a whole URL: measured only after every scheme, path,
// query, fragment and port has already been stripped, below.
const MAX_DOMAIN_LENGTH = 253

// A bare host's own alphabet once every one of the pieces above has been
// stripped: letters, digits, hyphens and the dots between labels. Nothing
// here is Unicode-aware (an internationalized domain typed in its native
// script, rather than its `xn--` punycode form, is refused) — out of
// scope for this slice; see `docs/DECISIONS.md`.
const VALID_HOST_CHARACTERS_RE = /^[a-z0-9.-]+$/

/** A bare IPv4 literal ("192.0.2.1") — refused (WEB-31's own "an IP-literal-only input"): `allowed_domains` restricts by domain, and an IP address is never one. */
function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/** A plain, reusable refusal — every early return below funnels through this so the shape (`{ ok: false, reason }`) is identical everywhere. */
function refuse(reason: string): WebSourceDomainResult {
  return { ok: false, reason }
}

/**
 * Reduce what an instructor typed to the bare domain `course_web_sources`
 * stores, or refuse it.
 *
 * Accepted and reduced (WEB-31): a leading `http://`/`https://` scheme, a
 * path/query/fragment (whatever follows the first `/`, `?` or `#`), a
 * userinfo prefix (`user:pass@host`, never expected from an instructor but
 * stripped rather than tripping the invalid-character refusal on the `@`),
 * a port, and any trailing dots — then lowercased. **Never stripped**: a
 * leading `www.` — a site served only at `www.example.edu` would otherwise
 * have its own working domain silently rewritten to one that answers
 * nothing.
 *
 * Refused, always with a plain-English `reason` an instructor's own error
 * message can surface directly (WEB-31): an empty string (before or after
 * the reductions above — `https://` alone reduces to nothing); anything
 * left containing whitespace; anything left with no dot (a bare
 * `localhost`, or a single label); a bare IPv4 literal
 * (`isIpv4Literal`, above); anything longer than `MAX_DOMAIN_LENGTH`
 * characters once reduced; and anything left containing a character
 * outside `VALID_HOST_CHARACTERS_RE` (a stray space already refused above,
 * but also e.g. an underscore, a literal `@` that survived because it was
 * not preceded by userinfo, or a bracketed IPv6 literal — none of the
 * shapes WEB-31 asks this to accept).
 */
export function normalizeWebSourceDomain(input: string): WebSourceDomainResult {
  const trimmed = input.trim()
  if (trimmed === '') return refuse('Enter a website.')
  if (/\s/.test(trimmed)) {
    return refuse('A website must not contain spaces.')
  }

  let rest = trimmed.replace(/^https?:\/\//i, '')

  // Path, query or fragment — whatever follows the first `/`, `?` or `#`.
  const pathStart = rest.search(/[/?#]/)
  if (pathStart !== -1) rest = rest.slice(0, pathStart)

  // Userinfo (`user:pass@host`) — this file's own doc comment on why this
  // is stripped rather than left to trip the character check below.
  const atIndex = rest.lastIndexOf('@')
  if (atIndex !== -1) rest = rest.slice(atIndex + 1)

  // Port.
  const colonIndex = rest.indexOf(':')
  if (colonIndex !== -1) rest = rest.slice(0, colonIndex)

  // Trailing dots ("example.edu.", a fully-qualified name written out in
  // full) — never meaningfully different from "example.edu" for this
  // platform's own purposes.
  rest = rest.replace(/\.+$/, '')

  rest = rest.toLowerCase()

  if (rest === '') return refuse('Enter a website.')
  if (rest.length > MAX_DOMAIN_LENGTH) {
    return refuse(
      `A website's domain must be at most ${MAX_DOMAIN_LENGTH} characters.`
    )
  }
  if (!rest.includes('.')) {
    return refuse('Enter a full domain, such as example.edu.')
  }
  if (isIpv4Literal(rest)) {
    return refuse('Enter a domain name, not a bare IP address.')
  }
  if (!VALID_HOST_CHARACTERS_RE.test(rest)) {
    return refuse(
      'A website contains characters that are not part of a valid domain.'
    )
  }

  return { ok: true, domain: rest }
}
