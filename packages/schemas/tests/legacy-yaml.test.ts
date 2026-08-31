/**
 * Tests for the legacy `bot_config.yml` schema.
 *
 * The important case is the real file at the repository root: it is what the
 * production bot runs on today, so a schema that only parses invented fixtures
 * proves nothing.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { legacyBotConfigSchema, legacyCategorySchema } from '@bloombot/schemas'

const BOT_CONFIG = fileURLToPath(
  new URL('../../../bot_config.yml', import.meta.url)
)

/** The real production configuration, as a plain object. */
function loadRealConfig(): unknown {
  return parseYaml(readFileSync(BOT_CONFIG, 'utf8'))
}

describe('legacyBotConfigSchema against the real bot_config.yml', () => {
  const config = legacyBotConfigSchema.parse(loadRealConfig())

  it('parses the server name', () => {
    expect(config.server.name).toBe('Knowledge Kitchen')
  })

  it('yields exactly 2 active courses', () => {
    // The other courses are commented out in the YAML, so they never reach the
    // parser. "Active" is precisely "not commented out".
    expect(config.server.courses).toHaveLength(2)
    expect(config.server.courses.map((course) => course.title)).toEqual([
      'Web Design',
      'Introduction to Programming',
    ])
  })

  it('parses each course down to its OpenAI settings and roles', () => {
    const webDesign = config.server.courses[0]

    expect(webDesign?.file_prefix).toBe('wd')
    expect(webDesign?.roles).toEqual({
      admins: 'admins-wd-su26',
      students: 'students-wd-su26',
    })
    expect(webDesign?.openai_assistant.model).toBe('gpt-4.1')
    expect(webDesign?.openai_assistant.limits.max_requests_per_day).toBe(20)
  })

  it('tolerates a course whose assistant id has been retired', () => {
    // The Python course runs on the Prompts API alone; its `id` is commented out.
    const python = config.server.courses[1]

    expect(python?.openai_assistant.id).toBeUndefined()
    expect(python?.openai_assistant.prompt_id).toMatch(/^pmpt_/)
  })

  it('normalizes every category to { name, channels }', () => {
    for (const course of config.server.courses) {
      for (const category of course.categories) {
        expect(typeof category.name).toBe('string')
        expect(Array.isArray(category.channels)).toBe(true)
      }
    }
  })

  it('reads the admin-only flag on the channels that carry it', () => {
    const global = config.server.courses[0]?.categories[0]

    expect(global?.name).toBe('Web Design - GLOBAL')
    expect(global?.channels.map((channel) => channel.name)).toEqual([
      'admins',
      'pronouncements',
      'general',
      'grading',
      'tutoring',
      'quizzes',
      'exams',
    ])
    expect(
      global?.channels.find((channel) => channel.name === 'admins')?.admins_only
    ).toBe(true)
    // Everything else defaults to visible to students.
    expect(
      global?.channels.find((channel) => channel.name === 'general')
        ?.admins_only
    ).toBe(false)
  })
})

describe('legacyCategorySchema normalization', () => {
  it('normalizes the string and object forms identically', () => {
    const fromString = legacyCategorySchema.parse('Web Design - STUDENTS 01')
    const fromObject = legacyCategorySchema.parse({
      name: 'Web Design - STUDENTS 01',
    })

    expect(fromString).toEqual(fromObject)
    expect(fromString).toEqual({
      name: 'Web Design - STUDENTS 01',
      channels: [],
    })
  })

  it('keeps declared channels and defaults admins_only to false', () => {
    const category = legacyCategorySchema.parse({
      name: 'Python - GLOBAL',
      channels: [{ name: 'admins', admins_only: true }, { name: 'general' }],
    })

    expect(category).toEqual({
      name: 'Python - GLOBAL',
      channels: [
        { name: 'admins', admins_only: true },
        { name: 'general', admins_only: false },
      ],
    })
  })

  it('rejects an empty category name in either form', () => {
    expect(() => legacyCategorySchema.parse('')).toThrow()
    expect(() => legacyCategorySchema.parse({ name: '' })).toThrow()
  })
})

describe('malformed configuration', () => {
  // Typed loosely on purpose: these fixtures exist to be broken, and every
  // mutation below would otherwise need a cast that hides what is being tested.
  type Loose = Record<string, any>

  /** A minimal valid course, so each test can break exactly one thing. */
  const course = (): Loose => ({
    title: 'Web Design',
    file_prefix: 'wd',
    openai_assistant: {
      name: 'Bloombot (Web Design)',
      prompt_id: 'pmpt_test',
      vector_store_id: 'vs_test',
      instructions: 'Answer from the uploaded files.',
      model: 'gpt-4.1',
      limits: { max_requests_per_day: 20 },
    },
    roles: { admins: 'admins-wd', students: 'students-wd' },
    categories: ['Web Design - GLOBAL'],
  })

  const wrap = (courses: unknown[]) => ({
    server: { name: 'Knowledge Kitchen', courses },
  })

  it('is rejected with a path naming the offending field', () => {
    const broken = course()
    broken.roles.students = 42

    const result = legacyBotConfigSchema.safeParse(wrap([broken]))

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual([
      'server',
      'courses',
      0,
      'roles',
      'students',
    ])
  })

  it('names the offending channel inside the offending category', () => {
    const broken = course()
    broken.categories = [
      { name: 'Python - GLOBAL', channels: [{ admins_only: true }] },
    ]

    const result = legacyBotConfigSchema.safeParse(wrap([broken]))

    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('categories')
  })

  it('rejects a course missing its assistant entirely', () => {
    const broken = course()
    delete broken.openai_assistant

    const result = legacyBotConfigSchema.safeParse(wrap([broken]))

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual([
      'server',
      'courses',
      0,
      'openai_assistant',
    ])
  })

  it('rejects a file with no server block at all', () => {
    expect(legacyBotConfigSchema.safeParse({}).success).toBe(false)
  })

  it('accepts a server with no courses yet', () => {
    const parsed = legacyBotConfigSchema.parse({ server: { name: 'Empty' } })

    expect(parsed.server.courses).toEqual([])
  })
})
