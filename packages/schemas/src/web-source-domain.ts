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

// RFC 1035 §2.3.4/§3.1 — a label (the text between dots) is 1-63
// characters, alphanumeric at both ends, with hyphens allowed only in the
// interior. `VALID_HOST_CHARACTERS_RE` above only bounds the *alphabet* a
// domain uses; without this, `a..b.edu` (an empty label), `.example.edu`
// (a leading empty label), `-evil.edu`/`example.edu-` (a label starting or
// ending with a hyphen) and a label over 63 characters all passed that
// check and were stored and shown back to an instructor as a working
// website — one `allowed_domains` (MDL-9) can never actually match, so the
// course silently answers ungrounded by whatever the instructor thought
// they had just configured. Anchored per-label (`^...$`) against each
// piece `rest.split('.')` produces, not the whole string at once — a dot
// itself is never inside a label.
const VALID_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

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
 * path/query/fragment (whatever follows the first `/`, `?`, `#` or `\\` —
 * the `pathStart` regex's own doc comment, below, on why a backslash counts
 * too), a userinfo prefix (`user:pass@host`, never expected from an
 * instructor but stripped rather than tripping the invalid-character
 * refusal on the `@`), a port, and any trailing dots — then lowercased.
 * **Never stripped**: a leading `www.` — a site served only at
 * `www.example.edu` would otherwise have its own working domain silently
 * rewritten to one that answers nothing.
 *
 * Refused, always with a plain-English `reason` an instructor's own error
 * message can surface directly (WEB-31): an empty string (before or after
 * the reductions above — `https://` alone reduces to nothing); anything
 * left containing whitespace; anything left with no dot (a bare
 * `localhost`, or a single label); a bare IPv4 literal
 * (`isIpv4Literal`, above); anything longer than `MAX_DOMAIN_LENGTH`
 * characters once reduced; anything left containing a character outside
 * `VALID_HOST_CHARACTERS_RE` (a stray space already refused above, but also
 * e.g. an underscore, a literal `@` that survived because it was not
 * preceded by userinfo, or a bracketed IPv6 literal — none of the shapes
 * WEB-31 asks this to accept); and any label (the text between dots) that
 * is empty, starts or ends with a hyphen, or is over 63 characters
 * (`VALID_LABEL_RE`'s own doc comment, above) — a domain that passes the
 * character-set check but fails this one is exactly as unusable to
 * `allowed_domains` (MDL-9) as one that fails the character-set check
 * outright, so both refuse identically rather than one silently storing a
 * site that can never actually match.
 */
export function normalizeWebSourceDomain(input: string): WebSourceDomainResult {
  const trimmed = input.trim()
  if (trimmed === '') return refuse('Enter a website.')
  if (/\s/.test(trimmed)) {
    return refuse('A website must not contain spaces.')
  }

  let rest = trimmed.replace(/^https?:\/\//i, '')

  // Path, query or fragment — whatever follows the first `/`, `?`, `#` or
  // `\\`. The backslash is not a path separator in the URL spec's own
  // prose, but WHATWG URL parsing (what every real browser, and this
  // platform's own students, actually use) treats it as equivalent to `/`
  // in a special ("http"/"https") URL — without this,
  // `https://example.edu\\@evil.com` normalized to `evil.com` (the `@`
  // rule below reads it as userinfo on `evil.com`) while a real browser
  // resolves the very same string's host as `example.edu`, so this
  // function and the surface it exists to protect an instructor from
  // disagreed about which site a pasted URL even names.
  const pathStart = rest.search(/[/?#\\]/)
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
  // RFC 1035 §2.3.4/§3.1 (`VALID_LABEL_RE`'s own doc comment, above) — the
  // character-set check just above is necessary but not sufficient: it
  // passes `a..b.edu`, `.example.edu`, `-evil.edu`, `example.edu-` and a
  // 70-character label, none of which `allowed_domains` (MDL-9) can ever
  // actually match.
  for (const label of rest.split('.')) {
    if (!VALID_LABEL_RE.test(label)) {
      return refuse(
        'Enter a valid domain — each part between dots must start and end with a letter or digit, and be no more than 63 characters.'
      )
    }
  }

  return { ok: true, domain: rest }
}
