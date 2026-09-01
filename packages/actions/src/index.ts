/** Public surface of `@bloombot/actions`. */

export { dispatch, type DispatchContext } from './dispatch.js'
export { ActionRegistry, type CatalogEntry } from './registry.js'
export type { AccessDescriptor, Policy, PolicyContext } from './policy.js'
export type {
  Action,
  AnyAction,
  ExecuteContext,
  Meter,
  MeterContext,
} from './types.js'
export {
  ActionConflictError,
  ActionInputError,
  ActionRefusedError,
  UnknownActionError,
  HTTP_STATUS_BY_ACTION_ERROR,
} from './errors.js'

export {
  archiveProjectAction,
  createPlatformRegistry,
  createProjectAction,
  disableCourseAction,
  enableCourseAction,
  saveCourseAction,
  unarchiveProjectAction,
} from './actions/index.js'
