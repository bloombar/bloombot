/**
 * Actions over `packages/db`'s `enrolments` repo (ENRL-1, ENRL-2, ENRL-6):
 * `enrolments.listForPerson` (ENRL-2's read), `enrolments.checkAccess`
 * (ENRL-2's refusal, byte-identical to any other not-found), and
 * `enrolments.end` (ENRL-6).
 *
 * The three admission paths themselves — a redeemed join link
 * (`course-join-links.ts`), a Discord role, and a roster row — are not
 * actions at all, or live elsewhere: see that file's own module comment,
 * and `docs/DECISIONS.md`, for why.
 */

import { enrolments, people, type courses } from '@bloombot/db'
import { z } from 'zod'

import type { Action } from '../types.js'

type Person = NonNullable<ReturnType<typeof people.getPerson>>
type Enrolment = NonNullable<ReturnType<typeof enrolments.getEnrolment>>

const listForPersonInputSchema = z.object({
  personId: z.string().min(1),
})
type ListForPersonInput = z.infer<typeof listForPersonInputSchema>

/**
 * ENRL-2: list the courses a person may ask — resolves the person itself
 * (scoped to the caller's organization, ACT-2), then their active
 * enrolments and nothing else, so a course they were never admitted to, or
 * were once enrolled in and no longer are (ENRL-6), never appears.
 */
export const listEnrolmentsForPersonAction: Action<
  'enrolments.listForPerson',
  ListForPersonInput,
  Person,
  courses.Course[]
> = {
  name: 'enrolments.listForPerson',
  description:
    'List the courses a person may currently ask (ENRL-2): their active enrolments, and no others.',
  inputSchema: listForPersonInputSchema,
  policy: {
    descriptor: { resource: 'person', access: 'read' },
    resolve: (input, context) =>
      people.getPerson(context.organizationId, input.personId, context.db),
  },
  execute: ({ organizationId, entity, db }) =>
    enrolments.listCoursesForPerson(organizationId, entity.id, db),
}

const checkAccessInputSchema = z.object({
  personId: z.string().min(1),
  courseId: z.string().min(1),
})
type CheckAccessInput = z.infer<typeof checkAccessInputSchema>

/**
 * ENRL-2: check whether a person may ask a course. The entire check *is*
 * the policy — `resolve` returns the active enrolment or `undefined`, and
 * `dispatch.ts` turns `undefined` into `ActionRefusedError`, the one
 * refusal every other unauthorized read in this package already gives
 * (ACT-3) — so a course a person is not enrolled in reads exactly like a
 * course, or a person, that does not exist. `execute` has nothing left to
 * decide.
 */
export const checkEnrolmentAccessAction: Action<
  'enrolments.checkAccess',
  CheckAccessInput,
  Enrolment,
  { courseId: string; personId: string }
> = {
  name: 'enrolments.checkAccess',
  description:
    'Check whether a person may ask a course (ENRL-2): refused exactly like any other not-found when they are not enrolled.',
  inputSchema: checkAccessInputSchema,
  policy: {
    descriptor: { resource: 'enrolment', access: 'read' },
    resolve: (input, context) =>
      enrolments.getActiveEnrolment(
        context.organizationId,
        input.courseId,
        input.personId,
        context.db
      ),
  },
  execute: ({ entity }) => ({
    courseId: entity.courseId,
    personId: entity.personId,
  }),
}

const endInputSchema = z.object({
  enrolmentId: z.string().min(1),
})
type EndInput = z.infer<typeof endInputSchema>

/**
 * ENRL-6: end an enrolment — stops the person asking; deletes neither the
 * row (`repos/enrolments.ts#endEnrolment`) nor, since this action touches
 * only `enrolments`, anything else about them.
 */
export const endEnrolmentAction: Action<
  'enrolments.end',
  EndInput,
  Enrolment,
  { ended: boolean }
> = {
  name: 'enrolments.end',
  description:
    'End an enrolment (ENRL-6): stops the person asking that course; their transcript and the course record of what was asked are untouched.',
  inputSchema: endInputSchema,
  policy: {
    descriptor: { resource: 'enrolment', access: 'write' },
    resolve: (input, context) =>
      enrolments.getEnrolment(
        context.organizationId,
        input.enrolmentId,
        context.db
      ),
  },
  execute: ({ organizationId, entity, db }) => {
    // Idempotent on an already-ended enrolment, the same "rows-changed is
    // not state" treatment `courses.enable`/`.disable` already give this
    // shape (`actions/courses.ts`'s own comments) — the policy already
    // proved this enrolment exists and belongs to this organization.
    enrolments.endEnrolment(organizationId, entity.id, db)
    return { ended: true }
  },
}
