/**
 * Actions over `packages/db`'s `course-invitations` repo (ROST-21, WEB-82):
 * `courseInvitations.list` and `courseInvitations.revoke`, modelled on
 * `course-join-links.ts`'s `.list`/`.revoke` — same policy shape, same
 * organization scoping (ACT-2, TEN-2).
 *
 * There is no create action: invitations are made only by a roster import of
 * a course without Discord (`roster.import`), and accepted only by an account
 * that proved the address, at sign-in or at import — never on request.
 */

import { courseInvitations, courses } from '@bloombot/db'
import { z } from 'zod'

import { ActionRefusedError } from '../errors.js'
import type { Action } from '../types.js'

type Course = NonNullable<ReturnType<typeof courses.getCourse>>
type Invitation = courseInvitations.CourseInvitation

/** What the People panel needs of an open invitation; no internal columns. */
export interface CourseInvitationSummary {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  createdAt: number
}

const listInputSchema = z.object({ courseId: z.string().min(1) })
type ListInput = z.infer<typeof listInputSchema>

/** WEB-82: a course's invitations not yet accepted or removed — the "invited, not signed in yet" part of its people. */
export const listCourseInvitationsAction: Action<
  'courseInvitations.list',
  ListInput,
  Course,
  CourseInvitationSummary[]
> = {
  name: 'courseInvitations.list',
  description:
    "List a course's open invitations (WEB-82): students a roster invited by email who have not signed in yet, with the name and address the roster gave.",
  inputSchema: listInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'read' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, entity, db }) =>
    courseInvitations
      .listOpenInvitationsForCourse(organizationId, entity.id, db)
      .map((invitation) => ({
        id: invitation.id,
        email: invitation.email,
        firstName: invitation.firstName,
        lastName: invitation.lastName,
        createdAt: invitation.createdAt,
      })),
}

const revokeInputSchema = z.object({ invitationId: z.string().min(1) })
type RevokeInput = z.infer<typeof revokeInputSchema>

/**
 * WEB-82: remove an invitation not yet accepted — the way to correct a
 * mistyped address before somebody else accepts it. Resolves only an open
 * invitation of this organization, so an accepted, already-removed or
 * foreign one reads as not found (TEN-5, ACT-3). Records who removed it, so
 * a call with no authenticated account is refused.
 */
export const revokeCourseInvitationAction: Action<
  'courseInvitations.revoke',
  RevokeInput,
  Invitation,
  { revoked: boolean }
> = {
  name: 'courseInvitations.revoke',
  description:
    'Remove an open course invitation (WEB-82): the student can no longer accept it by signing in. Does nothing to an invitation already accepted.',
  inputSchema: revokeInputSchema,
  policy: {
    descriptor: { resource: 'courseInvitation', access: 'write' },
    resolve: (input, context) =>
      courseInvitations.getOpenInvitation(
        context.organizationId,
        input.invitationId,
        context.db
      ),
  },
  execute: ({ organizationId, entity, accountId, db }) => {
    if (!accountId) throw new ActionRefusedError()
    // The policy read the invitation moments ago; if it was accepted or
    // removed since, nothing changed and the caller is told "not found",
    // never a false success.
    const revoked = courseInvitations.revokeInvitation(
      organizationId,
      entity.id,
      accountId,
      db
    )
    if (!revoked) throw new ActionRefusedError()
    return { revoked: true }
  },
}
