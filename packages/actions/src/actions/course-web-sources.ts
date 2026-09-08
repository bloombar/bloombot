/**
 * Actions over `packages/db`'s `course-web-sources` repo (FILE-6, MDL-9,
 * WEB-31): `courseWebSources.add`, `.list` and `.remove`, modelled directly
 * on `course-join-links.ts`'s own `.create`/`.list`/`.revoke` — same
 * policy/descriptor shape, same organization scoping (ACT-2, TEN-2).
 *
 * Unlike a join link, there is no secret here and nothing to encrypt — a
 * website is a plain, instructor-visible fact about a course, so `.add` and
 * `.remove` are plain objects, not factories.
 */

import { courses, courseWebSources } from '@bloombot/db'
import { normalizeWebSourceDomain } from '@bloombot/schemas'
import { z } from 'zod'

import { ActionConflictError } from '../errors.js'
import type { Action } from '../types.js'

type Course = NonNullable<ReturnType<typeof courses.getCourse>>
type WebSource = NonNullable<ReturnType<typeof courseWebSources.getWebSource>>

// OpenAI's own ceiling on `web_search`'s `filters.allowed_domains` — 100
// domains (MDL-9's own provider shape, `packages/openai/src/responses.ts`).
// A course whose own row count already reached this before an `.add` runs
// is refused rather than let a 101st domain land: past the cap, every
// model request for that course would build an *invalid* `tools` entry,
// which fails every question this course is asked from then on, with only
// a log line and no signal in the panel that anything is wrong. The same
// "an explicit, tested, named ceiling rather than a silent provider
// rejection" discipline `MAX_COURSE_ATTACHMENT_BYTES`'s own doc comment
// (`apps/api/src/routes/actions.ts`) already holds itself to for a
// different provider ceiling.
export const MAX_COURSE_WEB_SOURCES = 100

// D-12/D-18's own shape (`projects.ts#createProject`'s doc comment): the
// database is what actually refuses a duplicate domain
// (`course_web_sources_course_domain_unique`, `schema.ts`) — this package
// is the layer that turns that raw driver error into a named
// `ActionConflictError` a caller can read, rather than an opaque 500.
function isUniqueDomainConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}

const addInputSchema = z.object({
  courseId: z.string().min(1),
  /**
   * WEB-31 — whatever an instructor typed, including a full URL: validated
   * here with `.superRefine`, not `.transform` — ACT-6's own catalog
   * derives real JSON Schema from every action's input schema
   * (`catalog.test.ts`), and `z.toJSONSchema` cannot represent a
   * `.transform` at all (it throws building the catalog, not merely at
   * parse time). `.superRefine` validates without changing the parsed
   * type, so `input.domain` here is still whatever the caller sent — the
   * reduction to a bare domain happens once, in `execute` (below), which
   * calls the exact same `normalizeWebSourceDomain` this refinement already
   * proved would succeed. A value that does not reduce to a domain fails
   * this schema's own validation (`ActionInputError`, `dispatch.ts`) with
   * the plain-English reason `normalizeWebSourceDomain` gives, rather than
   * reaching `execute` at all.
   */
  domain: z.string().superRefine((value, ctx) => {
    const result = normalizeWebSourceDomain(value)
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: result.reason })
    }
  }),
})
type AddInput = z.infer<typeof addInputSchema>

/**
 * FILE-6/WEB-31: add a website to a course. Resolves the course itself
 * (scoped to the caller's organization, ACT-2), then inserts — refusing a
 * domain this course has already named with a clear `ActionConflictError`
 * (this file's own module comment), never a duplicate row and never an
 * opaque constraint error (this slice's own brief).
 */
export const addCourseWebSourceAction: Action<
  'courseWebSources.add',
  AddInput,
  Course,
  WebSource
> = {
  name: 'courseWebSources.add',
  description:
    "Add a website to a course's knowledge (FILE-6): accepts a full URL or a bare domain and reduces it to its domain (WEB-31), which grounds the course's answers through a domain-restricted web search (MDL-9). Refuses a domain this course has already named.",
  inputSchema: addInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'write' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, input, entity, db }) => {
    // Guaranteed to succeed — `addInputSchema`'s own `.superRefine` already
    // ran this exact function over `input.domain` and refused this call
    // before `execute` ever ran otherwise (this schema's own doc comment).
    const normalized = normalizeWebSourceDomain(input.domain)
    if (!normalized.ok) {
      throw new Error(
        `courseWebSources.add: input schema accepted a domain execute could not normalize ("${input.domain}") — should be unreachable`
      )
    }

    // MAX_COURSE_WEB_SOURCES's own doc comment above — checked before the
    // insert, not caught as a second kind of constraint violation after
    // it: there is no database constraint enforcing this cap (it is a
    // provider ceiling, not a uniqueness rule), so nothing would otherwise
    // stop a 101st row from landing.
    const existing = courseWebSources.listWebSourcesForCourse(
      organizationId,
      entity.id,
      db
    )
    if (existing.length >= MAX_COURSE_WEB_SOURCES) {
      throw new ActionConflictError({
        message: `This course already names ${MAX_COURSE_WEB_SOURCES} websites, the most a single course may ground its answers in.`,
      })
    }

    try {
      return courseWebSources.addWebSource(
        organizationId,
        { courseId: entity.id, domain: normalized.domain },
        db
      )
    } catch (error) {
      if (!isUniqueDomainConstraintError(error)) throw error
      throw new ActionConflictError({
        message: `"${normalized.domain}" is already a website this course names.`,
      })
    }
  },
}

const listInputSchema = z.object({
  courseId: z.string().min(1),
})
type ListInput = z.infer<typeof listInputSchema>

/** FILE-6: list a course's websites — what the panel's own "websites" screen reads, and what `@bloombot/core#answerQuestion` reads to build `ModelRequest.webSourceDomains` (MDL-9). */
export const listCourseWebSourcesAction: Action<
  'courseWebSources.list',
  ListInput,
  Course,
  courseWebSources.CourseWebSource[]
> = {
  name: 'courseWebSources.list',
  description:
    "List a course's websites (FILE-6): the domains grounding it, alongside its knowledge files.",
  inputSchema: listInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'read' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, entity, db }) =>
    courseWebSources.listWebSourcesForCourse(organizationId, entity.id, db),
}

const removeInputSchema = z.object({
  webSourceId: z.string().min(1),
})
type RemoveInput = z.infer<typeof removeInputSchema>

/** FILE-6: remove a website from a course — takes effect immediately: the next answer this course gives is no longer grounded by it. */
export const removeCourseWebSourceAction: Action<
  'courseWebSources.remove',
  RemoveInput,
  WebSource,
  { removed: boolean }
> = {
  name: 'courseWebSources.remove',
  description:
    "Remove a website from a course (FILE-6): the course's answers are no longer grounded by it.",
  inputSchema: removeInputSchema,
  policy: {
    descriptor: { resource: 'courseWebSource', access: 'write' },
    resolve: (input, context) =>
      courseWebSources.getWebSource(
        context.organizationId,
        input.webSourceId,
        context.db
      ),
  },
  execute: ({ organizationId, entity, db }) => {
    courseWebSources.deleteWebSource(organizationId, entity.id, db)
    return { removed: true }
  },
}
