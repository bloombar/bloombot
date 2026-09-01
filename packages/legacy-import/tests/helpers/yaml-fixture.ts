/** Test helper: write a `bot_config.yml`-shaped fixture to `tmp/` and return its path. */

import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { stringify } from 'yaml'

const TMP_ROOT = join(process.cwd(), 'tmp', 'legacy-import-tests')

export function writeLegacyYamlFixture(config: unknown): {
  path: string
  cleanup: () => void
} {
  mkdirSync(TMP_ROOT, { recursive: true })
  const path = join(TMP_ROOT, `${randomUUID()}-bot_config.yml`)
  writeFileSync(path, stringify(config), 'utf8')
  return { path, cleanup: () => rmSync(path, { force: true }) }
}
