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
  listDiscordServersAction,
  removeDiscordServerAction,
  scaffoldDiscordServerAction,
} from './discord-servers.js'
import { getJobAction } from './jobs.js'

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
  listDiscordServersAction,
  removeDiscordServerAction,
  scaffoldDiscordServerAction,
} from './discord-servers.js'
export { getJobAction, type JobStatus } from './jobs.js'

/** Every action this slice ports, registered once. */
export function createPlatformRegistry(): ActionRegistry {
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
  return registry
}
