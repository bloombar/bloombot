/**
 * Schema for the legacy `bot_config.yml` at the repository root (CFG-1 … CFG-4).
 *
 * This is the file the current Python bot runs on, and it stays the source of
 * truth until courses live in the database. Parsing it through a schema rather
 * than by hand means a typo in a role name is a startup error with a path, not a
 * course that silently answers nobody.
 *
 * The awkward part is `categories`. History left two accepted spellings — a bare
 * string, and an object with named channels — and both appear in real configs.
 * They are normalized here into a single shape so no consumer downstream ever has
 * to branch on which one an author used.
 */

import { z } from 'zod'

/** A channel inside a category (CFG-4). */
export const legacyChannelSchema = z.object({
  name: z.string().min(1),
  // Only the course's admin role can see the channel. Defaults to open to
  // students, because that is the common case and the risky one to get wrong by
  // omission is the other direction.
  admins_only: z.boolean().default(false),
})

/** A channel after normalization. */
export type LegacyChannel = z.output<typeof legacyChannelSchema>

/** The normalized shape both category spellings produce. */
export interface LegacyCategory {
  name: string
  channels: LegacyChannel[]
}

/**
 * A category, in either accepted spelling:
 *
 *   - `- 'Web Design - STUDENTS 01'`            a bare string, no named channels
 *   - `- name: 'Web Design - GLOBAL'`           an object, optionally with channels
 *       channels: [{ name: 'admins', admins_only: true }]
 *
 * Both normalize to `{ name, channels }`; the string form simply has no channels.
 */
export const legacyCategorySchema: z.ZodType<LegacyCategory> = z.union([
  z
    .string()
    .min(1)
    .transform((name): LegacyCategory => ({ name, channels: [] })),
  z
    .object({
      name: z.string().min(1),
      channels: z.array(legacyChannelSchema).default([]),
    })
    .transform((category): LegacyCategory => ({
      name: category.name,
      channels: category.channels,
    })),
])

/** Per-course OpenAI assistant settings (CFG-2). */
export const legacyOpenAiAssistantSchema = z.object({
  name: z.string().min(1),
  // Optional: courses migrated to the Prompts API no longer carry an assistant id.
  id: z.string().min(1).optional(),
  prompt_id: z.string().min(1),
  vector_store_id: z.string().min(1),
  instructions: z.string().min(1),
  // Assistant tool declarations are passed through to OpenAI untouched.
  tools: z.array(z.unknown()).default([]),
  model: z.string().min(1),
  limits: z.object({
    // Per user, per day (BOT-5).
    max_requests_per_day: z.number().int().positive(),
  }),
})

/** The Discord roles a course is taught through (CFG-3). */
export const legacyRolesSchema = z.object({
  admins: z.string().min(1),
  students: z.string().min(1),
})

/** One course. */
export const legacyCourseSchema = z.object({
  title: z.string().min(1),
  // Prefix used to recognize this course's roster and questionnaire CSVs.
  file_prefix: z.string().min(1),
  openai_assistant: legacyOpenAiAssistantSchema,
  roles: legacyRolesSchema,
  categories: z.array(legacyCategorySchema).default([]),
})

/**
 * The whole file. Courses that have been commented out in the YAML never reach
 * the parser, so `courses` is exactly the set of active courses.
 */
export const legacyBotConfigSchema = z.object({
  server: z.object({
    name: z.string().min(1),
    courses: z.array(legacyCourseSchema).default([]),
  }),
})

export type LegacyChannelInput = z.input<typeof legacyChannelSchema>
export type LegacyOpenAiAssistant = z.output<typeof legacyOpenAiAssistantSchema>
export type LegacyRoles = z.output<typeof legacyRolesSchema>
export type LegacyCourse = z.output<typeof legacyCourseSchema>
export type LegacyBotConfig = z.output<typeof legacyBotConfigSchema>
