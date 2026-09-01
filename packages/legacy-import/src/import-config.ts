/**
 * MIG-2: `bot_config.yml` becomes an organization, one project holding the
 * term's courses, and each course's roles, categories and channels — parsed
 * with `legacyBotConfigSchema` (`packages/schemas`) and written through
 * `@bloombot/db`'s repos, never with SQL of this package's own, so an
 * imported course obeys the same PROJ-3 collision and TEN-2 scoping rules a
 * course created by hand does.
 *
 * **Naming the organization and the project.** The legacy YAML has no term
 * field — `roles.admins`/`roles.students` carry a term-like suffix
 * (`admins-wd-su26`), but the abbreviation is inconsistent across courses
 * (`s26` vs `su26` in this very file) and guessing a human-readable term out
 * of it is exactly the kind of "looks right, is wrong for the config nobody
 * has tested this against yet" behaviour D-10 already declined for the YAML
 * schema itself. Both the organization and the (single, initial) project
 * default to `server.name` instead — the one stable, already-validated
 * string the format actually carries — and `importConfig` accepts an
 * optional `projectName` for a caller (a later re-import naming an actual
 * term, say) that wants something more specific. See the slice's report /
 * `docs/DECISIONS.md` for the full reasoning.
 */

import { readFileSync } from 'node:fs'

import {
  courses as coursesRepo,
  organizations as organizationsRepo,
  projects as projectsRepo,
  type Database,
} from '@bloombot/db'
import {
  legacyBotConfigSchema,
  type LegacyBotConfig,
  type LegacyCourse,
} from '@bloombot/schemas'
import { parse as parseYaml } from 'yaml'

import { deterministicId } from './ids.js'

/** Read and validate `bot_config.yml` at `yamlPath` (CFG-1..4, MIG-2). Throws (via `legacyBotConfigSchema`) on a file that does not match the shape the bot itself requires. */
export function loadLegacyConfig(yamlPath: string): LegacyBotConfig {
  const raw = parseYaml(readFileSync(yamlPath, 'utf8'))
  return legacyBotConfigSchema.parse(raw)
}

/** What happened to one legacy course on import. */
export type CourseImportOutcome =
  | { legacyTitle: string; ok: true; created: boolean; courseId: string }
  | { legacyTitle: string; ok: false; conflict: coursesRepo.CourseNameConflict }

/** What `importConfig` created, matched, or refused. */
export interface ImportConfigResult {
  organizationId: string
  organizationCreated: boolean
  projectId: string
  projectCreated: boolean
  courses: CourseImportOutcome[]
}

/** `importConfig`'s options — every field optional, see the module comment for the default. */
export interface ImportConfigOptions {
  /** Defaults to `config.server.name`. */
  projectName?: string
}

/** One legacy course, converted to `createCourse`'s input shape (CFG-1..4). */
function toNewCourse(
  projectId: string,
  course: LegacyCourse
): coursesRepo.NewCourse {
  return {
    projectId,
    title: course.title,
    filePrefix: course.file_prefix,
    enabled: true,
    adminsRole: course.roles.admins,
    studentsRole: course.roles.students,
    promptId: course.openai_assistant.id ?? null,
    instructions: course.openai_assistant.instructions ?? null,
    model: course.openai_assistant.model ?? null,
    vectorStoreId: course.openai_assistant.vector_store_id ?? null,
    maxRequestsPerDay:
      course.openai_assistant.limits.max_requests_per_day ?? null,
    categories: course.categories.map((category) => ({
      name: category.name,
      channels: category.channels.map((channel) => ({
        name: channel.name,
        adminsOnly: channel.admins_only,
      })),
    })),
  }
}

/**
 * Import `config` (already parsed and validated by `legacyBotConfigSchema`)
 * into the platform schema.
 *
 * Idempotent (MIG-4): the organization is looked up by a deterministic id
 * derived from `server.name`, so re-running against the same YAML reuses the
 * same organization rather than creating a second one. The project is then
 * looked up by name within that organization (`listProjects`) — there is no
 * separate deterministic id needed for it once the organization it lives in
 * is itself stable. A course already present (matched by its title within
 * this project — the natural key the brief calls out) is left untouched
 * rather than re-saved, so a second run neither duplicates it nor churns its
 * category/channel ids for no reason.
 */
export function importConfig(
  config: LegacyBotConfig,
  db: Database,
  options: ImportConfigOptions = {}
): ImportConfigResult {
  const organizationId = deterministicId('legacy-org', config.server.name)
  const existingOrganization = organizationsRepo.getOrganizationById(
    organizationId,
    db
  )
  const organizationCreated = !existingOrganization
  if (!existingOrganization) {
    organizationsRepo.createOrganization(
      organizationId,
      { name: config.server.name, isPersonal: false },
      db
    )
  }

  const projectName = options.projectName ?? config.server.name
  const existingProject = projectsRepo
    .listProjects(organizationId, db, { includeArchived: true })
    .find((project) => project.name === projectName)
  const projectCreated = !existingProject
  const project =
    existingProject ??
    projectsRepo.createProject(organizationId, { name: projectName }, db)

  const courseOutcomes: CourseImportOutcome[] = config.server.courses.map(
    (legacyCourse) => {
      const existingCourse = coursesRepo
        .listCourses(organizationId, db, { projectId: project.id })
        .find((course) => course.title === legacyCourse.title)
      if (existingCourse) {
        return {
          legacyTitle: legacyCourse.title,
          ok: true,
          created: false,
          courseId: existingCourse.id,
        }
      }

      const result = coursesRepo.createCourse(
        organizationId,
        toNewCourse(project.id, legacyCourse),
        db
      )
      if (!result.ok) {
        return {
          legacyTitle: legacyCourse.title,
          ok: false,
          conflict: result.conflict,
        }
      }
      return {
        legacyTitle: legacyCourse.title,
        ok: true,
        created: true,
        courseId: result.course.id,
      }
    }
  )

  return {
    organizationId,
    organizationCreated,
    projectId: project.id,
    projectCreated,
    courses: courseOutcomes,
  }
}
