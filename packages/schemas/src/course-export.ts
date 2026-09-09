/**
 * PORT-1/PORT-2/PORT-3: the shape of a course export file.
 *
 * This module owns the *format*, not the file. It validates an already-parsed
 * object (a YAML document, a JSON body, a fixture in a test) and says what is
 * wrong with one that does not fit. Turning a file's text into that object,
 * and back, is `@bloombot/actions`' own job — this package depends on zod
 * alone so it can be bundled into the browser (PLAT-2), and a YAML parser is
 * exactly the dependency that would end that.
 *
 * **What the format carries** is one course's configuration: its title, the
 * two Discord role names it is taught through, its answering settings, its
 * categories and channels in declared order, and the websites it draws on.
 *
 * **What it never carries** is anybody's data (PORT-2). There is no roster,
 * enrolment, conversation, transcript, join link or member here, and none is
 * filtered out on the way in either — the format simply has no field to put
 * one in, so a future column holding something about a person cannot arrive
 * here by being forgotten about.
 *
 * **What it names but cannot carry** (PORT-3) is `notCarried`: a course's
 * OpenAI vector store and stored prompt, its knowledge-file attachments and
 * its Discord server binding all name state living outside the destination
 * organization. Recording *that they existed*, without the identifiers, is
 * what lets an import tell an instructor what is still missing rather than
 * leaving a course quietly answering from an empty vector store.
 */

import { z } from 'zod'

/**
 * The only format version this build reads. Bumped when a change to the
 * shape below would make an older file mean something different — never for
 * an added optional field, which an older file simply omits.
 */
export const COURSE_EXPORT_VERSION = 1

/** The `kind` marker every export file carries, so a YAML file that happens to parse is still recognisably not one of ours. */
export const COURSE_EXPORT_KIND = 'bloombot.course'

const channelSchema = z.strictObject({
  name: z.string().min(1),
  adminsOnly: z.boolean(),
})

const categorySchema = z.strictObject({
  name: z.string().min(1),
  channels: z.array(channelSchema),
})

/**
 * `z.strictObject` throughout (the same reasoning `courses.save`'s own input
 * schema records): a key this build does not recognize is refused, not
 * silently dropped. A file written by a newer build carrying a field this one
 * would ignore is better refused loudly than imported as a course quietly
 * missing whatever that field meant.
 */
export const exportedCourseSchema = z.strictObject({
  title: z.string().min(1),
  adminsRole: z.string().min(1),
  studentsRole: z.string().min(1),
  model: z.string().min(1).nullable(),
  instructions: z.string().nullable(),
  maxRequestsPerDay: z.number().int().positive().nullable(),
  conversationScope: z.enum(['course', 'course_surface']),
  categories: z.array(categorySchema),
  /** FILE-6/MDL-9 — the course's own websites, as normalized domains. */
  websites: z.array(z.string().min(1)),
})
export type ExportedCourse = z.infer<typeof exportedCourseSchema>

/** PORT-3 — what the source course had that this file cannot bring with it. */
export const notCarriedSchema = z.strictObject({
  /** The course answered from an OpenAI vector store, which belongs to the exporting account's provider. */
  vectorStore: z.boolean(),
  /** The course used a stored prompt id (D-3's escape hatch), likewise provider-side. */
  storedPrompt: z.boolean(),
  /** How many knowledge files the course had — uploaded objects, not configuration. */
  attachments: z.number().int().nonnegative(),
  /** The course named a Discord server, which is a row the destination organization does not have. */
  discordServer: z.boolean(),
})
export type CourseExportNotCarried = z.infer<typeof notCarriedSchema>

export const courseExportFileSchema = z.strictObject({
  bloombotCourseExport: z.literal(COURSE_EXPORT_VERSION),
  kind: z.literal(COURSE_EXPORT_KIND),
  /** When the file was written, ISO-8601. Informational — nothing reads it back. */
  exportedAt: z.string().min(1),
  course: exportedCourseSchema,
  notCarried: notCarriedSchema,
})
export type CourseExportFile = z.infer<typeof courseExportFileSchema>

/** What `readCourseExport` gives back: the file, or one sentence saying why not (PORT-7). */
export type CourseExportReadResult =
  { ok: true; file: CourseExportFile } | { ok: false; reason: string }

/**
 * PORT-7: validate an already-parsed document as a course export file,
 * refusing it whole rather than half-reading it.
 *
 * The version is checked before the rest of the shape, and separately from
 * it, so a file from a newer build is told apart from a malformed one — "this
 * file was written by a newer version" and "this file is not a course export"
 * are different problems with different fixes, and a caller that reported
 * them identically would send somebody looking for a typo in a file that has
 * none.
 */
export function readCourseExport(document: unknown): CourseExportReadResult {
  if (typeof document !== 'object' || document === null) {
    return {
      ok: false,
      reason: 'That file is not a course export — it holds no course.',
    }
  }
  const version = (document as Record<string, unknown>)['bloombotCourseExport']
  if (version === undefined) {
    return {
      ok: false,
      reason:
        'That file is not a course export — it has no "bloombotCourseExport" version.',
    }
  }
  if (version !== COURSE_EXPORT_VERSION) {
    return {
      ok: false,
      reason:
        `That file is a version ${String(version)} course export; ` +
        `this version of Bloombot reads version ${COURSE_EXPORT_VERSION}.`,
    }
  }
  const parsed = courseExportFileSchema.safeParse(document)
  if (!parsed.success) {
    const [issue] = parsed.error.issues
    const where = issue?.path.length ? ` at "${issue.path.join('.')}"` : ''
    return {
      ok: false,
      reason: `That course export could not be read${where}: ${issue?.message ?? 'it does not match the format'}.`,
    }
  }
  return { ok: true, file: parsed.data }
}
