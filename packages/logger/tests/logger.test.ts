/**
 * Logger tests.
 *
 * Everything is written into a throwaway temp directory. The repository's
 * `logs/*.log` are real operational logs and a protected path; a test suite has
 * no business writing there.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetConfigCache } from '@bloombot/config'
import { createLogger } from '@bloombot/logger'

let logsDir: string

beforeEach(() => {
  logsDir = mkdtempSync(join(tmpdir(), 'bloombot-logger-'))
  // A valid baseline environment: options the tests do not pass explicitly fall
  // back to CONFIG, and CONFIG validates the whole environment on first read.
  resetConfigCache()
  process.env.NODE_ENV = 'test'
  process.env.PUBLIC_APP_URL = 'https://bloombot.example.edu'
})

afterEach(() => {
  rmSync(logsDir, { recursive: true, force: true })
  resetConfigCache()
  delete process.env.LOGS_DIR
  delete process.env.LOG_LEVEL
  delete process.env.PUBLIC_APP_URL
})

/** Read the JSONL a logger wrote, one parsed record per line. */
function readRecords(
  dir: string,
  processName: string
): Record<string, unknown>[] {
  return readFileSync(join(dir, `${processName}.log`), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('createLogger', () => {
  it('writes JSONL to <processName>.log in the logs directory', () => {
    const log = createLogger('api', { logsDir, pretty: false })
    log.info({ route: '/health' }, 'served')

    const records = readRecords(logsDir, 'api')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      process: 'api',
      route: '/health',
      msg: 'served',
    })
  })

  it('tags every record with the process name so merged logs stay attributable', () => {
    createLogger('bot', { logsDir, pretty: false }).warn('rate limited')
    createLogger('worker', { logsDir, pretty: false }).warn('retrying')

    expect(readRecords(logsDir, 'bot')[0]).toMatchObject({ process: 'bot' })
    expect(readRecords(logsDir, 'worker')[0]).toMatchObject({
      process: 'worker',
    })
  })

  it('honours the configured level', () => {
    const log = createLogger('api', { logsDir, level: 'warn', pretty: false })
    log.debug('invisible')
    log.error('visible')

    const records = readRecords(logsDir, 'api')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ msg: 'visible' })
  })

  it('creates the logs directory when it does not exist', () => {
    const nested = join(logsDir, 'deep', 'nested')
    createLogger('api', { logsDir: nested, pretty: false }).info('created')

    expect(readRecords(nested, 'api')).toHaveLength(1)
  })

  it('falls back to LOGS_DIR and LOG_LEVEL from the environment', () => {
    resetConfigCache()
    process.env.NODE_ENV = 'test'
    process.env.PUBLIC_APP_URL = 'https://bloombot.example.edu'
    process.env.LOGS_DIR = logsDir
    process.env.LOG_LEVEL = 'error'

    const log = createLogger('api', { pretty: false })
    log.info('below threshold')
    log.error('at threshold')

    const records = readRecords(logsDir, 'api')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ msg: 'at threshold' })
  })

  it('rejects an empty process name rather than writing to `.log`', () => {
    expect(() => createLogger('  ', { logsDir })).toThrow(
      /non-empty process name/
    )
  })
})

describe('import-time side effects (PLAT-5)', () => {
  it('imports cleanly even when the environment is invalid', async () => {
    // If the module read CONFIG, opened a destination or created a directory at
    // module scope, this import would throw: the environment below is missing
    // PUBLIC_APP_URL, which the schema requires. Importing must stay free.
    resetConfigCache()
    delete process.env.PUBLIC_APP_URL

    vi.resetModules()
    const module = await import('@bloombot/logger')
    expect(typeof module.createLogger).toBe('function')

    // Only at first use does the environment matter — and then it fails loudly.
    expect(() => module.createLogger('api')).toThrow(/PUBLIC_APP_URL/)
  })
})
