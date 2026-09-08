/**
 * Structured logging for every Bloombot process (BOT-10, OPS-3).
 *
 * One JSONL file per process under `LOGS_DIR`, so `api.log`, `bot.log` and
 * `worker.log` stay separable when they are tailed together, plus human-readable
 * stdout while developing.
 *
 * Nothing here runs at import time (PLAT-5): no directory is created, no file is
 * opened and nothing is written to stdout until `createLogger` is actually
 * called. Importing this module from a test, a script or a type-only context is
 * therefore free of side effects.
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { CONFIG } from '@bloombot/config'
import pino, { type Logger } from 'pino'
import prettyStream from 'pino-pretty'

/** Overrides for a single logger. Anything omitted comes from the environment. */
export interface CreateLoggerOptions {
  /** Directory to write `<processName>.log` into. Defaults to `LOGS_DIR`. */
  logsDir?: string
  /** Minimum level to record. Defaults to `LOG_LEVEL`. */
  level?: string
  /** Also write human-readable lines to stdout. Defaults to development only. */
  pretty?: boolean
}

export type { Logger }

/**
 * Build a logger for one process.
 *
 * @param processName Used both as the log file's basename and as a `process`
 *   field on every record, so lines stay attributable once files are merged.
 */
export function createLogger(
  processName: string,
  options: CreateLoggerOptions = {}
): Logger {
  if (!processName.trim()) {
    throw new Error('createLogger requires a non-empty process name')
  }

  // Reading CONFIG here rather than at module scope is what keeps this file free
  // of import-time side effects; the environment is validated on first use.
  const logsDir = options.logsDir ?? CONFIG.LOGS_DIR
  const level = options.level ?? CONFIG.LOG_LEVEL
  const pretty = options.pretty ?? CONFIG.NODE_ENV === 'development'

  mkdirSync(logsDir, { recursive: true })

  // `sync: true` costs throughput this system will never notice, and buys the
  // guarantee that a line is on disk before the process that logged it exits —
  // which matters most for the crash that made you read the log.
  const streams: pino.StreamEntry[] = [
    {
      level: level as pino.Level,
      stream: pino.destination({
        dest: join(logsDir, `${processName}.log`),
        sync: true,
      }),
    },
  ]

  if (pretty) {
    streams.push({
      level: level as pino.Level,
      stream: prettyStream({ colorize: true, translateTime: 'SYS:HH:MM:ss.l' }),
    })
  }

  return pino(
    { level, base: { process: processName } },
    pino.multistream(streams)
  )
}
