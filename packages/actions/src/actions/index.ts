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
import { getJobAction, listJobsAction } from './jobs.js'
import { importRosterAction } from './roster.js'
import { organizationUsageAction, setSpendingCapAction } from './cost-ledger.js'
import {
  createCourseJoinLinkAction,
  createRevealCourseJoinLinkAction,
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
import {
  grantMembershipAction,
  listMembershipsAction,
  revokeMembershipAction,
} from './memberships.js'
import {
  createMembershipInvitationAction,
  listMembershipInvitationsAction,
  revokeMembershipInvitationAction,
} from './membership-invitations.js'
import {
  exportTranscriptAction,
  listTranscriptAccessLogAction,
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
export { getJobAction, listJobsAction, type JobStatus } from './jobs.js'
export { importRosterAction } from './roster.js'
export {
  organizationUsageAction,
  setSpendingCapAction,
  type OrganizationUsageReport,
  type SetSpendingCapResult,
} from './cost-ledger.js'
export {
  createCourseJoinLinkAction,
  createRevealCourseJoinLinkAction,
  listCourseJoinLinksAction,
  revokeCourseJoinLinkAction,
  redeemCourseJoinLink,
  redeemCourseJoinLinkForWebAccount,
  type CreatedCourseJoinLink,
  type CourseJoinLinkSummary,
  type RevealedCourseJoinLink,
} from './course-join-links.js'
export {
  checkEnrolmentAccessAction,
  endEnrolmentAction,
  listEnrolmentsForCourseAction,
  listEnrolmentsForPersonAction,
  reinstateEnrolmentAction,
} from './enrolments.js'
export {
  grantMembershipAction,
  listMembershipsAction,
  revokeMembershipAction,
  type MembershipEntry,
} from './memberships.js'
export {
  createMembershipInvitationAction,
  listMembershipInvitationsAction,
  revokeMembershipInvitationAction,
  redeemMembershipInvitationForWebAccount,
  type CreatedMembershipInvitation,
  type MembershipInvitationSummary,
} from './membership-invitations.js'
export {
  exportTranscriptAction,
  listTranscriptAccessLogAction,
  listTranscriptExportsAction,
  listTranscriptStudentsAction,
  readTranscriptAction,
  type TranscriptAccessLogRow,
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
 *
 * `joinLinkEncryptionKey` (ENRL-12) is the same class of dependency
 * `attachmentStorageDir` above already is — a credential (CFG-5) this
 * package has no way to read for itself (`course-join-links.ts`'s own
 * module comment) — but, unlike `attachmentStorageDir`, has no fallback
 * here: omitted, `createCourseJoinLinkAction`/`createRevealCourseJoinLinkAction`
 * are simply built with no key, which is exactly the "no key configured"
 * behaviour ENRL-12 requires (creation and the one-time reveal work as
 * before; `courseJoinLinks.reveal` always refuses). `apps/api/src/index.ts`
 * always threads its own decoded `JOIN_LINK_ENCRYPTION_KEY` through
 * explicitly when one is set, the same as every other `CONFIG`/credential
 * value it reads once and passes down.
 */
export function createPlatformRegistry(options?: {
  attachmentStorageDir?: string
  joinLinkEncryptionKey?: Buffer
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
  registry.register(listJobsAction)
  registry.register(importRosterAction)
  registry.register(createAttachCourseAttachmentAction(attachmentStorage))
  registry.register(listCourseAttachmentsAction)
  registry.register(detachCourseAttachmentAction)
  registry.register(saveCourseInstructionsAction)
  registry.register(listCourseInstructionRevisionsAction)
  registry.register(restoreCourseInstructionRevisionAction)
  registry.register(organizationUsageAction)
  registry.register(setSpendingCapAction)
  registry.register(createCourseJoinLinkAction(options?.joinLinkEncryptionKey))
  registry.register(listCourseJoinLinksAction)
  registry.register(revokeCourseJoinLinkAction)
  registry.register(
    createRevealCourseJoinLinkAction(options?.joinLinkEncryptionKey)
  )
  registry.register(listEnrolmentsForPersonAction)
  registry.register(checkEnrolmentAccessAction)
  registry.register(endEnrolmentAction)
  registry.register(reinstateEnrolmentAction)
  registry.register(listEnrolmentsForCourseAction)
  registry.register(grantMembershipAction)
  registry.register(listMembershipsAction)
  registry.register(revokeMembershipAction)
  registry.register(createMembershipInvitationAction)
  registry.register(listMembershipInvitationsAction)
  registry.register(revokeMembershipInvitationAction)
  registry.register(readTranscriptAction)
  registry.register(listTranscriptStudentsAction)
  registry.register(exportTranscriptAction)
  registry.register(listTranscriptExportsAction)
  registry.register(listTranscriptAccessLogAction)
  return registry
}
