/** Public surface of `@bloombot/legacy-import`. */

export { runImport, closeDatabase, reportHasUnplaced } from './import.js'
export type { RunImportOptions, ImportReport } from './import.js'

export {
  assertLegacySnapshotPath,
  assertImportDestinationPath,
} from './guard.js'
export { deterministicId } from './ids.js'

export {
  openLegacySnapshot,
  readLegacyUsers,
  readLegacyMessages,
  parseLegacyTimestamp,
} from './read-legacy.js'
export type { LegacyUser, LegacyMessage } from './read-legacy.js'

export { importConfig, loadLegacyConfig } from './import-config.js'
export type {
  CourseImportOutcome,
  ImportConfigResult,
  ImportConfigOptions,
} from './import-config.js'

export { importPeople } from './import-people.js'
export type { PersonImportOutcome } from './import-people.js'

export { importMessages, loadRoutableCourses } from './import-messages.js'
export type {
  UnplaceableMessage,
  DuplicateCategory,
  ImportMessagesResult,
  RoutableCourse,
} from './import-messages.js'
