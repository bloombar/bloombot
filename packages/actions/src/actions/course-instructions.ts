/**
 * Actions over `packages/db`'s `courses`/`course-instruction-revisions`
 * repos (FILE-4, D-3): `courseInstructions.save`, `.list` and `.restore`.
 *
 * Every action here needs the caller's own account id — a revision without
 * a real author is exactly what FILE-4 exists to prevent — so `.save` and
 * `.restore` both read `context.accountId`
 * (`dispatch.ts`'s own `DispatchContext.accountId` doc comment) and refuse
 * outright when it is missing, rather than accepting one out of the
 * action's own input (a self-reported author is a forgeable audit trail,
 * the same reasoning `routes/actions.ts`'s own module comment gives for
 * never trusting a caller-supplied `organizationId`).
 */

import { courseInstructionRevisions, courses } from '@bloombot/db'
import { z } from 'zod'

import { ActionRefusedError } from '../errors.js'
import type { Action } from '../types.js'

// The policy resolves a course *with* its categories and channels
// (`courses.getCourse`'s own shape) — but `setCourseInstructions` writes
// and returns only the bare row (`courses.Course`, no `categories` field),
// the same "does not touch the rest of the course" scope its own doc
// comment describes. Two distinct types, deliberately: `Course` is what a
// policy resolves an id into; `CourseRow` is what a save or restore
// actually hands back.
type Course = NonNullable<ReturnType<typeof courses.getCourse>>
type CourseRow = courses.Course
type Revision = NonNullable<
  ReturnType<typeof courseInstructionRevisions.getRevision>
>

/** Both `.save` and `.restore` refuse the same way when `dispatch` was not given an authenticated caller — see this file's own module comment. */
function requireAccountId(accountId: string | undefined): string {
  if (!accountId) throw new ActionRefusedError()
  return accountId
}

const saveInputSchema = z.object({
  courseId: z.string().min(1),
  instructions: z.string().min(1),
})
type SaveInput = z.infer<typeof saveInputSchema>

/**
 * FILE-4: save a course's instructions. Writes `courses.instructions`
 * (`repos/courses.ts#setCourseInstructions` — only that one column, unlike
 * `courses.save`'s own full replace) and records a new
 * `course_instruction_revisions` row inside the same `db.transaction(...)`,
 * so a save is never only half-durable: either both happen, or (a foreign
 * `courseId`, ACT-3, or `createRevision`'s own foreign-key check on
 * `savedByAccountId`) neither does — the instructions write rolls back with
 * it. Two untransacted writes under this same claim was the bug (a rework
 * finding): a failing `createRevision` used to leave the live instructions
 * changed with no revision recording it, which is exactly what FILE-4
 * exists to prevent.
 */
export const saveCourseInstructionsAction: Action<
  'courseInstructions.save',
  SaveInput,
  Course,
  CourseRow
> = {
  name: 'courseInstructions.save',
  description:
    "Save a course's instructions (FILE-4): updates the live text and records a new, authored revision of it.",
  inputSchema: saveInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'write' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, input, entity, accountId, db }) => {
    const savedByAccountId = requireAccountId(accountId)

    // One `db.transaction(...)`, not two separate calls — see this action's
    // own doc comment above for why: `setCourseInstructions` and
    // `createRevision` both now accept an `Executor`/`TransactingExecutor`
    // (`repos/courses.ts`, `repos/course-instruction-revisions.ts`) so they
    // can run against the same `tx` and commit or roll back together.
    return db.transaction((tx) => {
      const updated = courses.setCourseInstructions(
        organizationId,
        entity.id,
        input.instructions,
        tx
      )
      // Unreachable in practice — the policy just proved this course
      // existed and belonged to this organization moments earlier — but
      // guarded rather than assumed, the same race `unarchiveProjectAction`'s
      // own comment (`actions/projects.ts`) documents for the same shape.
      if (!updated) throw new ActionRefusedError()

      courseInstructionRevisions.createRevision(
        organizationId,
        {
          courseId: entity.id,
          instructions: input.instructions,
          savedByAccountId,
        },
        tx
      )

      return updated
    })
  },
}

const listInputSchema = z.object({
  courseId: z.string().min(1),
})
type ListInput = z.infer<typeof listInputSchema>

/** FILE-4: list a course's instruction revisions, newest first — what lets an instructor see what the assistant was told last week. */
export const listCourseInstructionRevisionsAction: Action<
  'courseInstructions.list',
  ListInput,
  Course,
  courseInstructionRevisions.CourseInstructionRevision[]
> = {
  name: 'courseInstructions.list',
  description:
    "List a course's instruction revisions (FILE-4), newest first, each with its own author and time.",
  inputSchema: listInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'read' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, entity, db }) =>
    courseInstructionRevisions.listRevisionsForCourse(
      organizationId,
      entity.id,
      db
    ),
}

const restoreInputSchema = z.object({
  revisionId: z.string().min(1),
})
type RestoreInput = z.infer<typeof restoreInputSchema>

/** What `courseInstructions.restore`'s policy resolves: the revision being restored, and the course it belongs to — both scoped to the caller's organization (ACT-2). */
interface RestoreEntity {
  revision: Revision
  course: Course
}

/**
 * FILE-4: restore an earlier revision. Makes it current
 * (`setCourseInstructions`) and adds a *new* revision recording the restore
 * — both inside the same `db.transaction(...)` `saveCourseInstructionsAction`
 * above uses, for the same reason (that action's own doc comment) — it
 * never deletes or rewrites the revision being restored from, or any
 * revision saved after it (`repos/course-instruction-revisions.ts`'s own
 * module comment: "never updated or deleted"). A restore's own new revision
 * is authored by whoever performed the restore, not by the original
 * author — an honest record of who actually chose to bring this text back.
 */
export const restoreCourseInstructionRevisionAction: Action<
  'courseInstructions.restore',
  RestoreInput,
  RestoreEntity,
  CourseRow
> = {
  name: 'courseInstructions.restore',
  description:
    "Restore an earlier instruction revision (FILE-4): makes it the course's current instructions and records the restore as a new revision — the revision restored from is never deleted or rewritten.",
  inputSchema: restoreInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'write' },
    resolve: (input, context) => {
      const revision = courseInstructionRevisions.getRevision(
        context.organizationId,
        input.revisionId,
        context.db
      )
      if (!revision) return undefined
      const course = courses.getCourse(
        context.organizationId,
        revision.courseId,
        context.db
      )
      if (!course) return undefined
      return { revision, course }
    },
  },
  execute: ({ organizationId, entity, accountId, db }) => {
    const restoredByAccountId = requireAccountId(accountId)

    // One `db.transaction(...)` — see `saveCourseInstructionsAction`'s own
    // doc comment above for why.
    return db.transaction((tx) => {
      const updated = courses.setCourseInstructions(
        organizationId,
        entity.course.id,
        entity.revision.instructions,
        tx
      )
      if (!updated) throw new ActionRefusedError()

      courseInstructionRevisions.createRevision(
        organizationId,
        {
          courseId: entity.course.id,
          instructions: entity.revision.instructions,
          savedByAccountId: restoredByAccountId,
        },
        tx
      )

      return updated
    })
  },
}
