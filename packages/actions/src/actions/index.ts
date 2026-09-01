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
  unarchiveProjectAction,
} from './projects.js'
import {
  disableCourseAction,
  enableCourseAction,
  saveCourseAction,
} from './courses.js'

export {
  archiveProjectAction,
  createProjectAction,
  unarchiveProjectAction,
} from './projects.js'
export {
  disableCourseAction,
  enableCourseAction,
  saveCourseAction,
} from './courses.js'

/** Every action this slice ports, registered once. */
export function createPlatformRegistry(): ActionRegistry {
  const registry = new ActionRegistry()
  registry.register(createProjectAction)
  registry.register(archiveProjectAction)
  registry.register(unarchiveProjectAction)
  registry.register(saveCourseAction)
  registry.register(enableCourseAction)
  registry.register(disableCourseAction)
  return registry
}
