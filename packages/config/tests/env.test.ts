import { afterEach, describe, expect, it } from 'vitest'

import {
  CONFIG,
  EnvValidationError,
  envSchema,
  parseEnv,
  resetConfigCache,
} from '@bloombot/config'

/** The smallest environment that satisfies the schema. */
const VALID: Record<string, string> = {
  NODE_ENV: 'test',
  PUBLIC_APP_URL: 'https://bloombot.example.edu',
}

describe('parseEnv', () => {
  it('applies documented defaults when optional variables are absent', () => {
    const env = parseEnv({ ...VALID })

    expect(env.LOG_LEVEL).toBe('info')
    expect(env.LOGS_DIR).toBe('./logs')
    expect(env.DATABASE_PATH).toBe('./data/data.db')
    expect(env.API_PORT).toBe(3000)
    expect(env.BOT_HEALTH_PORT).toBe(3001)
    expect(env.ADMIN_EMAILS).toBe('')
  })

  it('defaults every upstream base URL to the real service (QA-2)', () => {
    const env = parseEnv({ ...VALID })

    expect(env.DISCORD_API_BASE).toBe('https://discord.com/api/v10')
    expect(env.DISCORD_OAUTH_BASE).toBe('https://discord.com/api/oauth2')
    expect(env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
    expect(env.GOOGLE_ISSUER).toBe('https://accounts.google.com')
  })

  it('lets a test point an upstream at a fake host (QA-2)', () => {
    const env = parseEnv({
      ...VALID,
      OPENAI_BASE_URL: 'http://127.0.0.1:8931/v1',
    })

    expect(env.OPENAI_BASE_URL).toBe('http://127.0.0.1:8931/v1')
  })

  it('rejects a port that is not a number', () => {
    expect(() => parseEnv({ ...VALID, API_PORT: 'eight thousand' })).toThrow(
      EnvValidationError
    )
  })

  it('rejects a port outside the valid range', () => {
    expect(() => parseEnv({ ...VALID, BOT_HEALTH_PORT: '70000' })).toThrow(
      EnvValidationError
    )
  })

  it('coerces a numeric port string to a number', () => {
    expect(parseEnv({ ...VALID, API_PORT: '8080' }).API_PORT).toBe(8080)
  })

  it('rejects a NODE_ENV outside the known deployments', () => {
    expect(() => parseEnv({ ...VALID, NODE_ENV: 'staging' })).toThrow(
      EnvValidationError
    )
  })

  it('rejects a PUBLIC_APP_URL that is not a URL', () => {
    expect(() =>
      parseEnv({ ...VALID, PUBLIC_APP_URL: 'bloombot.example.edu' })
    ).toThrow(EnvValidationError)
  })

  // The whole point of the schema: a broken environment is reported once, in
  // full, rather than one variable per restart.
  it('reports every missing variable at once, not just the first', () => {
    let error: EnvValidationError | undefined
    try {
      parseEnv({})
    } catch (caught) {
      error = caught as EnvValidationError
    }

    expect(error).toBeInstanceOf(EnvValidationError)
    expect(error?.problems).toHaveLength(2)
    expect(error?.problems.join('\n')).toContain('NODE_ENV')
    expect(error?.problems.join('\n')).toContain('PUBLIC_APP_URL')
  })

  it('reports a missing variable and an invalid one together', () => {
    let error: EnvValidationError | undefined
    try {
      parseEnv({ NODE_ENV: 'test', API_PORT: 'nope' })
    } catch (caught) {
      error = caught as EnvValidationError
    }

    const message = error?.message ?? ''
    expect(message).toContain('PUBLIC_APP_URL')
    expect(message).toContain('API_PORT')
  })

  it('does not read process.env', () => {
    // A stray value in the ambient environment must not rescue an empty source.
    process.env.PUBLIC_APP_URL = 'https://leaked.example.com'
    try {
      expect(() => parseEnv({ NODE_ENV: 'test' })).toThrow(/PUBLIC_APP_URL/)
    } finally {
      delete process.env.PUBLIC_APP_URL
    }
  })
})

describe('CONFIG', () => {
  const originalNodeEnv = process.env.NODE_ENV

  afterEach(() => {
    resetConfigCache()
    process.env.NODE_ENV = originalNodeEnv
    delete process.env.PUBLIC_APP_URL
    delete process.env.API_PORT
  })

  it('reads process.env lazily, on first property access (PLAT-5)', () => {
    resetConfigCache()
    process.env.NODE_ENV = 'test'
    process.env.PUBLIC_APP_URL = 'https://bloombot.example.edu'
    process.env.API_PORT = '4100'

    expect(CONFIG.API_PORT).toBe(4100)
    expect(CONFIG.PUBLIC_APP_URL).toBe('https://bloombot.example.edu')
  })

  it('throws with every problem listed when the environment is invalid', () => {
    resetConfigCache()
    process.env.NODE_ENV = 'test'
    process.env.PUBLIC_APP_URL = 'not-a-url'

    expect(() => CONFIG.API_PORT).toThrow(EnvValidationError)
  })
})

describe('envSchema', () => {
  it('exposes its keys so the environment template can be checked against it', () => {
    expect(Object.keys(envSchema.shape)).toContain('DATABASE_PATH')
  })
})
