/**
 * CORE-2: attribute one arriving message to exactly one course.
 *
 * Mirrors `response_bot.py`'s two routing signals, in the same order —
 * `find_course_by_category` first, `find_course_by_roles` (BOT-12's fixed
 * version, matching both `admins` and `students`) as the fallback — but adds
 * what the Python bot never checked: a category or role that matches more
 * than one course is reported as an ambiguity rather than silently resolved
 * to whichever course happened to be first in the list (`find_course_by_category`
 * and `find_course_by_roles` both `return` on the first match they find).
 * PROJ-3 already refuses to *save* a category or role name that collides
 * with another enabled course, so this should be unreachable in ordinary
 * operation — it exists for the states PROJ-3's check does not reach today
 * (a course in an archived project, `repos/courses.ts`'s own comment) rather
 * than as a case this function expects to see often.
 */

/** The shape a course needs to be routed by — just the fields the two signals below read. */
export interface RoutableCourse {
  id: string
  categoryNames: string[]
  adminsRole: string
  studentsRole: string
}

/** What arrived: the Discord category and channel the message's channel sits in, and the author's role names. */
export interface ArrivalContext {
  /** `null` for a DM or an uncategorized channel — the case BOT-3's fallback exists for. */
  categoryName: string | null
  /** Not used to route (neither Python signal reads it) — carried through for the caller's own logging, the same context `response_bot.py`'s own log lines include. */
  channelName: string | null
  roleNames: string[]
}

/** More than one course claimed the same signal — CORE-2's "configuration error the platform reports rather than a choice it makes quietly." */
export interface RoutingAmbiguity {
  kind: 'ambiguous'
  /** Which signal produced the collision. */
  signal: 'category' | 'role'
  /** Every course that matched, so the report can name all of them, not just the one that would have won by accident. */
  courseIds: string[]
}

export type RoutingResult =
  | { kind: 'matched'; course: RoutableCourse }
  | { kind: 'unmatched' }
  | RoutingAmbiguity

/**
 * Route one message. Category first (BOT-2): every course whose
 * `categoryNames` contains `arrival.categoryName` is a candidate, and one
 * candidate is a match, more than one is an ambiguity — reported for that
 * signal without ever falling through to roles, since the category *did*
 * produce an answer, just not a usable one. Zero candidates falls back to
 * roles (BOT-3/BOT-12): a course is a candidate if the author holds either
 * its `adminsRole` or its `studentsRole`, with the same one-vs-many
 * treatment. Zero candidates on both signals is `unmatched` (BOT-4).
 */
export function routeMessage(
  courses: RoutableCourse[],
  arrival: ArrivalContext
): RoutingResult {
  if (arrival.categoryName !== null) {
    const categoryMatches = courses.filter((course) =>
      course.categoryNames.includes(arrival.categoryName as string)
    )
    if (categoryMatches.length > 1) {
      return {
        kind: 'ambiguous',
        signal: 'category',
        courseIds: categoryMatches.map((course) => course.id),
      }
    }
    if (categoryMatches.length === 1) {
      // noUncheckedIndexedAccess: length === 1 already proves this exists.
      return { kind: 'matched', course: categoryMatches[0] as RoutableCourse }
    }
  }

  const roleNames = new Set(arrival.roleNames)
  const roleMatches = courses.filter(
    (course) =>
      roleNames.has(course.adminsRole) || roleNames.has(course.studentsRole)
  )
  if (roleMatches.length > 1) {
    return {
      kind: 'ambiguous',
      signal: 'role',
      courseIds: roleMatches.map((course) => course.id),
    }
  }
  if (roleMatches.length === 1) {
    return { kind: 'matched', course: roleMatches[0] as RoutableCourse }
  }

  return { kind: 'unmatched' }
}
