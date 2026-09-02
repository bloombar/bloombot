/**
 * TEN-2 is a convention ("the first parameter is the organization id"), and a
 * convention nobody checks is one the twentieth repo function quietly breaks.
 * This test reads the actual source of `src/repos/**` and enforces it
 * structurally, rather than trusting every future PR to remember the rule —
 * with an explicit allowlist for the two functions the brief documents as
 * legitimately unscoped.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPOS_DIR = fileURLToPath(new URL('../src/repos', import.meta.url))

// TEN-2's two documented exceptions, and why each is safe:
//  - accounts.ts#getAccountByEmail: an account exists before any organization
//    does, so sign-in has to find it by email alone.
//  - accounts.ts#getAccountById: the same class, one level up (LINK-6) —
//    `GET /auth/me` already knows exactly which account a valid,
//    already-authenticated session proved, before any organization is in
//    play, so scoping this lookup to one would ask the caller to supply
//    something the session itself does not carry. Also what
//    `routes/admin.ts`'s own `isRequestFromPlatformAdministrator` (ADMIN-4)
//    resolves a session's account through: a platform administrator is not
//    necessarily a member of the organization an admin-console read or an
//    ADMIN-5 tenant deletion targets, so `getAccountInOrganization` cannot
//    serve that caller either.
//  - accounts.ts#disableAccount: `disabled_at` lives on `accounts`, not
//    `memberships` — disabling is account-wide, not scoped to one
//    organization (AUTH-1..4 rework, finding 3).
//  - organizations.ts#listTenantDeletions: ADMIN-5's own audit trail, read
//    by the platform-administrator console — spans every (former)
//    organization by definition, the same class `cost-ledger.ts`'s own
//    `listOrganizationTotals` already is for COST-4's platform-wide read.
//  - discord-servers.ts#resolveDiscordServerBinding: this *is* the lookup
//    that establishes which organization an incoming Discord message
//    belongs to, so it cannot itself take an organization id as input.
//  - memberships.ts#listMembershipsForAccount: the same class as
//    accounts.ts#getAccountByEmail — an account can hold a membership in
//    more than one organization, so this is how a caller (apps/api's
//    `GET /auth/me`, API-1..6 rework must-fix 9) discovers which
//    organization ids it may act within, before any one of them is known.
//  - sign-in-tokens.ts / sessions.ts: AUTH-1/AUTH-3. A sign-in token exists
//    to find or create an account, and a session authenticates an account
//    across every organization it belongs to — both sit one level above
//    organization scoping, the same way `accounts.ts` itself does, so every
//    exported function in these two files is keyed on an email or an
//    account id rather than an `organizationId`. `hasActiveSignInToken` is
//    the same "existing/outstanding" check `getAccountByEmail` is, one
//    level up — a cheap mailbox-flooding guard (API-1..6 rework, "also
//    worth doing"): refuse to issue a second link while an unexpired,
//    unused one for the same address already exists.
//  - discord-install-states.ts: TEN-4, the same class as `sign-in-tokens.ts`
//    one level up. A callback carries only the state value Discord echoed
//    back — not an organization id — so `createInstallState`/
//    `consumeInstallState` are keyed on that state's hash instead;
//    `organizationId` lives *in* the row (what the callback claims the
//    eventual binding for), it is just not how the row is found.
//    `deleteExpiredInstallStates` (cheap-fix 8 of the TEN-4..6 rework) is
//    one level up again: it sweeps every organization's already-expired
//    rows on every `beginDiscordInstall` call, deliberately not scoped to
//    the one organization that call is for — an abandoned attempt from a
//    different organization is just as much a dead row worth clearing.
//  - jobs.ts: JOB-1's queue, the same class one level up again.
//    `claimNextJob` is a worker claiming *the next* job to run — it has not
//    resolved an organization yet, the job it happens to claim decides
//    that, so there is nothing to scope the claim itself by (the same
//    reasoning `resolveDiscordServerBinding` already gets). `countQueuedJobs`
//    is `apps/worker`'s own health endpoint's "how deep is the queue"
//    (JOB-5) — an operational metric about the queue as a whole, the same
//    class `deleteExpiredInstallStates` already is.
//  - cost-ledger.ts: `listOrganizationTotals` is COST-4's platform
//    administrator read — "usage per organization", spanning every
//    organization by definition, the same class `countQueuedJobs` already
//    is one level up from every other function in this file.
//  - course-join-links.ts#redeemJoinLink: ENRL-3/ENRL-4, the same class as
//    `sign-in-tokens.ts` — a redeemer presents only the secret, not an
//    organization id, so there is nothing to scope the lookup by until the
//    hash itself resolves one (this file's own module comment).
//  - person-link-challenges.ts: LINK-3, the same class as
//    `discord-install-states.ts` one level up — a callback (Discord's own
//    OAuth) or a token redemption (MCP) carries only the secret value, not
//    an organization id, so `createChallenge`/`consumeChallenge`/`peekChallenge`
//    are keyed on that secret's hash instead; `deleteExpiredChallenges` is
//    the same sweep-on-write device `deleteExpiredInstallStates` already
//    is, deliberately not scoped to one organization either.
//    `repointOutstandingChallenges` is not listed here — it *is*
//    organization-scoped, first parameter and all (`mergePeople`'s own
//    caller already knows the organization; nothing about a merge needs to
//    find a challenge by secret alone).
const ALLOWLIST: Record<string, string[]> = {
  'accounts.ts': ['getAccountByEmail', 'getAccountById', 'disableAccount'],
  'cost-ledger.ts': ['listOrganizationTotals'],
  'organizations.ts': ['listTenantDeletions'],
  'course-join-links.ts': ['redeemJoinLink'],
  'discord-servers.ts': ['resolveDiscordServerBinding'],
  'discord-install-states.ts': [
    'createInstallState',
    'consumeInstallState',
    'deleteExpiredInstallStates',
  ],
  'jobs.ts': ['claimNextJob', 'countQueuedJobs'],
  'memberships.ts': ['listMembershipsForAccount'],
  'person-link-challenges.ts': [
    'createChallenge',
    'consumeChallenge',
    'peekChallenge',
    'deleteExpiredChallenges',
  ],
  'sign-in-tokens.ts': [
    'createSignInToken',
    'consumeSignInToken',
    'hasActiveSignInToken',
    'deleteSignInToken',
  ],
  'sessions.ts': [
    'createSession',
    'validateSession',
    'revokeSessionByHash',
    'revokeAllSessionsForAccount',
  ],
}

interface ExportedFunction {
  name: string
  firstParamName: string | undefined
  /** Index in `source` where this function's `export` keyword starts — used
   *  to find where the *next* export begins, so a function's body can be
   *  sliced out without a full parser. */
  index: number
  /** Index in `source` right after the matched signature — where the
   *  function body (or, for an arrow function, the expression after `=>`)
   *  begins. */
  bodyStart: number
}

/** The first parameter's name, or `undefined` for a no-argument function. */
function firstParamName(rawParams: string): string | undefined {
  const params = rawParams.trim()
  return params.length === 0
    ? undefined
    : (params.split(',')[0] ?? '')
        .trim()
        .split(':')[0]
        ?.trim()
        .replace(/\?$/, '')
}

/**
 * Every top-level exported function in a TS source file, in both the
 * `export function foo(...)` and `export const foo = (...) => ...` shapes —
 * a repo function can legitimately be written either way, and a check that
 * only recognised the first shape would silently skip every arrow-const
 * export while still reporting `fns.length > 0` from whatever it *did* find.
 */
function exportedFunctions(source: string): ExportedFunction[] {
  const found: ExportedFunction[] = []
  // `[^)]*` deliberately spans newlines (it excludes only `)`, not `\n`), so
  // each pattern matches a parameter list formatted across multiple lines
  // just as well as one written on a single line. The arrow-const pattern
  // also tolerates an optional return type between the parameter list and
  // `=>` (e.g. `(organizationId: string): number =>`), since that is common
  // enough in this codebase that not matching it would reopen the same gap
  // this widening is meant to close.
  const patterns = [
    /export (?:async )?function (\w+)\(([^)]*)\)/g,
    /export const (\w+) = (?:async )?\(([^)]*)\)(?:\s*:\s*[^=]+)?\s*=>/g,
  ]

  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source))) {
      // Both groups always capture when the pattern matches at all — the
      // `?? ''` fallbacks are here only to satisfy `noUncheckedIndexedAccess`.
      const name = match[1] ?? ''
      found.push({
        name,
        firstParamName: firstParamName(match[2] ?? ''),
        index: match.index,
        bodyStart: match.index + match[0].length,
      })
    }
  }

  // Both patterns are run over the same source independently; sort by
  // position so `bodyStart`/`index` pairs line up in file order regardless
  // of which pattern found which function.
  return found.sort((a, b) => a.index - b.index)
}

describe('TEN-2 — repo functions are scoped by organization id, structurally', () => {
  const files = readdirSync(REPOS_DIR).filter((name) => name.endsWith('.ts'))

  it('found the twenty-one repo files this test is written against', () => {
    // A guard on the guard: if a new repo file appears and this list is not
    // updated, the loop below silently would not check it either.
    expect(files.sort()).toEqual(
      [
        'accounts.ts',
        'conversations.ts',
        'cost-ledger.ts',
        'course-attachments.ts',
        'course-instruction-revisions.ts',
        'course-join-links.ts',
        'courses.ts',
        'discord-install-states.ts',
        'discord-servers.ts',
        'enrolments.ts',
        'jobs.ts',
        'memberships.ts',
        'organizations.ts',
        'people.ts',
        'person-link-challenges.ts',
        'projects.ts',
        'sessions.ts',
        'sign-in-tokens.ts',
        'transcript-access.ts',
        'transcript-exports.ts',
        'usage.ts',
      ].sort()
    )
  })

  for (const file of files) {
    it(`${file}: every exported function's first parameter is organizationId, except the allowlisted exceptions`, () => {
      const source = readFileSync(`${REPOS_DIR}/${file}`, 'utf8')
      const fns = exportedFunctions(source)

      // A file with no exported functions at all would make this test
      // vacuously true and hide a broken import path — assert it actually
      // found something to check.
      expect(fns.length).toBeGreaterThan(0)

      const allowedInThisFile = ALLOWLIST[file] ?? []
      for (const fn of fns) {
        if (allowedInThisFile.includes(fn.name)) continue
        expect(fn.firstParamName, `${file}#${fn.name}`).toBe('organizationId')
      }
    })
  }

  // The check above only looks at a parameter *name* in the signature, not
  // at what the function actually does with it — a function that takes
  // `organizationId` and never mentions it again would still pass. That gap
  // is exactly how `disableAccountInOrganization` slipped through: it took
  // `organizationId` as its first parameter (satisfying the check above),
  // used it only to look up a membership as a pre-check, and then issued its
  // `UPDATE` with no organization id in the `WHERE` clause at all — a global
  // write reachable from any organization. This second assertion is a
  // heuristic, not a proof (it cannot tell "used to scope a query" from
  // "used for something unrelated"), but it does fail a function that takes
  // the parameter and never uses it at all.
  for (const file of files) {
    it(`${file}: every scoped exported function's body references organizationId after its signature`, () => {
      const source = readFileSync(`${REPOS_DIR}/${file}`, 'utf8')
      const fns = exportedFunctions(source)
      const allowedInThisFile = ALLOWLIST[file] ?? []

      for (const [i, fn] of fns.entries()) {
        if (allowedInThisFile.includes(fn.name)) continue
        const nextExportStart = fns[i + 1]?.index ?? source.length
        const body = source.slice(fn.bodyStart, nextExportStart)
        expect(body, `${file}#${fn.name}`).toContain('organizationId')
      }
    })
  }

  it('the allowlist names only functions that actually exist', () => {
    for (const [file, names] of Object.entries(ALLOWLIST)) {
      const source = readFileSync(`${REPOS_DIR}/${file}`, 'utf8')
      const exported = exportedFunctions(source).map((fn) => fn.name)
      for (const name of names) {
        expect(exported).toContain(name)
      }
    }
  })
})
