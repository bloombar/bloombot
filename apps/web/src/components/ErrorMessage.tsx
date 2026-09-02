/**
 * Turns an `ApiError` (`api/client.ts`) into words a person reads (WEB-5).
 *
 * The mapping is deliberately thin: `middleware/errors.ts` in `apps/api`
 * already decided what a caller may know about a failure — a refusal never
 * says what it protected, a validation failure names the field, a conflict
 * names what it collided with, and an unexpected failure discloses nothing.
 * `describeApiError` reads that same `error` code and says it in a sentence;
 * it never adds a reason the API did not give.
 */

import type { ApiError } from '../api/client.js'
import { ErrorIcon } from '../icons.js'

/** Every field-level message for a validation failure, one per line — `path` joined with `.`, the same way `packages/config`'s own env-validation report does. */
function issueLines(error: ApiError): string[] {
  const issues = error.body.issues ?? []
  return issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join('.') : '(this field)'
    return `${field}: ${issue.message}`
  })
}

/**
 * A single sentence describing `error`, and the field-level detail
 * (WEB-5's "a validation failure names the field that was wrong") when the
 * API sent any. Never renders `error.message`, a stack, or any other raw
 * detail the API did not put in `error.body`.
 */
export function describeApiError(error: ApiError): {
  headline: string
  details: string[]
} {
  switch (error.body.error) {
    case 'action_input_invalid':
    case 'invalid_request':
      return {
        headline: 'That did not look right.',
        details: issueLines(error),
      }
    case 'action_conflict': {
      // ActionConflictError is the one refusal ACT-4 allows to name what it
      // collided with (docs/DECISIONS.md D-18) — `conflict.message` is
      // written to be read by the caller, unlike a not-found's own detail.
      const conflict = error.body.conflict as { message?: string } | undefined
      return {
        headline: conflict?.message ?? 'That could not be saved.',
        details: [],
      }
    }
    case 'action_refused':
    case 'action_unknown':
      // WEB-5: "a refusal reads as not found" — action_refused and
      // action_unknown are both 404s from apps/api (`errors.ts`'s own
      // table) and, by design (TEN-5), indistinguishable from each other:
      // apps/api never says whether a record is missing or merely not this
      // caller's, so this app cannot say more either.
      return {
        headline: 'Not found, or you do not have access to it.',
        details: [],
      }
    case 'not_signed_in':
      return { headline: 'You need to sign in first.', details: [] }
    // ADMIN-4: distinct from `action_refused` — this is the admin console's
    // own "you are not on the platform-administrator allowlist", never
    // confused with "this record does not exist" (TEN-5's own shape,
    // above), since AUTH-4's check is not organization-scoped at all.
    case 'not_platform_administrator':
      return {
        headline: 'This requires platform-administrator access.',
        details: [],
      }
    // ADMIN-5: the name typed to confirm a tenant deletion did not match —
    // named plainly so an administrator can just try again, not folded
    // into the generic `default` case below.
    case 'confirmation_name_mismatch':
      return {
        headline: 'That name did not match — nothing was deleted.',
        details: [],
      }
    case 'organization_not_found':
      return { headline: 'That organization no longer exists.', details: [] }
    case 'invalid_token':
      return {
        headline: 'That link is no longer valid. Request a new one.',
        details: [],
      }
    case 'origin_refused':
      return { headline: 'That request was refused.', details: [] }
    case 'network_error':
      // `api/client.ts`'s own code for a `fetch` that never got a response
      // at all — this app's own diagnosis of a proxy or network failure,
      // not something apps/api said, so a distinct message (rather than the
      // `default` case's generic one) is honest here in the same way
      // `describeApiError`'s other cases are (WEB-5).
      return {
        headline:
          'Could not reach Bloombot. Check your connection and try again.',
        details: [],
      }
    default:
      // internal_error, unreadable_response, or any other code this app
      // does not recognize yet — no stack trace, no internal message, no
      // identifier the caller has no use for.
      return { headline: 'Something went wrong. Try again.', details: [] }
  }
}

export function ErrorMessage({ error }: { error: ApiError }) {
  const { headline, details } = describeApiError(error)
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-md border border-danger-600 bg-danger-50 px-3 py-2 text-sm text-danger-700"
    >
      <ErrorIcon aria-hidden="true" className="size-5 shrink-0" />
      <div>
        <p>{headline}</p>
        {details.length > 0 && (
          <ul className="mt-1 list-disc pl-4">
            {details.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
