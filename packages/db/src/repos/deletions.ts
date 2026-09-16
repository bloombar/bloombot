/**
 * Repository for deleting a course (PROJ-8) or a whole project (PROJ-9) —
 * the deliberate, destructive operation archiving (PROJ-2) and disabling
 * never are. Modelled directly on `repos/organizations.ts`'s own
 * `previewOrganizationDeletion`/`deleteOrganizationData` (ADMIN-5): a preview
 * read that counts what a person recognises, run inside the same transaction
 * the delete itself uses so the two can never disagree, and children removed
 * before the parents they reference (`foreign_keys = ON` on every
 * connection, `client.ts`'s own module comment, means SQLite actually
 * enforces this).
 *
 * Every function here is scoped by `organizationId`, its first parameter —
 * the same TEN-2 discipline every other file in this directory holds itself
 * to.
 *
 * This file does not touch `AttachmentStorage` — a course attachment's or a
 * transcript export's own bytes on disk are its caller's responsibility to
 * clean up, the same division `organizations.ts#deleteOrganizationData`'s
 * own doc comment already draws (and `apps/api/src/routes/admin.ts`'s own
 * `sweepStorage` already follows for a whole tenant): gather the ids this
 * course or project owns *before* calling `deleteCourse`/`deleteProject`
 * below (`courseAttachments.listAttachmentsForCourse`,
 * `transcriptExports.listExportsForCourse`), then remove the bytes only
 * after the delete has actually committed.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'

import type { Database, Executor } from '../client.js'
import { writeTransaction } from '../client.js'
import {
  contentDeletions,
  conversations,
  costLedgerEntries,
  courseAttachments,
  courseCategories,
  courseChannels,
  courseInstructionRevisions,
  courseJoinLinks,
  courseSelfEnrolmentIntents,
  courseWebSources,
  courses,
  enrolments,
  messages,
  projects,
  rosterChannelAssignments,
  transcriptAccessLog,
  transcriptExports,
  usageCounters,
} from '../schema.js'

export type ContentDeletion = typeof contentDeletions.$inferSelect

/**
 * PROJ-8's own "names exactly what will be deleted before it happens" for a
 * single course — the categories a person recognises, the same
 * "deliberately not exhaustive" reasoning `OrganizationDeletionPreview`'s own
 * doc comment gives (`repos/organizations.ts`): `usage_counters`,
 * `course_join_links`, `course_self_enrolment_intents`, `course_web_sources`,
 * `course_instruction_revisions`, `transcript_access_log` and
 * `roster_channel_assignments` are all emptied by `deleteCourse` below with
 * no count here — this is a confirmation an instructor reads and acts on,
 * not a schema dump. `undefined` when `courseId` does not exist, or does not
 * belong to `organizationId` (TEN-2/TEN-5) — there is nothing to preview
 * deleting.
 *
 * `db` accepts `Executor`, not just `Database`: `deleteCourse` below calls
 * this from inside its own transaction, counting exactly what it is about to
 * delete before any of it is gone; `previewProjectDeletion` below calls it
 * the same way, once per course, to total PROJ-9's own project-wide preview.
 */
export interface CourseDeletionPreview {
  organizationId: string
  courseId: string
  courseTitle: string
  conversations: number
  messages: number
  enrolments: number
  courseAttachments: number
}

export function previewCourseDeletion(
  organizationId: string,
  courseId: string,
  db: Executor
): CourseDeletionPreview | undefined {
  const course = db
    .select({ id: courses.id, title: courses.title })
    .from(courses)
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .get()
  if (!course) return undefined

  const count = (row: { count: number } | undefined): number => row?.count ?? 0

  return {
    organizationId,
    courseId: course.id,
    courseTitle: course.title,
    conversations: count(
      db
        .select({ count: sql<number>`count(*)` })
        .from(conversations)
        .where(
          and(
            eq(conversations.organizationId, organizationId),
            eq(conversations.courseId, courseId)
          )
        )
        .get()
    ),
    messages: count(
      db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .where(
          and(
            eq(messages.organizationId, organizationId),
            eq(messages.courseId, courseId)
          )
        )
        .get()
    ),
    enrolments: count(
      db
        .select({ count: sql<number>`count(*)` })
        .from(enrolments)
        .where(
          and(
            eq(enrolments.organizationId, organizationId),
            eq(enrolments.courseId, courseId)
          )
        )
        .get()
    ),
    courseAttachments: count(
      db
        .select({ count: sql<number>`count(*)` })
        .from(courseAttachments)
        .where(
          and(
            eq(courseAttachments.organizationId, organizationId),
            eq(courseAttachments.courseId, courseId)
          )
        )
        .get()
    ),
  }
}

/**
 * Every organization-scoped table that references `courses.id` (directly, or
 * — `course_channels`, through `course_categories` — one level down),
 * emptied for `courseId` alone, in FK-safe order: children before the
 * parents they reference. Returns exactly what `previewCourseDeletion`
 * above reports, counted inside this same transaction immediately before
 * anything is touched.
 *
 * PROJ-8's own carve-out: `cost_ledger_entries` is never deleted here —
 * spending already incurred survives the course it was charged to, so this
 * only nulls its `courseId` (`schema.ts`'s own comment on why that column is
 * nullable), which is exactly what keeps `costLedger.getOrganizationSpentMicros`'s
 * sum, and therefore COST-3's cap, unchanged by a course's deletion.
 *
 * Shared by `deleteProject` below, which calls this once per course before
 * removing the project itself — the reason this file exists as `deletions.ts`
 * rather than living entirely in `repos/courses.ts`: a project delete needs
 * the exact same course-emptying logic, not a parallel copy of it.
 */
function emptyCourse(
  organizationId: string,
  courseId: string,
  tx: Executor
): CourseDeletionPreview | undefined {
  const preview = previewCourseDeletion(organizationId, courseId, tx)
  if (!preview) return undefined

  // Messages before conversations — `messages.conversationId` references
  // `conversations.id`.
  tx.delete(messages)
    .where(
      and(
        eq(messages.organizationId, organizationId),
        eq(messages.courseId, courseId)
      )
    )
    .run()
  tx.delete(conversations)
    .where(
      and(
        eq(conversations.organizationId, organizationId),
        eq(conversations.courseId, courseId)
      )
    )
    .run()
  tx.delete(transcriptAccessLog)
    .where(
      and(
        eq(transcriptAccessLog.organizationId, organizationId),
        eq(transcriptAccessLog.courseId, courseId)
      )
    )
    .run()
  tx.delete(transcriptExports)
    .where(
      and(
        eq(transcriptExports.organizationId, organizationId),
        eq(transcriptExports.courseId, courseId)
      )
    )
    .run()
  tx.delete(usageCounters)
    .where(
      and(
        eq(usageCounters.organizationId, organizationId),
        eq(usageCounters.courseId, courseId)
      )
    )
    .run()
  // PROJ-8 — survives, `courseId` nulled rather than deleted (this
  // function's own doc comment).
  tx.update(costLedgerEntries)
    .set({ courseId: null })
    .where(
      and(
        eq(costLedgerEntries.organizationId, organizationId),
        eq(costLedgerEntries.courseId, courseId)
      )
    )
    .run()
  tx.delete(courseAttachments)
    .where(
      and(
        eq(courseAttachments.organizationId, organizationId),
        eq(courseAttachments.courseId, courseId)
      )
    )
    .run()
  tx.delete(courseInstructionRevisions)
    .where(
      and(
        eq(courseInstructionRevisions.organizationId, organizationId),
        eq(courseInstructionRevisions.courseId, courseId)
      )
    )
    .run()
  tx.delete(courseJoinLinks)
    .where(
      and(
        eq(courseJoinLinks.organizationId, organizationId),
        eq(courseJoinLinks.courseId, courseId)
      )
    )
    .run()
  tx.delete(courseSelfEnrolmentIntents)
    .where(
      and(
        eq(courseSelfEnrolmentIntents.organizationId, organizationId),
        eq(courseSelfEnrolmentIntents.courseId, courseId)
      )
    )
    .run()
  tx.delete(enrolments)
    .where(
      and(
        eq(enrolments.organizationId, organizationId),
        eq(enrolments.courseId, courseId)
      )
    )
    .run()
  tx.delete(courseWebSources)
    .where(
      and(
        eq(courseWebSources.organizationId, organizationId),
        eq(courseWebSources.courseId, courseId)
      )
    )
    .run()
  tx.delete(rosterChannelAssignments)
    .where(
      and(
        eq(rosterChannelAssignments.organizationId, organizationId),
        eq(rosterChannelAssignments.courseId, courseId)
      )
    )
    .run()

  // `course_channels` has no `courseId` of its own — it belongs to a
  // `course_categories` row, which belongs to the course — so its own ids
  // are read first, before either table is touched.
  const categoryIds = tx
    .select({ id: courseCategories.id })
    .from(courseCategories)
    .where(
      and(
        eq(courseCategories.organizationId, organizationId),
        eq(courseCategories.courseId, courseId)
      )
    )
    .all()
    .map((row) => row.id)
  if (categoryIds.length > 0) {
    tx.delete(courseChannels)
      .where(
        and(
          eq(courseChannels.organizationId, organizationId),
          inArray(courseChannels.categoryId, categoryIds)
        )
      )
      .run()
  }
  tx.delete(courseCategories)
    .where(
      and(
        eq(courseCategories.organizationId, organizationId),
        eq(courseCategories.courseId, courseId)
      )
    )
    .run()

  tx.delete(courses)
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .run()

  return preview
}

/** What a caller supplies to record a course or project deletion — the same division `organizations.ts#NewTenantDeletion`'s own doc comment draws between what a repo function is handed and what it invents. */
export interface DeletionAuditFields {
  deletedByAccountId: string
}

/**
 * Record one course or project deletion (PROJ-8/PROJ-9's own audit trail) —
 * who deleted it, when, and what was actually removed, the same shape
 * `organizations.ts#recordTenantDeletion` already gives ADMIN-5's own
 * tenant-wide delete. Unlike that function, this is called from *inside*
 * the same transaction the delete itself runs in (this file's own module
 * comment): a course or a project, unlike an organization, still exists
 * once this row is read, so there is no reason to split the two into
 * separate transactions the way `apps/api/src/routes/admin.ts` has to for a
 * tenant delete that removes the very row `organizationId` would otherwise
 * reference.
 */
function recordContentDeletion(
  organizationId: string,
  kind: 'course' | 'project',
  subjectId: string,
  subjectName: string,
  audit: DeletionAuditFields,
  summary: unknown,
  tx: Executor
): ContentDeletion {
  return tx
    .insert(contentDeletions)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      kind,
      subjectId,
      subjectName,
      deletedByAccountId: audit.deletedByAccountId,
      summary: JSON.stringify(summary),
      deletedAt: Date.now(),
    })
    .returning()
    .get()
}

/**
 * PROJ-8: permanently delete a course and everything that exists only
 * because of it, in one transaction (`emptyCourse` above does the actual
 * work; see its own doc comment for the full table-by-table ordering), and
 * record the deletion (`recordContentDeletion` above) before the
 * transaction commits.
 *
 * `undefined` when `courseId` does not exist, or does not belong to
 * `organizationId` (TEN-2/TEN-5) — nothing is deleted, and nothing is
 * recorded.
 */
export function deleteCourse(
  organizationId: string,
  courseId: string,
  audit: DeletionAuditFields,
  db: Database
): CourseDeletionPreview | undefined {
  return writeTransaction(db, (tx) => {
    const preview = emptyCourse(organizationId, courseId, tx)
    if (!preview) return undefined

    recordContentDeletion(
      organizationId,
      'course',
      preview.courseId,
      preview.courseTitle,
      audit,
      preview,
      tx
    )

    return preview
  })
}

/**
 * PROJ-9's own preview: PROJ-8's own counts, totalled across every course in
 * the project, plus how many courses will go. `undefined` when `projectId`
 * does not exist, or does not belong to `organizationId` (TEN-2/TEN-5).
 *
 * `db` accepts `Executor`, not just `Database`: `deleteProject` below calls
 * this from inside its own transaction, the same reason
 * `previewCourseDeletion` does.
 */
export interface ProjectDeletionPreview {
  organizationId: string
  projectId: string
  projectName: string
  courses: number
  conversations: number
  messages: number
  enrolments: number
  courseAttachments: number
}

export function previewProjectDeletion(
  organizationId: string,
  projectId: string,
  db: Executor
): ProjectDeletionPreview | undefined {
  const project = db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId)
      )
    )
    .get()
  if (!project) return undefined

  const courseRows = db
    .select({ id: courses.id })
    .from(courses)
    .where(
      and(
        eq(courses.organizationId, organizationId),
        eq(courses.projectId, projectId)
      )
    )
    .all()

  const coursePreviews = courseRows
    .map((row) => previewCourseDeletion(organizationId, row.id, db))
    .filter((coursePreview): coursePreview is CourseDeletionPreview =>
      Boolean(coursePreview)
    )

  return {
    organizationId,
    projectId: project.id,
    projectName: project.name,
    courses: coursePreviews.length,
    conversations: coursePreviews.reduce(
      (total, coursePreview) => total + coursePreview.conversations,
      0
    ),
    messages: coursePreviews.reduce(
      (total, coursePreview) => total + coursePreview.messages,
      0
    ),
    enrolments: coursePreviews.reduce(
      (total, coursePreview) => total + coursePreview.enrolments,
      0
    ),
    courseAttachments: coursePreviews.reduce(
      (total, coursePreview) => total + coursePreview.courseAttachments,
      0
    ),
  }
}

/**
 * PROJ-9: permanently delete a project — every course in it exactly as
 * `deleteCourse`/`emptyCourse` above describes, then the project itself —
 * in one transaction, recording the deletion before it commits (the same
 * "recorded inside the same transaction" reasoning `deleteCourse`'s own doc
 * comment gives). An archived project is deleted exactly as readily as a
 * live one — nothing here reads `archivedAt`.
 *
 * `undefined` when `projectId` does not exist, or does not belong to
 * `organizationId` (TEN-2/TEN-5) — nothing is deleted, and nothing is
 * recorded.
 */
export function deleteProject(
  organizationId: string,
  projectId: string,
  audit: DeletionAuditFields,
  db: Database
): ProjectDeletionPreview | undefined {
  return writeTransaction(db, (tx) => {
    const project = tx
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId)
        )
      )
      .get()
    if (!project) return undefined

    const courseRows = tx
      .select({ id: courses.id })
      .from(courses)
      .where(
        and(
          eq(courses.organizationId, organizationId),
          eq(courses.projectId, projectId)
        )
      )
      .all()

    const coursePreviews = courseRows.map((row) => {
      const coursePreview = emptyCourse(organizationId, row.id, tx)
      // Unreachable: `courseRows` was just read inside this same
      // transaction, so every id it names still belongs to this
      // organization. Guarded rather than asserted, the same discipline
      // every other repo function in this package holds itself to.
      if (!coursePreview) {
        throw new Error(
          `deleteProject: course "${row.id}" disappeared mid-transaction`
        )
      }
      return coursePreview
    })

    tx.delete(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId)
        )
      )
      .run()

    const summary: ProjectDeletionPreview = {
      organizationId,
      projectId: project.id,
      projectName: project.name,
      courses: coursePreviews.length,
      conversations: coursePreviews.reduce(
        (total, coursePreview) => total + coursePreview.conversations,
        0
      ),
      messages: coursePreviews.reduce(
        (total, coursePreview) => total + coursePreview.messages,
        0
      ),
      enrolments: coursePreviews.reduce(
        (total, coursePreview) => total + coursePreview.enrolments,
        0
      ),
      courseAttachments: coursePreviews.reduce(
        (total, coursePreview) => total + coursePreview.courseAttachments,
        0
      ),
    }

    recordContentDeletion(
      organizationId,
      'project',
      summary.projectId,
      summary.projectName,
      audit,
      summary,
      tx
    )

    return summary
  })
}
