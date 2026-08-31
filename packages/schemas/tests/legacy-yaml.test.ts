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
  // Deliberately the only assertions here (CFG-1 … CFG-4). Course titles,
  // role names, model names and channel lists all change with an ordinary
  // config edit — uncommenting one of the courses already in the file, say —
  // and none of that is what this test exists to catch. Pinning the roster
  // would turn a config-only change into a red build. What must never
  // regress is that the file the production bot actually runs on keeps
  // parsing at all, and each `it` below parses it itself rather than sharing
  // a `parse` run at `describe`-body (collection) time, so a real schema
  // mismatch fails one named test instead of aborting the whole suite.
  it('parses without throwing', () => {
    expect(() => legacyBotConfigSchema.parse(loadRealConfig())).not.toThrow()
  })

  it('normalizes every category in the real file to { name, channels }', () => {
    const config = legacyBotConfigSchema.parse(loadRealConfig())
    for (const course of config.server.courses) {
      for (const category of course.categories) {
        expect(typeof category.name).toBe('string')
        expect(Array.isArray(category.channels)).toBe(true)
      }
    }
  })

  // Structural, not a roster pin: this holds for any course anyone adds to
  // the file, so it stays green across the config-only edits the tests above
  // it were written to survive.
  it('gives every active course a title, a file_prefix and a prompt_id', () => {
    const config = legacyBotConfigSchema.parse(loadRealConfig())
    for (const course of config.server.courses) {
      expect(course.title.length).toBeGreaterThan(0)
      expect(course.file_prefix.length).toBeGreaterThan(0)
      expect(course.openai_assistant.prompt_id.length).toBeGreaterThan(0)
    }
  })
})

describe('legacyCategorySchema normalization', () => {
  // Fixture literals, not the live file — this is the behaviour the schema
  // itself is responsible for, so it should not move when the roster does.
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

  // Unlike name/instructions/vector_store_id/model/limits, prompt_id has no
  // default anywhere — without it the bot warns and never answers in that
  // course (response_bot.py:208) — so it alone stays required.
  it('rejects a course whose assistant has no prompt_id', () => {
    const broken = course()
    delete broken.openai_assistant.prompt_id

    const result = legacyBotConfigSchema.safeParse(wrap([broken]))

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual([
      'server',
      'courses',
      0,
      'openai_assistant',
      'prompt_id',
    ])
  })

  it('accepts a server with no courses yet', () => {
    const parsed = legacyBotConfigSchema.parse({ server: { name: 'Empty' } })

    expect(parsed.server.courses).toEqual([])
  })

  // CFG-2: response_bot.py reads name, instructions, vector_store_id, model
  // and limits.max_requests_per_day with `.get(key, default)` and never
  // reads them at all in the case of `name`/`instructions` — so a course
  // that never set them must still parse. Only `prompt_id` is required: the
  // bot cannot answer in a course without one (response_bot.py:208).
  it('parses a minimal course that omits every optional field', () => {
    const minimal = wrap([
      {
        title: 'Minimal Course',
        file_prefix: 'min',
        openai_assistant: { prompt_id: 'pmpt_minimal' },
        roles: { admins: 'admins-min', students: 'students-min' },
      },
    ])

    const parsed = legacyBotConfigSchema.parse(minimal)
    const assistant = parsed.server.courses[0]?.openai_assistant

    expect(assistant?.prompt_id).toBe('pmpt_minimal')
    expect(assistant?.name).toBeUndefined()
    expect(assistant?.instructions).toBeUndefined()
    expect(assistant?.vector_store_id).toBeUndefined()
    expect(assistant?.model).toBeUndefined()
    expect(assistant?.limits.max_requests_per_day).toBeUndefined()
    expect(parsed.server.courses[0]?.categories).toEqual([])
  })
})
