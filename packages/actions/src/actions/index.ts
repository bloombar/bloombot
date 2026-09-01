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
 * nothing to do with what they are testing. The literal fallback below
 * matches `ATTACHMENT_STORAGE_DIR`'s own schema default
 * (`packages/config/src/env.ts`) — a real deployment always threads
 * `CONFIG.ATTACHMENT_STORAGE_DIR` through explicitly instead
 * (`apps/api/src/index.ts`), the same way it already threads every other
 * `CONFIG` value it reads once, at startup, so the two are expected to
 * agree, not merely happen to.
 */
export function createPlatformRegistry(options?: {
  attachmentStorageDir?: string
}): ActionRegistry {
  const attachmentStorage = createFilesystemAttachmentStorage(
    options?.attachmentStorageDir ?? './data/attachments'
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
  return registry
}
