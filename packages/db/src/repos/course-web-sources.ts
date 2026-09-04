/**
 * Repository for `course_web_sources` (FILE-6, MDL-9).
 *
 * Every function here is scoped by `organizationId`, its first parameter —
 * the same TEN-2 discipline every other repo in this package holds itself
 * to (`course-attachments.ts`'s own module comment) — and `undefined`
 * identically for a domain that does not exist and one that belongs to
 * another organization (TEN-5). `domain` is trusted to already be the
 * normalized, bare form `@bloombot/schemas#normalizeWebSourceDomain`
 * produces (WEB-31); this file stores and compares it exactly as given, the
 * same "opaque to this layer" treatment `course-join-links.ts` gives a
 * secret's own hash.
 */

import { and, eq } from 'drizzle-orm'

import type { Executor } from '../client.js'
import { courseWebSources } from '../schema.js'

export type CourseWebSource = typeof courseWebSources.$inferSelect

/** Fields the caller supplies when naming a new website on a course. */
export interface NewCourseWebSource {
  /** Defaults to `crypto.randomUUID()` when omitted. */
  id?: string
  courseId: string
  /** Already normalized (WEB-31) — this file never reduces it itself. */
  domain: string
}

/**
 * Add a website to a course. `course_web_sources_course_domain_unique`
 * (`schema.ts`) is what actually refuses a domain a course has already
 * named — this function does not check first and then insert (the same
 * "let the database refuse it, never trust an application check"
 * discipline `projects.createProject` already holds itself to, D-12): it
 * throws `SQLITE_CONSTRAINT_UNIQUE` verbatim on a collision, which
 * `@bloombot/actions`' `course-web-sources.ts` — the layer D-12 leaves
 * exactly this for — converts into a named `ActionConflictError` rather
 * than an opaque 500.
 */
export function addWebSource(
  organizationId: string,
  input: NewCourseWebSource,
  db: Executor
): CourseWebSource {
  return db
    .insert(courseWebSources)
    .values({
      id: input.id ?? crypto.randomUUID(),
      organizationId,
      courseId: input.courseId,
      domain: input.domain,
      createdAt: Date.now(),
    })
    .returning()
    .get()
}

/** One website, scoped to `organizationId` — `undefined` both when it does not exist and when it belongs to another organization (TEN-5). */
export function getWebSource(
  organizationId: string,
  webSourceId: string,
  db: Executor
): CourseWebSource | undefined {
  return db
    .select()
    .from(courseWebSources)
    .where(
      and(
        eq(courseWebSources.id, webSourceId),
        eq(courseWebSources.organizationId, organizationId)
      )
    )
    .get()
}

/** Every website a course has named — what the panel's own websites list reads (FILE-6), and what `@bloombot/core#answerQuestion` reads into `ModelRequest.webSourceDomains` (MDL-9). */
export function listWebSourcesForCourse(
  organizationId: string,
  courseId: string,
  db: Executor
): CourseWebSource[] {
  return db
    .select()
    .from(courseWebSources)
    .where(
      and(
        eq(courseWebSources.courseId, courseId),
        eq(courseWebSources.organizationId, organizationId)
      )
    )
    .all()
}

/** Remove a website from a course. Returns whether a row was actually deleted, so a caller can tell a stale or foreign id (TEN-5) from a real removal. */
export function deleteWebSource(
  organizationId: string,
  webSourceId: string,
  db: Executor
): boolean {
  const result = db
    .delete(courseWebSources)
    .where(
      and(
        eq(courseWebSources.id, webSourceId),
        eq(courseWebSources.organizationId, organizationId)
      )
    )
    .run()
  return result.changes > 0
}
