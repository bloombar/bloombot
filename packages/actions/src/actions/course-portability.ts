/**
 * PORT-1..PORT-8: exporting one course's configuration to a file, and
 * importing that file back into a project — the two halves of a round trip,
 * kept in one module because the format only stays a round trip if both ends
 * of it are read together.
 *
 * Neither action is a new way into the database. `courses.export` reads
 * through the same repositories `courses.get` does, and `courses.import`
 * writes through `courses.createCourse` — so an imported course obeys
 * PROJ-3's collision rules and TEN-2's scoping exactly as a course created by
 * hand does (PORT-4), and nothing here re-implements a check those already
 * make. This module owns three things and nothing else: which fields the file
 * carries, YAML in and out of that shape, and the PORT-5 title.
 *
 * **The file carries no people** (PORT-2). `@bloombot/schemas`'
 * `course-export.ts` has the format's own argument for why that is a property
 * of the shape rather than of a filter; on this side it means the export
 * reads a course's configuration tables and nothing else — no roster,
 * enrolment, conversation, transcript or join link is loaded here to be
 * dropped later.
 */

import {
  courseAttachments,
  courseInstructionRevisions,
  courses,
  courseWebSources,
  projects,
} from '@bloombot/db'
import {
  COURSE_EXPORT_KIND,
  COURSE_EXPORT_VERSION,
  readCourseExport,
  type CourseExportFile,
  type CourseExportNotCarried,
} from '@bloombot/schemas'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'

import {
  ActionConflictError,
  ActionInputError,
  ActionRefusedError,
} from '../errors.js'
import type { Action } from '../types.js'

type Project = NonNullable<ReturnType<typeof projects.getProject>>
type Course = NonNullable<ReturnType<typeof courses.getCourse>>

/**
 * A filename an instructor can find again in a downloads folder: the course's
 * own title reduced to something every filesystem accepts, and a suffix that
 * says what the file is. A title that reduces to nothing at all (punctuation
 * only, a non-Latin script) falls back to `course` rather than producing a
 * file whose name is just an extension.
 */
export function courseExportFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${slug || 'course'}.course.yml`
}

const exportInputSchema = z.strictObject({
  courseId: z.string().min(1),
})
type ExportInput = z.infer<typeof exportInputSchema>

/** What `courses.export` hands back: the file's name, its YAML text, and (PORT-3) what the course had that the file could not bring. */
export interface ExportCourseOutput {
  filename: string
  /** The file's own contents — YAML text, exactly as it should be written to disk. */
  content: string
  notCarried: CourseExportNotCarried
}

/**
 * PORT-1/PORT-8: export one course. A read of the organization, with a
 * policy like any other action (PROJ-5) — a caller who could not open this
 * course through `courses.get` cannot obtain its configuration through here
 * either.
 */
export const exportCourseAction: Action<
  'courses.export',
  ExportInput,
  Course,
  ExportCourseOutput
> = {
  name: 'courses.export',
  description:
    "Export one course's configuration (PORT-1) as a YAML file — settings, roles, categories, channels and websites, never anyone's data.",
  inputSchema: exportInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'read' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, entity, db }) => {
    const websites = courseWebSources.listWebSourcesForCourse(
      organizationId,
      entity.id,
      db
    )
    const attachments = courseAttachments.listAttachmentsForCourse(
      organizationId,
      entity.id,
      db
    )
    // PORT-3 — recorded as "the course had one", never as the identifier
    // itself: a vector store id or a Discord snowflake means nothing in the
    // organization this file is going to, and carrying it would invite an
    // import to write a reference to something it cannot reach.
    const notCarried: CourseExportNotCarried = {
      vectorStore: entity.vectorStoreId !== null,
      storedPrompt: entity.promptId !== null,
      attachments: attachments.length,
      discordServer: entity.discordServerId !== null,
    }
    const file: CourseExportFile = {
      bloombotCourseExport: COURSE_EXPORT_VERSION,
      kind: COURSE_EXPORT_KIND,
      exportedAt: new Date().toISOString(),
      course: {
        title: entity.title,
        adminsRole: entity.adminsRole,
        studentsRole: entity.studentsRole,
        model: entity.model,
        instructions: entity.instructions,
        maxRequestsPerDay: entity.maxRequestsPerDay,
        conversationScope: entity.conversationScope,
        // ENRL-13/ENRL-14 (must-fix 4, review round 1) — carried, not
        // dropped: both are course-level policy, the same kind of setting
        // `conversationScope` already travels as, not an organization- or
        // provider-specific identifier like `vectorStoreId`/`discordServerId`
        // (`notCarried`, below) that means nothing in a different tenant.
        selfEnrolFromDiscord: entity.selfEnrolFromDiscord,
        answerUnenrolled: entity.answerUnenrolled,
        categories: entity.categories.map((category) => ({
          name: category.name,
          channels: category.channels.map((channel) => ({
            name: channel.name,
            adminsOnly: channel.adminsOnly,
          })),
        })),
        websites: websites.map((source) => source.domain),
      },
      notCarried,
    }
    return {
      filename: courseExportFilename(entity.title),
      // `lineWidth: 0` disables YAML's own line folding: a course's
      // instructions are prose, and a folded block re-read by a human (or
      // diffed in version control) is much harder to follow than one long
      // line per paragraph.
      content: stringifyYaml(file, { lineWidth: 0 }),
      notCarried,
    }
  },
}

const importInputSchema = z.strictObject({
  projectId: z.string().min(1),
  /** The uploaded file's text, verbatim. Parsed in `execute` — see `refuseFile` below for why a bad one is an input failure and not a 500. */
  content: z.string().min(1),
})
type ImportInput = z.infer<typeof importInputSchema>

/** What `courses.import` reports (PORT-7). */
export interface ImportCourseOutput {
  course: Course
  /** The title the course was actually given — PORT-5's suffix when the file's own title was taken. */
  title: string
  /** Whether PORT-5 had to change the title, so the panel can say so only when it happened. */
  titleChanged: boolean
  /** Always `true` (PORT-6), named rather than typed `boolean` so a caller cannot mistake it for a flag that might come back `false`. */
  disabled: true
  notCarried: CourseExportNotCarried
}

/**
 * PORT-7's "refused whole, before anything is written", as an input failure
 * rather than a server error: the file *is* this action's input, so a file
 * that does not parse is a 400 naming the `content` field, the same status
 * and the same shape every other malformed input to this API produces. The
 * issue is built by hand because the failure is found after zod has already
 * accepted `content` as a string — YAML parsing is not something a zod schema
 * can do on this package's behalf.
 */
function refuseFile(reason: string): never {
  throw new ActionInputError([
    { code: 'custom', path: ['content'], message: reason, input: undefined },
  ])
}

/**
 * PORT-4/PORT-5/PORT-6/PORT-7: import a course into a project the caller
 * names. A write on the project, exactly as `courses.save` is — the file
 * never chooses its own destination, and the ids it was exported from are not
 * read at all (the format does not carry them).
 */
export const importCourseAction: Action<
  'courses.import',
  ImportInput,
  Project,
  ImportCourseOutput
> = {
  name: 'courses.import',
  description:
    'Import a course export file (PORT-1) into a project, disabled, with a title that does not collide with a course already there.',
  inputSchema: importInputSchema,
  policy: {
    descriptor: { resource: 'project', access: 'write' },
    resolve: (input, context) =>
      projects.getProject(context.organizationId, input.projectId, context.db),
  },
  execute: ({ organizationId, entity, input, accountId, db }) => {
    // FILE-4 — an import that carries instructions records them as an
    // authored revision, exactly as `courseInstructions.save` does, so the
    // panel's own instructions history is not blank for a course whose
    // instructions plainly exist. That needs an author, and this action
    // refuses without one rather than inventing a revision nobody wrote —
    // the same `requireAccountId` refusal `courseInstructions.save` makes.
    if (!accountId) throw new ActionRefusedError()

    let document: unknown
    try {
      document = parseYaml(input.content)
    } catch {
      // The parser's own message names a line and column in a file this
      // process never saw the name of; a person who just dropped a file into
      // a dialog is better served by being told it is not YAML at all.
      refuseFile('That file could not be read as YAML.')
    }
    const read = readCourseExport(document)
    if (!read.ok) refuseFile(read.reason)
    const exported = read.file.course

    return db.transaction((tx): ImportCourseOutput => {
      // PORT-5 — resolved inside the transaction that writes the course, so
      // two imports landing at once cannot both be told the same suffix is
      // free (the same "check and write in one transaction" discipline
      // `createCourse` already applies to its own PROJ-3 check).
      const title = courses.nextAvailableCourseTitle(
        organizationId,
        entity.id,
        exported.title,
        tx
      )
      const result = courses.createCourse(
        organizationId,
        {
          projectId: entity.id,
          title,
          // PORT-6 — never enabled, whatever the source was.
          enabled: false,
          adminsRole: exported.adminsRole,
          studentsRole: exported.studentsRole,
          // PORT-3 — the three things the file deliberately does not carry
          // are left unset rather than guessed at.
          promptId: null,
          vectorStoreId: null,
          discordServerId: null,
          instructions: exported.instructions,
          model: exported.model,
          maxRequestsPerDay: exported.maxRequestsPerDay,
          conversationScope: exported.conversationScope,
          // ENRL-13/ENRL-14 (must-fix 4, review round 1) — `?? false`/`?? true`
          // match `schema.ts`'s own database defaults exactly: a file
          // exported before this slice existed (`exportedCourseSchema`'s own
          // comment on why both are `.optional()`) carries neither key, and
          // an absent value has to mean "the behaviour this course had
          // before either setting existed" — the same reading every other
          // database-defaulted column in this platform already gets.
          selfEnrolFromDiscord: exported.selfEnrolFromDiscord ?? false,
          answerUnenrolled: exported.answerUnenrolled ?? true,
          categories: exported.categories,
        },
        tx
      )
      // PROJ-3's own collision, named the way `courses.save` names it. A
      // course arriving disabled cannot trip the *cross-course* check, but
      // `createCourse`'s own self-conflict check (a course naming the same
      // role for admins and students) runs regardless, and a hand-edited
      // file can absolutely carry that.
      if (!result.ok) throw new ActionConflictError(result.conflict)

      // FILE-4 — the live column is already set by `createCourse` above;
      // this is the matching first revision, written in the same transaction
      // so a course never ends up with instructions and no history of them.
      if (exported.instructions !== null) {
        courseInstructionRevisions.createRevision(
          organizationId,
          {
            courseId: result.course.id,
            instructions: exported.instructions,
            savedByAccountId: accountId,
          },
          tx
        )
      }

      for (const domain of exported.websites) {
        courseWebSources.addWebSource(
          organizationId,
          { courseId: result.course.id, domain },
          tx
        )
      }

      return {
        course: result.course,
        title,
        titleChanged: title !== exported.title.trim(),
        disabled: true,
        notCarried: read.file.notCarried,
      }
    })
  },
}
