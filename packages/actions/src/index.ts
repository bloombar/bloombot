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
  duplicateProjectAction,
  enableCourseAction,
  getCourseAction,
  getJobAction,
  listCoursesAction,
  listDiscordServersAction,
  listProjectsAction,
  organizationUsageAction,
  removeDiscordServerAction,
  saveCourseAction,
  scaffoldDiscordServerAction,
  unarchiveProjectAction,
  type JobStatus,
  type OrganizationUsageReport,
} from './actions/index.js'
// Rework finding 5: `redeemCourseJoinLink` is not a dispatched `Action` (see
// `actions/course-join-links.ts`'s own module comment), so it is never
// reachable through `createPlatformRegistry`/`dispatch` the way every other
// action here is — this package's own root export is the only door in, and
// `package.json`'s `exports` field exposes only this one entry point, so an
// app importing `@bloombot/actions` deeply for it would fail to resolve at
// all. `redeemCourseJoinLinkForWebAccount` (ENRL-8) and
// `redeemMembershipInvitationForWebAccount` (ENRL-10) are the same shape,
// for the same reason, and re-exported here alongside it.
export {
  redeemCourseJoinLink,
  redeemCourseJoinLinkForWebAccount,
} from './actions/index.js'
export { redeemMembershipInvitationForWebAccount } from './actions/index.js'

export {
  checkPlatformHealth,
  type CheckPlatformHealthOptions,
  type PlatformHealthReport,
  type ProcessHealth,
} from './monitoring.js'
