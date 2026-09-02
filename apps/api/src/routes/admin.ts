/**
 * The platform-administrator console (ADMIN-4, ADMIN-5) — organizations,
 * their usage and their health, and the one operation that removes a
 * tenant's data entirely.
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
 * nothing here reaches `transcriptAccess`, `conversations` or `messages` —
 * an administrator sees organizations, their usage and their health, never
 * a course, a person or a message. `tests/routes/admin.test.ts` proves
 * this by attempting a transcript read through this router and asserting
 * it is refused, not merely by asserting the absence of a route (a route
 * that does not exist today says nothing about one that might be added
 * tomorrow without anyone noticing it crossed this boundary).
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
  courseAttachments,
  courses,
  organizations,
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
}

export interface AdminOrganizationsResponse {
  organizations: AdminOrganizationSummary[]
  platformHealth: PlatformHealthReport
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
          })),
          platformHealth,
        }
        res.status(200).json(body)
      })
      .catch(next)
  })

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
    (req, res) => {
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

      // Best-effort — the database rows are already gone, which is the
      // authoritative "this tenant's data is deleted" statement; a byte
      // this loop fails to remove is an orphan on disk, not a privacy leak
      // reachable through this platform (nothing left references its id).
      Promise.all(
        [...attachmentIds, ...exportIds].map((id) =>
          deps.attachmentStorage
            .remove(organizationId, id)
            .catch((error: unknown) =>
              deps.logger.warn(
                { err: error, organizationId, id },
                'apps/api: could not remove a deleted tenant’s stored bytes'
              )
            )
        )
      ).catch(() => {
        // `Promise.all` over promises that each already caught their own
        // rejection cannot itself reject — nothing to do here; the branch
        // exists only so a future change to the mapped promise cannot
        // reintroduce an unhandled rejection unnoticed.
      })

      res.status(200).json({ deleted: true, summary })
    }
  )

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
