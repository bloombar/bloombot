/**
 * Actions over `packages/db`'s `enrolments` repo (ENRL-1, ENRL-2, ENRL-6,
 * ENRL-9, WEB-22): `enrolments.listForPerson` (ENRL-2's read),
 * `enrolments.checkAccess` (ENRL-2's refusal, byte-identical to any other
 * not-found), `enrolments.end` (ENRL-6), `enrolments.listForCourse` (WEB-22's
 * own listing, active and ended alike), and `enrolments.reinstate` (ENRL-9).
 *
 * The three admission paths themselves — a redeemed join link
 * (`course-join-links.ts`), a Discord role, and a roster row — are not
 * actions at all, or live elsewhere: see that file's own module comment,
 * and `docs/DECISIONS.md`, for why.
 */

import { courses, enrolments, people } from '@bloombot/db'
import { z } from 'zod'

import { ActionRefusedError } from '../errors.js'
import type { Action } from '../types.js'

type Person = NonNullable<ReturnType<typeof people.getPerson>>
type Enrolment = NonNullable<ReturnType<typeof enrolments.getEnrolment>>
type Course = NonNullable<ReturnType<typeof courses.getCourse>>

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

const reinstateInputSchema = z.object({
  enrolmentId: z.string().min(1),
})
type ReinstateInput = z.infer<typeof reinstateInputSchema>

/**
 * ENRL-9: reinstate an enrolment an instructor previously ended (ENRL-6) —
 * the one door the ENRL-6/ENRL-8 rework's `reviveEnded: false` closed on
 * every admission path, deliberately (`repos/enrolments.ts`'s own module
 * comment), and the one this action deliberately reopens, but only for an
 * instructor, never for the person it reinstates.
 *
 * **Why an authenticated `accountId`, not merely a resolved enrolment, is
 * required.** ENRL-9's own text is explicit that reinstating "is
 * deliberately not something the reinstated person can trigger" — the
 * distinction the whole ENRL-8 rework turns on. This action's policy alone
 * cannot enforce that: `PolicyContext` carries only `organizationId` and
 * `db`, never who is calling (`policy.ts`'s own module comment, the same
 * reason `memberships.grant` checks the caller in `execute` instead). What
 * actually keeps the reinstated person out is one level up, structural
 * rather than a check this action makes itself: `apps/api`'s
 * `routes/actions.ts` resolves the caller's organization from their own
 * *membership* before `dispatch` ever runs, and an enrolled person (a
 * student, admitted through `enrolments`) holds no membership at all — they
 * have nothing to sign in to this route *as*, so they cannot reach any
 * action here, this one included, regardless of what its own policy would
 * otherwise allow. This action's own `execute` still refuses outright when
 * `dispatch` was given no `accountId` (the same `requireAccountId`
 * discipline `course-instructions.ts`'s own actions hold themselves to) —
 * belt-and-suspenders, not the actual guarantee: ENRL-9's guarantee is that
 * structural gap, not a check this file could get wrong.
 *
 * Idempotent on an enrolment that is not currently ended, the same
 * "rows-changed is not state" treatment `enrolments.end` above already
 * gives — reinstating a person who is not ended changes nothing.
 */
export const reinstateEnrolmentAction: Action<
  'enrolments.reinstate',
  ReinstateInput,
  Enrolment,
  { reinstated: boolean }
> = {
  name: 'enrolments.reinstate',
  description:
    'Reinstate an enrolment an instructor previously ended (ENRL-9): restores the access `enrolments.end` removed, and records who reinstated it and when. A no-op on an enrolment that is not currently ended.',
  inputSchema: reinstateInputSchema,
  policy: {
    descriptor: { resource: 'enrolment', access: 'write' },
    resolve: (input, context) =>
      enrolments.getEnrolment(
        context.organizationId,
        input.enrolmentId,
        context.db
      ),
  },
  execute: ({ organizationId, entity, accountId, db }) => {
    if (!accountId) throw new ActionRefusedError()
    // The policy already proved this enrolment exists and belongs to this
    // organization; `reinstateEnrolment` itself is the idempotent no-op on
    // one that is not currently ended.
    enrolments.reinstateEnrolment(
      organizationId,
      entity.id,
      { reinstatedByAccountId: accountId },
      db
    )
    return { reinstated: true }
  },
}

const listForCourseInputSchema = z.object({
  courseId: z.string().min(1),
})
type ListForCourseInput = z.infer<typeof listForCourseInputSchema>

/**
 * WEB-22: every enrolment a course has ever had — active and ended alike,
 * each with how it was admitted — for the panel's own people screen.
 * Resolves the course itself (ACT-2), the same "the course it names is what
 * a read grant already protects" shape `courseAttachments.list`/
 * `courseJoinLinks.list` already use.
 */
export const listEnrolmentsForCourseAction: Action<
  'enrolments.listForCourse',
  ListForCourseInput,
  Course,
  enrolments.CourseEnrolmentEntry[]
> = {
  name: 'enrolments.listForCourse',
  description:
    "List every enrolment a course has ever had (WEB-22): active and ended alike, each with how it was admitted — not `enrolments.listForPerson`'s active-only, person-scoped list.",
  inputSchema: listForCourseInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'read' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, entity, db }) =>
    enrolments.listEnrolmentsForCourse(organizationId, entity.id, db),
}
