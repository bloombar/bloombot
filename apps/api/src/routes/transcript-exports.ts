/**
 * ADMIN-3's own "collect the file when it is ready" — downloading a
 * produced transcript export. Not an action (`@bloombot/actions`'
 * `discord-servers.ts`'s own module comment explains the same shape for
 * TEN-4's install flow): a download is a binary response with its own
 * `Content-Type`/`Content-Disposition`, which the generic
 * `POST /organizations/:organizationId/actions/:name` route's JSON
 * envelope (`routes/actions.ts`) has no way to express.
 *
 * Mounted at `/organizations/:organizationId/transcript-exports`
 * (`mergeParams`, the same convention `routes/actions.ts` uses). This
 * route replicates every part of `dispatch.ts`'s own pipeline that applies
 * to a read: **authorize** — the caller's own membership in
 * `:organizationId`, the exact check `routes/actions.ts` runs before it
 * will dispatch anything, refused the same way (`ActionRefusedError`, 404,
 * TEN-5) — then **resolve**, scoped by that same organization id
 * (`transcriptExports.getExport`, TEN-2), so a foreign export id is
 * refused identically to one that never existed. There is no metering step
 * for a read, and no input beyond the id in the route itself.
 */

import { Router } from 'express'

import { ActionRefusedError } from '@bloombot/actions'
import {
  memberships,
  transcriptExports,
  type AttachmentStorage,
  type Database,
} from '@bloombot/db'

export interface TranscriptExportsRouterDependencies {
  db: Database
  attachmentStorage: AttachmentStorage
}

/** `:organizationId/transcript-exports/:exportId/download` — mounted with `mergeParams`, the same reason `routes/actions.ts` needs it. */
export function buildTranscriptExportsRouter(
  deps: TranscriptExportsRouterDependencies
): Router {
  const router = Router({ mergeParams: true })

  router.get<{ organizationId: string; exportId: string }>(
    '/:exportId/download',
    (req, res, next) => {
      if (!req.session) {
        res.status(401).json({ error: 'not_signed_in' })
        return
      }
      const organizationId = req.params.organizationId
      const exportId = req.params.exportId

      const membership = memberships.getMembership(
        organizationId,
        req.session.accountId,
        deps.db
      )
      if (!membership) {
        next(new ActionRefusedError())
        return
      }

      const exportRow = transcriptExports.getExport(
        organizationId,
        exportId,
        deps.db
      )
      if (!exportRow) {
        next(new ActionRefusedError())
        return
      }
      if (exportRow.status !== 'ready') {
        res.status(409).json({ error: 'export_not_ready' })
        return
      }

      deps.attachmentStorage
        .read(organizationId, exportId)
        .then((bytes) => {
          if (!bytes) {
            // The row says ready but the bytes are gone — nothing this
            // route can serve. Reported plainly rather than folded into
            // the TEN-5 refusal above: the caller is already proven to
            // hold access to this export by the membership check, so
            // there is no existence-oracle risk in saying so.
            res.status(500).json({ error: 'export_bytes_missing' })
            return
          }
          res
            .status(200)
            .setHeader(
              'Content-Type',
              exportRow.contentType ?? 'application/octet-stream'
            )
            .setHeader(
              'Content-Disposition',
              `attachment; filename="${exportRow.filename ?? `${exportId}.json`}"`
            )
            .send(bytes)
        })
        .catch(next)
    }
  )

  return router
}
