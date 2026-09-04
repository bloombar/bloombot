/** Public surface of `@bloombot/schemas`. */

export {
  legacyBotConfigSchema,
  legacyCategorySchema,
  legacyChannelSchema,
  legacyCourseSchema,
  legacyOpenAiAssistantSchema,
  legacyRolesSchema,
  type LegacyBotConfig,
  type LegacyCategory,
  type LegacyChannel,
  type LegacyChannelInput,
  type LegacyCourse,
  type LegacyOpenAiAssistant,
  type LegacyRoles,
} from './legacy-yaml.js'

export {
  parseRosterCsv,
  rosterRowSchema,
  type RosterParseError,
  type RosterParseResult,
  type RosterRow,
} from './roster.js'

export {
  normalizeWebSourceDomain,
  type WebSourceDomainResult,
} from './web-source-domain.js'
