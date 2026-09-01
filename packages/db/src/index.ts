/** Public surface of `@bloombot/db`. */

export {
  openDatabase,
  closeDatabase,
  type Database,
  type Executor,
  type TransactingExecutor,
} from './client.js'
export { runMigrations } from './migrate.js'
export { resolveReal, repoDataDir, isUnderRepoData } from './path-guard.js'
export * as schema from './schema.js'

export * as organizations from './repos/organizations.js'
export * as accounts from './repos/accounts.js'
export * as memberships from './repos/memberships.js'
export * as discordServers from './repos/discord-servers.js'
export * as projects from './repos/projects.js'
export * as courses from './repos/courses.js'
export * as people from './repos/people.js'
export * as conversations from './repos/conversations.js'
export * as usage from './repos/usage.js'
export * as signInTokens from './repos/sign-in-tokens.js'
export * as sessions from './repos/sessions.js'
export * as discordInstallStates from './repos/discord-install-states.js'
export * as jobs from './repos/jobs.js'
