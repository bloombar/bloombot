/**
 * `drizzle-kit generate` configuration.
 *
 * Only used to turn `src/schema.ts` into the SQL files under `migrations/` —
 * the running process never imports this file. The `dbCredentials.url` here is
 * a placeholder `drizzle-kit` never opens for `generate`; the real, lazily-
 * opened connection is `src/client.ts`'s `openDatabase`.
 */

import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: './migrations/.generate-placeholder.db',
  },
})
