/**
 * The platform-administrator console (ADMIN-4, ADMIN-5, ADMIN-6) —
 * organizations, their usage and their health, and the one operation that
 * removes a tenant's data entirely.
 *
 * Mounted at `/admin`, not under `/organizations/:organizationId/...`: a
 * platform administrator is not "acting within" any one tenant
 * (`costLedger.listOrganizationTotals`'s own module comment already draws
 * this line for COST-4's platform-wide read), so this is not reached
 * through `routes/actions.ts`'s generic dispatcher — the same reason
 * `docs/DECISIONS.md` D-33 gives for why `listOrganizationTotals` and
 * `checkPlatformHealth` are plain functions outside `dispatch.ts` in the
 * first place, and the same paragraph that names this router as the one
 * that has to add its own administrator check and its own audit trail
 * rather than assuming either already exists.
 *
 * **Every route here re-checks `isPlatformAdministrator` itself, on every
 * request** (AUTH-4's own "read on every check rather than captured at
 * startup") — there is no membership check to lean on the way
 * `routes/actions.ts`/`routes/discord-servers.ts` do, because platform
 * administration is deliberately not a membership at all (AUTH-4's own
 * "never a self-granted role or a database flag").
 *
 * **ADMIN-4's own boundary, enforced by what this file does not import**:
 * nothing here reaches `transcriptAccess`, `conversations`, `messages`,
 * `people` or `courseJoinLinks`. Since WEB-53, that boundary is narrower
 * than "never a course" — `GET /courses` lists every course's own identity
 * (its title, its project, its organization, its owner's email) and its
 * approval state, and, since ADMIN-6, `GET /courses/:courseId` (below)
 * reads one course's own settings in full — general, AI and knowledge —
 * because deciding COST-8's approval is the one thing ADMIN-4 explicitly
 * admits this console to (the amended requirement, `docs/SPEC.md` §26: "the
 * one exception is ADMIN-6 … an administrator may read a course's settings
 * read-only — never its people, transcripts or join links"). A person, a
 * conversation, a message, a transcript or a join link stays out of reach
 * regardless — `GET /courses/:courseId`'s own response shape
 * (`AdminCourseDetail`, below) has no field that could carry one.
 * `tests/routes/admin.test.ts` proves this by attempting a transcript read
 * through this router and asserting it is refused, not merely by asserting
 * the absence of a route (a route that does not exist today says nothing
 * about one that might be added tomorrow without anyone noticing it crossed
 * this boundary).
 *
 * **ADMIN-7..11** add the console's own read model — an organization's, a
 * project's and an account's own screen, and a course's screen widened from
 * ADMIN-6's settings-only read to a full overview (structure, membership and
 * cost, per the amended ADMIN-4, `docs/SPEC.md` §26) — but the boundary
 * above is unchanged: every new response here is still built only from
 * structure, membership and cost, never from `conversations`/`messages`/
 * `courseJoinLinks`, and a course's own people are named (`AdminCourseDetail.people`,
 * below) without ever reaching what any of them said.
 */

import { Router } from 'express'
import { z } from 'zod'

import {
  checkPlatformHealth,
  type PlatformHealthReport,
} from '@bloombot/actions'
import { isPlatformAdministrator } from '@bloombot/auth'
import {
  accounts,
  costLedger,
  courseApproval,
  courseAttachments,
  courses,
  courseWebSources,
  enrolments,
  memberships,
  organizations,
  people,
  projects,
  transcriptExports,
  type AttachmentStorage,
  type Database,
} from '@bloombot/db'
import type { Logger } from '@bloombot/logger'

export interface AdminRouterDependencies {
  db: Database
  logger: Logger
  /** FILE-5's own port, reused here (this router's own module comment on `transcript_exports` sharing it): deleting a tenant removes a course attachment's or a transcript export's own bytes on disk, best-effort, after the database rows they were addressed by are already gone. */
  attachmentStorage: AttachmentStorage
  botHealthUrl: string
  workerHealthUrl: string
  apiHealthUrl: string
  /** Overridable so a test can supply a fake with no real network — `checkPlatformHealth`'s own option, threaded through. */
  fetchFn?: typeof fetch
  /**
   * ADMIN-5's own race with `apps/worker`'s export handler (see that
   * file's own module comment on the full reasoning): an in-flight export
   * job can still be inside `JSON.stringify`/`Buffer.from` — or, narrower
   * still, between its own re-check and its own `attachmentStorage.write`
   * call — at the instant this route's delete transaction runs, so the
   * immediate best-effort sweep below can run before those bytes exist to
   * remove. A second sweep runs after this delay, long enough that any
   * write already past the worker's own re-check has certainly landed by
   * the time it fires. Defaults to five seconds — generous against a
   * worker handler's own bounded `handlerTimeoutMs`; a test overrides this
   * to a few milliseconds rather than waiting five real seconds per case.
   */
  deletedTenantSweepDelayMs?: number
}

/** AUTH-4, re-checked on every request: `undefined` for no session or a disabled/unknown account, `false` for a real, signed-in, non-administrator account. Never cached, never derived from anything but this request's own session and the environment `isPlatformAdministrator` reads live. */
function isRequestFromPlatformAdministrator(
  accountId: string | undefined,
  db: Database
): boolean {
  if (!accountId) return false
  const account = accounts.getAccountById(accountId, db)
  if (!account || account.disabledAt !== null) return false
  return isPlatformAdministrator(account.email)
}

/**
 * ADMIN-4's own read: every organization, its usage (COST-4's platform-wide
 * total) and its health. Health is the *platform's* health (three
 * processes, checked once per request) — the same report for every
 * organization, not per-tenant, since nothing about a process's own
 * reachability is organization-scoped.
 */
export interface AdminOrganizationSummary {
  organizationId: string
  organizationName: string
  totalCostMicros: number
  estimatedCostMicros: number
  callCount: number
  /** COST-7 — the totals above, broken down by surface. */
  bySurface: costLedger.CostBySurface[]
}

export interface AdminOrganizationsResponse {
  organizations: AdminOrganizationSummary[]
  platformHealth: PlatformHealthReport
}

/**
 * WEB-53's own Courses screen row — one course, pending or approved, across
 * every organization. Passed through from `courseApproval.CourseForApproval`
 * (that repo function's own doc comment) with no reshaping: this router's
 * job is authorization and audit, not a second copy of what counts as "the
 * course's identifying detail."
 */
export type AdminCourseSummary = courseApproval.CourseForApproval

export interface AdminCoursesResponse {
  courses: AdminCourseSummary[]
}

/** ADMIN-7/ADMIN-8/ADMIN-11 — the least an account needs to be linked to from another entity's own screen: its id, email and display name, never anything this router's own boundary would not otherwise allow. */
export interface AdminAccountRef {
  accountId: string
  email: string
  displayName: string
}

/**
 * ADMIN-7/ADMIN-8 — one course, as it appears inside a project's or an
 * organization's own console screen: identity, approval state, enrolment
 * count and cost, never its settings (that is `AdminCourseDetail`'s own,
 * wider job, reached by following this row's own link).
 */
export interface AdminCourseBrief {
  courseId: string
  title: string
  enabled: boolean
  aiApprovedAt: number | null
  enrolmentCount: number
  totalCostMicros: number
}

/**
 * ADMIN-7: an organization's own console screen — its identity, its usage
 * (COST-4/COST-7), the accounts that own it, its full membership, and every
 * project it holds with that project's own courses nested inside it, so an
 * administrator reads the whole tenant's shape from one screen rather than
 * following a chain of lists.
 */
export interface AdminOrganizationDetail {
  organizationId: string
  name: string
  isPersonal: boolean
  spendingCapMicros: number | null
  createdAt: number
  usage: {
    totalCostMicros: number
    callCount: number
    hasEstimated: boolean
    bySurface: costLedger.CostBySurface[]
  }
  owners: AdminAccountRef[]
  members: {
    accountId: string
    email: string
    displayName: string
    role: string
    grantedAt: number | null
  }[]
  projects: {
    projectId: string
    name: string
    archivedAt: number | null
    createdAt: number
    courses: AdminCourseBrief[]
  }[]
}

/**
 * ADMIN-8: a project's own console screen — its identity, whether it is
 * archived, its organization (a link back to ADMIN-7's own screen), and its
 * courses, each carrying the same brief `AdminOrganizationDetail`'s own
 * nested projects do.
 */
export interface AdminProjectDetail {
  projectId: string
  name: string
  organizationId: string
  organizationName: string
  archivedAt: number | null
  createdAt: number
  courses: AdminCourseBrief[]
}

/**
 * ADMIN-6 — a Discord category a course routes on, with its channels, as an
 * administrator sees them: names only, the same "declaration, not a live
 * Discord read" shape `courses.getCourse` already returns, reshaped by hand
 * so this router's own boundary (its own module comment) stays visible from
 * this file alone rather than depending on `courses.CourseCategoryWithChannels`
 * never growing a field this response should not carry.
 */
export interface AdminCourseCategory {
  name: string
  channels: { name: string; adminsOnly: boolean }[]
}

/**
 * ADMIN-6 — one of a course's knowledge files, metadata only: never
 * `contentType`, `providerFileId` or `failureReason` — an administrator
 * deciding an approval needs to know a course *has* a file, its name, its
 * size and whether it is grounding answers yet, not the provider's own
 * bookkeeping or why an upload failed, which is the owning organization's
 * own concern to fix, not this console's to read.
 */
export interface AdminCourseAttachment {
  filename: string
  sizeBytes: number
  status: 'pending' | 'ready' | 'failed'
}

/** ADMIN-6 — one of a course's websites: the domain it is grounded in, nothing else. */
export interface AdminCourseWebSource {
  domain: string
}

/** ADMIN-9 — one entry of a course's own approval history (`courseApproval.listApprovalEventsForCourse`), the acting account's email resolved rather than left as a bare id — `null` under the same two conditions `AdminCourseDetail.aiApprovedByEmail` already documents (a pending course, or `'auto-approve'`, which has no human decision-maker). */
export interface AdminCourseApprovalEvent {
  id: string
  action: courseApproval.CourseApprovalEvent['action']
  accountId: string | null
  accountEmail: string | null
  createdAt: number
}

/** ADMIN-9 — one person enrolled in the course: named as WEB-52 names them, when they enrolled, their own usage in the course, and, when they are reachable as a console account, the id to link to (ADMIN-11) — `null` when this person has no `web` identity at all. Never a transcript: nothing here names a conversation or a message. */
export interface AdminCoursePerson {
  personId: string
  displayName: string | null
  email: string | null
  enroledAt: number
  connectedAt: number | null
  accountId: string | null
  totalCostMicros: number
  callCount: number
}

/**
 * ADMIN-6's own read: one course's settings, exactly as its owner would see
 * them in `pages/CourseEditor.tsx` — general, AI and knowledge — with
 * nothing this router does not already allow through its own boundary
 * (this file's own module comment). Never a person, an enrolment, a
 * conversation, a message, a transcript or a join link — there is nothing
 * in this shape that could carry one, the same "narrow by construction"
 * discipline `AdminCourseAttachment` above already holds itself to.
 */
export interface AdminCourseDetail {
  courseId: string
  courseTitle: string
  enabled: boolean
  projectId: string
  projectName: string
  organizationId: string
  organizationName: string
  adminsRole: string | null
  studentsRole: string | null
  categories: AdminCourseCategory[]
  conversationScope: courses.Course['conversationScope']
  model: string | null
  promptId: string | null
  instructions: string | null
  maxRequestsPerDay: number | null
  selfEnrolFromDiscord: boolean
  answerUnenrolled: boolean
  attachments: AdminCourseAttachment[]
  webSources: AdminCourseWebSource[]
  // COST-8's own approval state, the same fields `AdminCourseSummary`
  // already carries — repeated here rather than nested, so this response
  // does not ask a caller that only wants one course to also parse the
  // list's own row shape.
  aiApprovedAt: number | null
  aiApprovedByAccountId: string | null
  aiApprovedByEmail: string | null
  aiApprovalDecidedAt: number | null
  // ADMIN-9's own widening from ADMIN-6's settings-only read: the course's
  // approval history and its usage (COST-4/COST-7), and the people enrolled
  // in it (WEB-52's own naming) with their own usage — never a transcript
  // (this router's own module comment on the boundary).
  approvalEvents: AdminCourseApprovalEvent[]
  usage: {
    totalCostMicros: number
    callCount: number
    bySurface: costLedger.CostBySurface[]
  }
  people: AdminCoursePerson[]
}

/**
 * ADMIN-10 — one row of `GET /admin/accounts`'s own list: name, email, when
 * it joined, whether it is disabled, how many organizations it belongs to
 * and its total cost. Never a person, an enrolment or anything this
 * router's own boundary would not otherwise allow.
 */
export interface AdminAccountSummary {
  accountId: string
  email: string
  displayName: string
  firstName: string | null
  lastName: string | null
  createdAt: number
  disabledAt: number | null
  isPlatformAdministrator: boolean
  organizationCount: number
  totalCostMicros: number
}

export interface AdminAccountsResponse {
  accounts: AdminAccountSummary[]
}

/** ADMIN-11 — one organization `AdminAccountDetail.memberships` names, with the account's own role in it. */
export interface AdminAccountMembership {
  organizationId: string
  organizationName: string
  role: string
  grantedAt: number | null
}

/** ADMIN-11 — one organization `AdminAccountDetail.connectedOrganizations` names — a proven identity (LINK-3/LINK-4), not a membership (TEN-1). */
export interface AdminAccountConnectedOrganization {
  organizationId: string
  organizationName: string
  personId: string
}

/** ADMIN-11 — one person record (PPL-1) `AdminAccountDetail.people` names, with every identity it has been proven on (PPL-2). */
export interface AdminAccountPerson {
  personId: string
  organizationId: string
  organizationName: string
  displayName: string | null
  email: string | null
  githubHandle: string | null
  connectedAt: number | null
  createdAt: number
  identities: { surface: string; externalId: string; createdAt: number }[]
}

/** ADMIN-11 — one course `AdminAccountDetail.enrolments` names, across any organization the account's own people are enrolled in. */
export interface AdminAccountEnrolment {
  courseId: string
  courseTitle: string
  projectId: string
  projectName: string
  organizationId: string
  organizationName: string
  enroledAt: number
}

/**
 * ADMIN-11: an account's own console screen — its identity, its
 * organizations (membership and merely-connected alike), the courses its
 * own people are enrolled in, the people records themselves (PPL-1), and its
 * activity — total cost and call count, broken down by surface and by
 * course, and when it was last active. As ADMIN-4 requires, none of this
 * reaches a transcript.
 */
export interface AdminAccountDetail {
  accountId: string
  email: string
  displayName: string
  firstName: string | null
  lastName: string | null
  createdAt: number
  disabledAt: number | null
  isPlatformAdministrator: boolean
  memberships: AdminAccountMembership[]
  connectedOrganizations: AdminAccountConnectedOrganization[]
  people: AdminAccountPerson[]
  enrolments: AdminAccountEnrolment[]
  usage: costLedger.AccountUsageSummary
}

// ADMIN-5's own race — `AdminRouterDependencies.deletedTenantSweepDelayMs`'s
// own doc comment has the full reasoning for the value.
const DEFAULT_DELETED_TENANT_SWEEP_DELAY_MS = 5_000

/**
 * Removes `ids` from `attachmentStorage` under `organizationId`, one call
 * per id, logging rather than throwing on an individual failure — the same
 * "a byte this pass fails to remove is not a privacy leak reachable
 * through this platform" reasoning the delete route's own comment gives,
 * shared here since both the immediate and the delayed sweep run exactly
 * this. Returns once every removal has settled (never rejects — each is
 * caught individually) so the *immediate* pass can be awaited before the
 * response is sent, proving to a caller that a byte already on disk at
 * delete time is actually gone by the time `200` comes back, not merely
 * scheduled to be; the *delayed* pass (below) still does not await this,
 * since the response is long gone by the time it runs.
 */
async function sweepStorage(
  deps: AdminRouterDependencies,
  organizationId: string,
  ids: string[]
): Promise<void> {
  await Promise.all(
    ids.map((id) =>
      deps.attachmentStorage
        .remove(organizationId, id)
        .catch((error: unknown) =>
          deps.logger.warn(
            { err: error, organizationId, id },
            'apps/api: could not remove a deleted tenant’s stored bytes'
          )
        )
    )
  )
}

/**
 * ADMIN-7/ADMIN-8 — `AdminCourseBrief[]` for `courseRows`, from the two
 * already-batched reads both `GET /organizations/:organizationId` and
 * `GET /projects/:projectId` share: `enrolmentCounts` (`enrolments.countActiveEnrolmentsByCourse`)
 * and `usageSummary` (`costLedger.getOrganizationUsageSummary`) are each one
 * query for the whole organization, looked up here by map rather than
 * queried again per course — the "watch N+1" discipline this router's own
 * brief calls out, the same "batch the fan-out" style
 * `course-approval.ts#listCoursesForApproval` already uses for its own
 * owner-email lookup.
 */
function buildCourseBriefs(
  courseRows: courses.Course[],
  enrolmentCounts: enrolments.CourseEnrolmentCount[],
  usageSummary: costLedger.OrganizationUsageSummary
): AdminCourseBrief[] {
  const enrolmentCountByCourseId = new Map(
    enrolmentCounts.map((row) => [row.courseId, row.count])
  )
  const usageByCourseId = new Map(
    usageSummary.courses.map((row) => [row.courseId, row])
  )
  return courseRows.map((course) => ({
    courseId: course.id,
    title: course.title,
    enabled: course.enabled,
    aiApprovedAt: course.aiApprovedAt,
    enrolmentCount: enrolmentCountByCourseId.get(course.id) ?? 0,
    totalCostMicros: usageByCourseId.get(course.id)?.costMicros ?? 0,
  }))
}

export function buildAdminRouter(deps: AdminRouterDependencies): Router {
  const router = Router()

  /** ADMIN-4: organizations, their usage, and the platform's health. */
  router.get('/organizations', (req, res, next) => {
    if (!req.session) {
      res.status(401).json({ error: 'not_signed_in' })
      return
    }
    if (!isRequestFromPlatformAdministrator(req.session.accountId, deps.db)) {
      res.status(403).json({ error: 'not_platform_administrator' })
      return
    }

    const totals = costLedger.listOrganizationTotals(deps.db)
    checkPlatformHealth({
      botHealthUrl: deps.botHealthUrl,
      workerHealthUrl: deps.workerHealthUrl,
      apiHealthUrl: deps.apiHealthUrl,
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
    })
      .then((platformHealth) => {
        const body: AdminOrganizationsResponse = {
          organizations: totals.map((total) => ({
            organizationId: total.organizationId,
            organizationName: total.organizationName,
            totalCostMicros: total.totalCostMicros,
            estimatedCostMicros: total.estimatedCostMicros,
            callCount: total.callCount,
            bySurface: total.bySurface, // COST-7
          })),
          platformHealth,
        }
        res.status(200).json(body)
      })
      .catch(next)
  })

  /**
   * ADMIN-7: one organization's own console screen — its identity, its
   * usage, the accounts that own it, its full membership, and every project
   * it holds with that project's own courses nested inside it.
   *
   * `members`/`owners` both come from `memberships.listMembershipsForOrganizationWithAccounts`
   * — one join, not `listMembershipsForOrganization`'s bare rows plus a
   * `getAccountById` per member. `owners` is that same list filtered to the
   * `owner` role, not a second query.
   */
  router.get<{ organizationId: string }>(
    '/organizations/:organizationId',
    (req, res) => {
      if (!req.session) {
        res.status(401).json({ error: 'not_signed_in' })
        return
      }
      if (!isRequestFromPlatformAdministrator(req.session.accountId, deps.db)) {
        res.status(403).json({ error: 'not_platform_administrator' })
        return
      }

      const organizationId = req.params.organizationId
      const organization = organizations.getOrganizationById(
        organizationId,
        deps.db
      )
      if (!organization) {
        res.status(404).json({ error: 'organization_not_found' })
        return
      }

      const membershipRows =
        memberships.listMembershipsForOrganizationWithAccounts(
          organizationId,
          deps.db
        )
      const owners: AdminAccountRef[] = membershipRows
        .filter((row) => row.role === 'owner')
        .map((row) => ({
          accountId: row.accountId,
          email: row.email,
          displayName: row.displayName,
        }))

      const usageSummary = costLedger.getOrganizationUsageSummary(
        organizationId,
        deps.db
      )
      const enrolmentCounts = enrolments.countActiveEnrolmentsByCourse(
        organizationId,
        deps.db
      )
      const projectRows = projects.listProjects(organizationId, deps.db, {
        includeArchived: true,
      })
      const allCourseRows = courses.listCourses(organizationId, deps.db)
      const courseBriefs = buildCourseBriefs(
        allCourseRows,
        enrolmentCounts,
        usageSummary
      )
      const courseBriefsByCourseId = new Map(
        courseBriefs.map((brief) => [brief.courseId, brief])
      )
      const courseBriefsByProjectId = new Map<string, AdminCourseBrief[]>()
      for (const course of allCourseRows) {
        const brief = courseBriefsByCourseId.get(course.id)
        if (!brief) continue // Unreachable — `courseBriefs` is built from `allCourseRows` itself.
        const list = courseBriefsByProjectId.get(course.projectId) ?? []
        list.push(brief)
        courseBriefsByProjectId.set(course.projectId, list)
      }

      const body: AdminOrganizationDetail = {
        organizationId: organization.id,
        name: organization.name,
        isPersonal: organization.isPersonal,
        spendingCapMicros: organization.spendingCapMicros,
        createdAt: organization.createdAt,
        usage: {
          totalCostMicros: usageSummary.totalCostMicros,
          // Summed from `bySurface`, not from `usageSummary.courses`
          // (COST-7's own per-course entries) — a course whose own row has
          // since been deleted (PROJ-8 nulls `cost_ledger_entries.course_id`)
          // still contributes to the organization's own total call count,
          // but has no course entry left to sum from.
          callCount: usageSummary.bySurface.reduce(
            (total, entry) => total + entry.callCount,
            0
          ),
          hasEstimated: usageSummary.totalEstimatedCostMicros > 0,
          bySurface: usageSummary.bySurface,
        },
        owners,
        members: membershipRows,
        projects: projectRows.map((project) => ({
          projectId: project.id,
          name: project.name,
          archivedAt: project.archivedAt,
          createdAt: project.createdAt,
          courses: courseBriefsByProjectId.get(project.id) ?? [],
        })),
      }
      res.status(200).json(body)
    }
  )

  /**
   * ADMIN-8: a project's own console screen — its identity, whether it is
   * archived, its organization (a link back to ADMIN-7's own screen), and
   * its courses.
   *
   * `projectId` alone does not name an organization, so this resolves one
   * first through `projects.findProjectOrganizationId` — the same scoped,
   * indexed lookup `course-approval.ts#findCourseOrganizationId` already is
   * for a course, one table up.
   */
  router.get<{ projectId: string }>('/projects/:projectId', (req, res) => {
    if (!req.session) {
      res.status(401).json({ error: 'not_signed_in' })
      return
    }
    if (!isRequestFromPlatformAdministrator(req.session.accountId, deps.db)) {
      res.status(403).json({ error: 'not_platform_administrator' })
      return
    }

    const projectId = req.params.projectId
    const organizationId = projects.findProjectOrganizationId(
      projectId,
      deps.db
    )
    if (!organizationId) {
      res.status(404).json({ error: 'project_not_found' })
      return
    }
    const project = projects.getProject(organizationId, projectId, deps.db)
    const organization = organizations.getOrganizationById(
      organizationId,
      deps.db
    )
    if (!project || !organization) {
      // Unreachable in practice — `organizationId` was just resolved from
      // this project's own row, above — but guarded rather than assumed,
      // the same TEN-2 race every other route in this router already
      // guards against.
      res.status(404).json({ error: 'project_not_found' })
      return
    }

    const usageSummary = costLedger.getOrganizationUsageSummary(
      organizationId,
      deps.db
    )
    const enrolmentCounts = enrolments.countActiveEnrolmentsByCourse(
      organizationId,
      deps.db
    )
    const courseRows = courses.listCourses(organizationId, deps.db, {
      projectId,
    })

    const body: AdminProjectDetail = {
      projectId: project.id,
      name: project.name,
      organizationId,
      organizationName: organization.name,
      archivedAt: project.archivedAt,
      createdAt: project.createdAt,
      courses: buildCourseBriefs(courseRows, enrolmentCounts, usageSummary),
    }
    res.status(200).json(body)
  })

  /**
   * WEB-53: every pending and approved course, across every organization —
   * `courseApproval.listCoursesForApproval`'s own documented TEN-2
   * exception (this router's own module comment already names
   * `costLedger.listOrganizationTotals` as the same shape). ADMIN-6, not
   * this route, is where a single course's settings become readable; this
   * one stays to the identifying detail ADMIN-4 still allows.
   */
  router.get('/courses', (req, res) => {
    if (!req.session) {
      res.status(401).json({ error: 'not_signed_in' })
      return
    }
    if (!isRequestFromPlatformAdministrator(req.session.accountId, deps.db)) {
      res.status(403).json({ error: 'not_platform_administrator' })
      return
    }

    const body: AdminCoursesResponse = {
      courses: courseApproval.listCoursesForApproval(deps.db),
    }
    res.status(200).json(body)
  })

  /**
   * ADMIN-6: one course's settings, read-only — general, AI and knowledge,
   * exactly as its owner would see them in `pages/CourseEditor.tsx`, never
   * its people, enrolments, conversations, messages, transcripts or join
   * links (this file's own module comment on the boundary WEB-53 already
   * narrowed once, and stays exactly that narrow here).
   *
   * **Must-fix, second review round**: the organization a course belongs to
   * is resolved through `courseApproval.findCourseOrganizationId` — a
   * scoped, indexed point lookup on `courses.id`, that function's own doc
   * comment — not the `listCoursesForApproval` scan `approve`/`unapprove`
   * below use (D-117's own trade, accepted there for a rare, deliberate
   * button click, not for an interactive page load, which this route is).
   * The course's title, its enabled state, its settings and its own
   * approval columns all come from `courses.getCourse` directly — COST-8's
   * three approval columns live on `courses` itself (`schema.ts`), so
   * nothing here needs `listCoursesForApproval`'s own join to read them
   * back. Only the organization's and project's own *names*, and the
   * approving account's own *email*, need anything beyond that single
   * scoped read — three more indexed point lookups, each by primary key,
   * still far cheaper than the full scan this route no longer pays for.
   */
  router.get<{ courseId: string }>('/courses/:courseId', (req, res) => {
    if (!req.session) {
      res.status(401).json({ error: 'not_signed_in' })
      return
    }
    if (!isRequestFromPlatformAdministrator(req.session.accountId, deps.db)) {
      res.status(403).json({ error: 'not_platform_administrator' })
      return
    }

    const organizationId = courseApproval.findCourseOrganizationId(
      req.params.courseId,
      deps.db
    )
    if (!organizationId) {
      res.status(404).json({ error: 'course_not_found' })
      return
    }

    const course = courses.getCourse(
      organizationId,
      req.params.courseId,
      deps.db
    )
    if (!course) {
      // Unreachable in practice — `organizationId` was just resolved,
      // above, from the same database — but guarded rather than assumed,
      // the same TEN-2 race every other route in this router already
      // guards against.
      res.status(404).json({ error: 'course_not_found' })
      return
    }

    // Unreachable in practice, guarded the same way: `organizationId` and
    // `course.projectId` were each just resolved from rows that name them
    // as a foreign key (`courses.organizationId`/`courses.projectId`,
    // `schema.ts`), so the organization and the project they name cannot
    // fail to exist without a foreign-key violation nothing in this
    // codebase currently permits.
    const organization = organizations.getOrganizationById(
      organizationId,
      deps.db
    )
    const project = projects.getProject(
      organizationId,
      course.projectId,
      deps.db
    )
    if (!organization || !project) {
      res.status(404).json({ error: 'course_not_found' })
      return
    }

    // The approver's own email — `null` for a pending course and for one
    // approved by `'auto-approve'` (`course-approval.ts`'s own module
    // comment: no human decision-maker to name), the same two conditions
    // `courseApproval.listCoursesForApproval`'s own `aiApprovedByEmail`
    // already documents.
    const aiApprovedByEmail =
      course.aiApprovedByAccountId === null
        ? null
        : (accounts.getAccountById(course.aiApprovedByAccountId, deps.db)
            ?.email ?? null)

    const attachments = courseAttachments.listAttachmentsForCourse(
      organizationId,
      req.params.courseId,
      deps.db
    )
    const webSources = courseWebSources.listWebSourcesForCourse(
      organizationId,
      req.params.courseId,
      deps.db
    )

    // ADMIN-9 — the course's own approval history, with each acting
    // account's email resolved. The set of distinct approvers on one
    // course's own history is small (a handful of approve/revoke events at
    // most), unlike `listCoursesForApproval`'s own cross-course batch — a
    // plain `getAccountById` per approver here is not the "watch N+1" case
    // this router's brief calls out, which is about scanning every course in
    // an organization, not one course's own audit trail.
    const approvalEventRows = courseApproval.listApprovalEventsForCourse(
      organizationId,
      req.params.courseId,
      deps.db
    )
    // One lookup per *distinct* approver, not per event: a course approved,
    // revoked and approved again by the same administrator asks once.
    const approverEmails = new Map<string, string | null>()
    const resolveApproverEmail = (accountId: string): string | null => {
      const cached = approverEmails.get(accountId)
      if (cached !== undefined) return cached
      const email = accounts.getAccountById(accountId, deps.db)?.email ?? null
      approverEmails.set(accountId, email)
      return email
    }
    const approvalEvents: AdminCourseApprovalEvent[] = approvalEventRows.map(
      (event) => ({
        id: event.id,
        action: event.action,
        accountId: event.accountId,
        accountEmail:
          event.accountId === null
            ? null
            : resolveApproverEmail(event.accountId),
        createdAt: event.createdAt,
      })
    )

    // ADMIN-9 — the course's own usage, and the people enrolled in it (never
    // their transcript — this router's own module comment on the boundary).
    const courseUsage = costLedger.getCourseUsageSummary(
      organizationId,
      req.params.courseId,
      deps.db
    )
    const activePeople = enrolments.listPeopleForCourse(
      organizationId,
      req.params.courseId,
      deps.db
    )
    const enrolmentRows = enrolments.listEnrolmentsForCourse(
      organizationId,
      req.params.courseId,
      deps.db
    )
    const enroledAtByPersonId = new Map(
      enrolmentRows
        .filter((row) => row.endedAt === null)
        .map((row) => [row.personId, row.createdAt])
    )
    const personIds = activePeople.map((person) => person.id)
    const webIdentities = people.listWebIdentitiesForPeople(
      organizationId,
      personIds,
      deps.db
    )
    const accountIdByPersonId = new Map(
      webIdentities.map((row) => [row.personId, row.accountId])
    )
    const personUsageRows = costLedger.getCoursePersonUsage(
      organizationId,
      req.params.courseId,
      deps.db
    )
    const usageByPersonId = new Map(
      personUsageRows.map((row) => [row.personId, row])
    )
    const coursePeople: AdminCoursePerson[] = activePeople.map((person) => ({
      personId: person.id,
      displayName: person.displayName,
      email: person.email,
      enroledAt: enroledAtByPersonId.get(person.id) ?? person.createdAt,
      connectedAt: person.connectedAt,
      accountId: accountIdByPersonId.get(person.id) ?? null,
      totalCostMicros: usageByPersonId.get(person.id)?.costMicros ?? 0,
      callCount: usageByPersonId.get(person.id)?.callCount ?? 0,
    }))

    const body: AdminCourseDetail = {
      courseId: course.id,
      courseTitle: course.title,
      enabled: course.enabled,
      projectId: course.projectId,
      projectName: project.name,
      organizationId,
      organizationName: organization.name,
      adminsRole: course.adminsRole,
      studentsRole: course.studentsRole,
      categories: course.categories.map((category) => ({
        name: category.name,
        channels: category.channels.map((channel) => ({
          name: channel.name,
          adminsOnly: channel.adminsOnly,
        })),
      })),
      conversationScope: course.conversationScope,
      model: course.model,
      promptId: course.promptId,
      instructions: course.instructions,
      maxRequestsPerDay: course.maxRequestsPerDay,
      selfEnrolFromDiscord: course.selfEnrolFromDiscord,
      answerUnenrolled: course.answerUnenrolled,
      attachments: attachments.map((attachment) => ({
        filename: attachment.filename,
        sizeBytes: attachment.sizeBytes,
        status: attachment.status,
      })),
      webSources: webSources.map((webSource) => ({ domain: webSource.domain })),
      aiApprovedAt: course.aiApprovedAt,
      aiApprovedByAccountId: course.aiApprovedByAccountId,
      aiApprovedByEmail,
      aiApprovalDecidedAt: course.aiApprovalDecidedAt,
      approvalEvents,
      usage: {
        totalCostMicros: courseUsage.totalCostMicros,
        callCount: courseUsage.callCount,
        bySurface: courseUsage.bySurface,
      },
      people: coursePeople,
    }
    res.status(200).json(body)
  })

  /**
   * WEB-53's Approve button. Idempotent (`courseApproval.approveCourse`'s
   * own doc comment) — approving a course that is already approved
   * succeeds without writing a second audit event, rather than refusing.
   * `action` is always `'approve'` here: `'auto-approve'` is
   * `answerQuestion`'s and `courses.save`/`courses.import`'s own
   * automatic path (COST-8), never something a request body can select.
   *
   * `approveCourse` is scoped by `organizationId` (TEN-2/TEN-5, that
   * function's own doc comment) — resolved here through
   * `courseApproval.findCourseOrganizationId`, the same scoped, indexed
   * lookup `GET /courses/:courseId` above uses, not the
   * `listCoursesForApproval` scan this route used before the second review
   * round (`docs/DECISIONS.md` D-118's update) — nothing here needs
   * anything else that scan computes.
   */
  router.post<{ courseId: string }>(
    '/courses/:courseId/approve',
    (req, res) => {
      if (!req.session) {
        res.status(401).json({ error: 'not_signed_in' })
        return
      }
      if (!isRequestFromPlatformAdministrator(req.session.accountId, deps.db)) {
        res.status(403).json({ error: 'not_platform_administrator' })
        return
      }

      const organizationId = courseApproval.findCourseOrganizationId(
        req.params.courseId,
        deps.db
      )
      if (!organizationId) {
        res.status(404).json({ error: 'course_not_found' })
        return
      }

      const updated = courseApproval.approveCourse(
        organizationId,
        req.params.courseId,
        req.session.accountId,
        'approve',
        Date.now(),
        deps.db
      )
      if (!updated) {
        // Unreachable in practice — `organizationId` was just resolved,
        // above — but guarded rather than assumed, the same TEN-2 race
        // this router's delete route already guards against.
        res.status(404).json({ error: 'course_not_found' })
        return
      }
      res.status(200).json({ approved: true })
    }
  )

  /**
   * WEB-53's Unapprove button — always a deliberate revoke
   * (`courseApproval.revokeCourseApproval`'s own doc comment), which also
   * sets `aiApprovalDecidedAt` so `answerQuestion`'s lazy auto-approval
   * cannot silently re-approve the course afterwards (COST-8). Idempotent
   * the same way approve is: unapproving a course that is already *decided*
   * pending (a previous revoke already ran) succeeds without a second audit
   * event.
   *
   * **Must-fix, first review round**: idempotence used to skip the write
   * for any course with `aiApprovedAt === null`, which also covers a course
   * that has *never been decided at all* — every course that predates
   * COST-8, and any freshly created one nobody has acted on yet
   * (`aiApprovalDecidedAt` also `null`). Skipping the write there left
   * `aiApprovalDecidedAt` unset, so the administrator's own explicit "off"
   * was indistinguishable from "nobody has ever decided" — the next
   * student question in an administrator-owned organization silently
   * re-approved it through `answerQuestion`'s own lazy path
   * (`courseApproval.isAdministratorOwnedOrganization`), reverting the
   * decision this route just claimed to have made. The skip now checks
   * `aiApprovalDecidedAt`, not `aiApprovedAt` alone: only a course already
   * *decided* pending (a prior revoke) is a true no-op; a never-decided
   * pending course still calls `revokeCourseApproval` so the decision is
   * actually recorded.
   *
   * **Second review round**: resolves the organization through
   * `courseApproval.findCourseOrganizationId`, the same scoped lookup
   * `approve` (above) and `GET /courses/:courseId` now use, rather than the
   * `listCoursesForApproval` scan (`docs/DECISIONS.md` D-118's update).
   * That scan used to also supply `aiApprovedAt`/`aiApprovalDecidedAt` for
   * the idempotence check just below — read here instead from
   * `courses.getCourse`, since both columns live on `courses` itself
   * (`schema.ts`); still two scoped, indexed reads total, not one full
   * cross-organization join.
   */
  router.post<{ courseId: string }>(
    '/courses/:courseId/unapprove',
    (req, res) => {
      if (!req.session) {
        res.status(401).json({ error: 'not_signed_in' })
        return
      }
      if (!isRequestFromPlatformAdministrator(req.session.accountId, deps.db)) {
        res.status(403).json({ error: 'not_platform_administrator' })
        return
      }

      const organizationId = courseApproval.findCourseOrganizationId(
        req.params.courseId,
        deps.db
      )
      if (!organizationId) {
        res.status(404).json({ error: 'course_not_found' })
        return
      }
      const course = courses.getCourse(
        organizationId,
        req.params.courseId,
        deps.db
      )
      if (!course) {
        // Unreachable in practice — `organizationId` was just resolved,
        // above — but guarded rather than assumed, the same TEN-2 race
        // every other route in this router already guards against.
        res.status(404).json({ error: 'course_not_found' })
        return
      }

      // Already decided pending — a genuine no-op, not an error (this
      // route's own doc comment above). Not `course.aiApprovedAt === null`
      // alone: see that comment for why a never-decided course must still
      // fall through to `revokeCourseApproval` below.
      if (course.aiApprovedAt === null && course.aiApprovalDecidedAt !== null) {
        res.status(200).json({ approved: false })
        return
      }

      const updated = courseApproval.revokeCourseApproval(
        organizationId,
        req.params.courseId,
        req.session.accountId,
        Date.now(),
        deps.db
      )
      if (!updated) {
        res.status(404).json({ error: 'course_not_found' })
        return
      }
      res.status(200).json({ approved: false })
    }
  )

  /** ADMIN-5's own "names exactly what will be deleted before it happens" — read before any confirmation is even shown. */
  router.get<{ organizationId: string }>(
    '/organizations/:organizationId/deletion-preview',
    (req, res) => {
      if (!req.session) {
        res.status(401).json({ error: 'not_signed_in' })
        return
      }
      if (!isRequestFromPlatformAdministrator(req.session.accountId, deps.db)) {
        res.status(403).json({ error: 'not_platform_administrator' })
        return
      }

      const organizationId = req.params.organizationId
      const preview = organizations.previewOrganizationDeletion(
        organizationId,
        deps.db
      )
      if (!preview) {
        res.status(404).json({ error: 'organization_not_found' })
        return
      }
      res.status(200).json(preview)
    }
  )

  const deleteInputSchema = z.object({ confirmName: z.string().min(1) })

  /**
   * ADMIN-5: delete a tenant's data — explicit, confirmed, and audited.
   *
   * **The confirmation is enforced here, server-side, not merely by the
   * panel's own modal.** `confirmName` must equal the organization's own
   * `name` exactly; a mismatch refuses with `409` before anything is
   * touched. A destructive control that only *appears* confirmed — the
   * panel disables a button until a client-side check passes, but the
   * server accepts the request regardless of what was actually typed — is
   * not a confirmation at all; this project's own history has that exact
   * defect (this router's own module comment on why it re-checks
   * `isPlatformAdministrator` itself rather than trusting a caller that
   * reached this far to already be authorized).
   */
  router.post<{ organizationId: string }>(
    '/organizations/:organizationId/delete',
    (req, res, next) => {
      if (!req.session) {
        res.status(401).json({ error: 'not_signed_in' })
        return
      }
      if (!isRequestFromPlatformAdministrator(req.session.accountId, deps.db)) {
        res.status(403).json({ error: 'not_platform_administrator' })
        return
      }

      const parsed = deleteInputSchema.safeParse(req.body)
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: 'invalid_request', issues: parsed.error.issues })
        return
      }

      const organizationId = req.params.organizationId
      const organization = organizations.getOrganizationById(
        organizationId,
        deps.db
      )
      if (!organization) {
        res.status(404).json({ error: 'organization_not_found' })
        return
      }
      if (parsed.data.confirmName !== organization.name) {
        res.status(409).json({ error: 'confirmation_name_mismatch' })
        return
      }

      // Gathered *before* the delete — the rows naming these ids are about
      // to be removed, and the bytes on disk have no other index back to
      // them once that happens.
      const courseRows = courses.listCourses(organizationId, deps.db)
      const attachmentIds = courseRows.flatMap((course) =>
        courseAttachments
          .listAttachmentsForCourse(organizationId, course.id, deps.db)
          .map((attachment) => attachment.id)
      )
      const exportIds = courseRows.flatMap((course) =>
        transcriptExports
          .listExportsForCourse(organizationId, course.id, deps.db)
          .map((exportRow) => exportRow.id)
      )

      const summary = organizations.deleteOrganizationData(
        organizationId,
        deps.db
      )
      if (!summary) {
        // Unreachable in practice — this handler just confirmed the
        // organization exists moments earlier — but guarded rather than
        // assumed, the same race every action in `@bloombot/actions`
        // already guards against in its own comments.
        res.status(404).json({ error: 'organization_not_found' })
        return
      }

      organizations.recordTenantDeletion(
        organizationId,
        {
          organizationName: organization.name,
          deletedByAccountId: req.session.accountId,
          summary,
        },
        deps.db
      )

      const ids = [...attachmentIds, ...exportIds]

      // Immediate best-effort, awaited — catches every byte that was
      // already on disk when the delete ran (an already-`ready` export, an
      // already-attached knowledge file), and does not respond until it
      // has: a `200` from this route means those bytes are actually gone,
      // not merely scheduled to be. The database rows are already gone,
      // which is the authoritative "this tenant's data is deleted"
      // statement; a byte this pass fails to remove (or has not been
      // written yet — ADMIN-5's own race, below) is not yet a privacy leak
      // reachable through this platform (nothing left references its id).
      sweepStorage(deps, organizationId, ids)
        .then(() => {
          // ADMIN-5's own race (`AdminRouterDependencies.deletedTenantSweepDelayMs`'s
          // own doc comment, and `apps/worker/src/handlers/transcripts.ts`'s):
          // an export job already past its own re-check can still land
          // bytes on disk *after* this immediate sweep already ran and
          // found nothing there. A second sweep, delayed and deliberately
          // not awaited (the response below has already gone out by the
          // time it fires), catches that — idempotent either way, since
          // `AttachmentStorage#remove` is a no-op on a directory that was
          // never created or was already removed.
          setTimeout(
            () => void sweepStorage(deps, organizationId, ids),
            deps.deletedTenantSweepDelayMs ??
              DEFAULT_DELETED_TENANT_SWEEP_DELAY_MS
          ).unref()

          res.status(200).json({ deleted: true, summary })
        })
        .catch(next)
    }
  )

  /**
   * ADMIN-10: every account on the platform, newest first — `accounts.listAccounts`
   * for the identity and organization-count columns, `costLedger.listAccountTotals`
   * joined in for the cost column, the same "each repo's own reasoning stays
   * in that repo" split `GET /organizations` above already keeps between
   * `costLedger.listOrganizationTotals` and `checkPlatformHealth`. Filtering
   * by name or email (ADMIN-12) is the browser's own job, not this route's —
   * the whole list is returned every time.
   */
  router.get('/accounts', (req, res) => {
    if (!req.session) {
      res.status(401).json({ error: 'not_signed_in' })
      return
    }
    if (!isRequestFromPlatformAdministrator(req.session.accountId, deps.db)) {
      res.status(403).json({ error: 'not_platform_administrator' })
      return
    }

    const accountRows = accounts.listAccounts(deps.db)
    const totals = costLedger.listAccountTotals(deps.db)
    const totalCostMicrosByAccountId = new Map(
      totals.map((total) => [total.accountId, total.totalCostMicros])
    )

    const body: AdminAccountsResponse = {
      accounts: accountRows.map((row) => ({
        accountId: row.id,
        email: row.email,
        displayName: row.displayName,
        firstName: row.firstName,
        lastName: row.lastName,
        createdAt: row.createdAt,
        disabledAt: row.disabledAt,
        // AUTH-4's own allowlist, read live — the same check every other
        // route in this router already re-runs on every request, applied
        // here to *name* which rows are administrators rather than to
        // authorize the caller (`isRequestFromPlatformAdministrator`, above,
        // already did that).
        isPlatformAdministrator: isPlatformAdministrator(row.email),
        organizationCount: row.organizationCount,
        totalCostMicros: totalCostMicrosByAccountId.get(row.id) ?? 0,
      })),
    }
    res.status(200).json(body)
  })

  /**
   * ADMIN-11: an account's own console screen — its identity, its
   * organizations (membership and merely-connected alike), the people
   * records connected to it (PPL-1) with every identity proven on each
   * (PPL-2), the courses its own people are enrolled in, and its usage.
   * Never a transcript (this router's own module comment on the boundary).
   */
  router.get<{ accountId: string }>('/accounts/:accountId', (req, res) => {
    if (!req.session) {
      res.status(401).json({ error: 'not_signed_in' })
      return
    }
    if (!isRequestFromPlatformAdministrator(req.session.accountId, deps.db)) {
      res.status(403).json({ error: 'not_platform_administrator' })
      return
    }

    const account = accounts.getAccountById(req.params.accountId, deps.db)
    if (!account) {
      res.status(404).json({ error: 'account_not_found' })
      return
    }

    const membershipRows =
      memberships.listMembershipsForAccountWithOrganizations(
        account.id,
        deps.db
      )
    const connectedOrganizations =
      people.listConnectedOrganizationsWithNamesForAccount(account.id, deps.db)
    const peopleRecords = people.listPeopleForAccount(account.id, deps.db)
    const personIds = peopleRecords.map((person) => person.personId)
    const enrolmentRows = enrolments.listEnrolmentsForPeople(personIds, deps.db)
    const usage = costLedger.getAccountUsageSummary(account.id, deps.db)

    const body: AdminAccountDetail = {
      accountId: account.id,
      email: account.email,
      displayName: account.displayName,
      firstName: account.firstName,
      lastName: account.lastName,
      createdAt: account.createdAt,
      disabledAt: account.disabledAt,
      isPlatformAdministrator: isPlatformAdministrator(account.email),
      memberships: membershipRows,
      connectedOrganizations,
      people: peopleRecords,
      enrolments: enrolmentRows,
      usage,
    }
    res.status(200).json(body)
  })

  /** ADMIN-5's own audit trail, read back. */
  router.get('/tenant-deletions', (req, res) => {
    if (!req.session) {
      res.status(401).json({ error: 'not_signed_in' })
      return
    }
    if (!isRequestFromPlatformAdministrator(req.session.accountId, deps.db)) {
      res.status(403).json({ error: 'not_platform_administrator' })
      return
    }
    res
      .status(200)
      .json({ deletions: organizations.listTenantDeletions(deps.db) })
  })

  return router
}
