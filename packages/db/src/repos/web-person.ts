/**
 * Finding or creating the person an account's web identity belongs to in one
 * organization (ENRL-8, ROST-21).
 *
 * Two callers need exactly this: redeeming a join link
 * (`course-join-links.ts#redeemJoinLinkForWebAccount`) and accepting a roster
 * invitation (`course-invitations.ts#claimInvitationsForAccount`). Keeping it
 * in one place means the two cannot drift on the rule that matters most: a
 * student an instructor removed is not quietly given a second person.
 */

import type { TransactingExecutor } from '../client.js'
import { getAccountById } from './accounts.js'
import { hasEndedEnrolment } from './enrolments.js'
import {
  connectIdentity,
  createPerson,
  fillPersonNamesFromAccount,
  findPeopleByEmail,
  resolveIdentity,
  type Person,
} from './people.js'

/**
 * The account's connected web person in `organizationId`, creating and
 * connecting one when it has none yet.
 *
 * `undefined` means refused: the account has no person here yet, but its
 * verified address names a person already enrolled-then-ended in
 * `courseId` (ENRL-6). Making a second person would walk around that
 * removal. This is a refusal, not a merge: nothing is combined (PPL-4).
 * A person the account already holds is returned as-is; their own ended
 * enrolment is the enrolment layer's business.
 */
export function findOrCreateWebPersonForAccount(
  organizationId: string,
  courseId: string,
  accountId: string,
  db: TransactingExecutor
): Person | undefined {
  const identity = { surface: 'web' as const, externalId: accountId }
  const existing = resolveIdentity(organizationId, identity, db)
  if (existing) return existing

  const account = getAccountById(accountId, db)
  if (account) {
    const matches = findPeopleByEmail(organizationId, account.email, db)
    const wasRemoved = matches.some((match) =>
      hasEndedEnrolment(organizationId, courseId, match.id, db)
    )
    if (wasRemoved) return undefined
  }

  const created = createPerson(organizationId, {}, db)
  // `connectIdentity` refuses only for a foreign or merged-away person, or an
  // identity another person already holds. None can be true here: the person
  // was just minted in this transaction and `resolveIdentity` just found
  // nobody holding this identity.
  const connected = connectIdentity(organizationId, created.id, identity, db)
  if (!connected) {
    throw new Error(
      `findOrCreateWebPersonForAccount: connectIdentity refused for a person (${created.id}) and organization (${organizationId}) this function just created — should be unreachable`
    )
  }
  // AUTH-7: carry over whatever names an earlier Google sign-in recorded.
  fillPersonNamesFromAccount(organizationId, created.id, accountId, db)
  return created
}
