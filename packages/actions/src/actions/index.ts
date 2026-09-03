/**
 * Every action this slice ports (ACT-1), and `createPlatformRegistry`, which
 * builds one `ActionRegistry` (`registry.ts`) with all of them registered.
 *
 * A factory function rather than a module-level registry: building the
 * registry is cheap and side-effect-free either way, but a factory lets a
 * test build its own instance instead of sharing (and so, across test
 * files, potentially double-registering into) one the platform also uses —
 * and it keeps this package consistent with PLAT-5's "nothing happens at
 * import time" convention even though nothing here would actually violate
 * it either way.
 */

import { createFilesystemAttachmentStorage } from '@bloombot/db'

import { ActionRegistry } from '../registry.js'
import {
  archiveProjectAction,
  createProjectAction,
  duplicateProjectAction,
  listProjectsAction,
  unarchiveProjectAction,
} from './projects.js'
import {
  disableCourseAction,
  enableCourseAction,
  getCourseAction,
  listCoursesAction,
  saveCourseAction,
} from './courses.js'
import {
  createAttachCourseAttachmentAction,
  detachCourseAttachmentAction,
  listCourseAttachmentsAction,
} from './course-attachments.js'
import {
  listCourseInstructionRevisionsAction,
  restoreCourseInstructionRevisionAction,
  saveCourseInstructionsAction,
} from './course-instructions.js'
import {
  listDiscordServersAction,
  removeDiscordServerAction,
  scaffoldDiscordServerAction,
} from './discord-servers.js'
import { getJobAction } from './jobs.js'
import { importRosterAction } from './roster.js'
import { organizationUsageAction } from './cost-ledger.js'
import {
  createCourseJoinLinkAction,
  listCourseJoinLinksAction,
  revokeCourseJoinLinkAction,
} from './course-join-links.js'
import {
  checkEnrolmentAccessAction,
  endEnrolmentAction,
  listEnrolmentsForCourseAction,
  listEnrolmentsForPersonAction,
  reinstateEnrolmentAction,
} from './enrolments.js'
import { grantMembershipAction } from './memberships.js'
import {
  exportTranscriptAction,
  listTranscriptExportsAction,
  listTranscriptStudentsAction,
  readTranscriptAction,
} from './transcripts.js'

export {
  archiveProjectAction,
  createProjectAction,
  duplicateProjectAction,
  listProjectsAction,
  unarchiveProjectAction,
} from './projects.js'
export {
  disableCourseAction,
  enableCourseAction,
  getCourseAction,
  listCoursesAction,
  saveCourseAction,
} from './courses.js'
export {
  createAttachCourseAttachmentAction,
  detachCourseAttachmentAction,
  listCourseAttachmentsAction,
} from './course-attachments.js'
export {
  listCourseInstructionRevisionsAction,
  restoreCourseInstructionRevisionAction,
  saveCourseInstructionsAction,
} from './course-instructions.js'
export {
  listDiscordServersAction,
  removeDiscordServerAction,
  scaffoldDiscordServerAction,
} from './discord-servers.js'
export { getJobAction, type JobStatus } from './jobs.js'
export { importRosterAction } from './roster.js'
export {
  organizationUsageAction,
  type OrganizationUsageReport,
} from './cost-ledger.js'
export {
  createCourseJoinLinkAction,
  listCourseJoinLinksAction,
  revokeCourseJoinLinkAction,
  redeemCourseJoinLink,
  redeemCourseJoinLinkForWebAccount,
  type CreatedCourseJoinLink,
  type CourseJoinLinkSummary,
} from './course-join-links.js'
export {
  checkEnrolmentAccessAction,
  endEnrolmentAction,
  listEnrolmentsForCourseAction,
  listEnrolmentsForPersonAction,
  reinstateEnrolmentAction,
} from './enrolments.js'
export { grantMembershipAction } from './memberships.js'
export {
  exportTranscriptAction,
  listTranscriptExportsAction,
  listTranscriptStudentsAction,
  readTranscriptAction,
} from './transcripts.js'

/**
 * Every action this slice ports, registered once.
 *
 * `attachmentStorageDir` (FILE-1..5) is the one dependency any action here
 * needs beyond `organizationId`/`db` — `createAttachCourseAttachmentAction`'s
 * own module comment has why. Deliberately *not* left to `AttachmentStorage`'s
 * own `CONFIG.ATTACHMENT_STORAGE_DIR` default when omitted here: this
 * package holds no dependency on `@bloombot/config` at all (the same
 * "dependencies as arguments, only the process reads `CONFIG`" discipline
 * `docs/DECISIONS.md` already holds `packages/core` to), and this
 * package's own tests run in an environment that does not set every
 * variable `@bloombot/config`'s schema requires — reaching `CONFIG` at all
 * from a zero-arg call would fail those tests for a reason that has
 * nothing to do with what they are testing.
 *
 * The literal fallback below is `'./tmp/attachments'`, **not**
 * `ATTACHMENT_STORAGE_DIR`'s own schema default (`'./data/attachments'`,
 * `packages/config/src/env.ts`) — a rework finding: a caller that forgets
 * to thread `attachmentStorageDir` (an earlier revision of `apps/api`'s own
 * test helper and the e2e harness both did) used to fall through to that
 * literal and write real course material into `data/`, the same directory
 * `data/*.db` is protected for holding real students' names, emails and
 * conversations. A real deployment never reaches this fallback at all:
 * `apps/api/src/index.ts` always threads `CONFIG.ATTACHMENT_STORAGE_DIR`
 * through explicitly, the same way it already threads every other `CONFIG`
 * value it reads once, at startup — so this default only ever runs for a
 * caller that supplied nothing, which today means only a test, and a test
 * belongs under `tmp/`, never `data/` (see `docs/DECISIONS.md` D-32).
 */
export function createPlatformRegistry(options?: {
  attachmentStorageDir?: string
}): ActionRegistry {
  const attachmentStorage = createFilesystemAttachmentStorage(
    options?.attachmentStorageDir ?? './tmp/attachments'
  )

  const registry = new ActionRegistry()
  registry.register(createProjectAction)
  registry.register(archiveProjectAction)
  registry.register(unarchiveProjectAction)
  registry.register(listProjectsAction)
  registry.register(duplicateProjectAction)
  registry.register(saveCourseAction)
  registry.register(enableCourseAction)
  registry.register(disableCourseAction)
  registry.register(listCoursesAction)
  registry.register(getCourseAction)
  registry.register(removeDiscordServerAction)
  registry.register(listDiscordServersAction)
  registry.register(scaffoldDiscordServerAction)
  registry.register(getJobAction)
  registry.register(importRosterAction)
  registry.register(createAttachCourseAttachmentAction(attachmentStorage))
  registry.register(listCourseAttachmentsAction)
  registry.register(detachCourseAttachmentAction)
  registry.register(saveCourseInstructionsAction)
  registry.register(listCourseInstructionRevisionsAction)
  registry.register(restoreCourseInstructionRevisionAction)
  registry.register(organizationUsageAction)
  registry.register(createCourseJoinLinkAction)
  registry.register(listCourseJoinLinksAction)
  registry.register(revokeCourseJoinLinkAction)
  registry.register(listEnrolmentsForPersonAction)
  registry.register(checkEnrolmentAccessAction)
  registry.register(endEnrolmentAction)
  registry.register(reinstateEnrolmentAction)
  registry.register(listEnrolmentsForCourseAction)
  registry.register(grantMembershipAction)
  registry.register(readTranscriptAction)
  registry.register(listTranscriptStudentsAction)
  registry.register(exportTranscriptAction)
  registry.register(listTranscriptExportsAction)
  return registry
}
