/**
 * ADMIN-4/ADMIN-5: the platform-administrator console — organizations,
 * their usage and their health, and the one operation that deletes a
 * tenant's data entirely.
 *
 * Reached under `/platform-admin` (`App.tsx`'s own module comment — not
 * `/admin`, which is `apps/api`'s own mount for this screen's reads and
 * writes), never inside
 * `pages/Shell.tsx`'s organization-scoped tabs — this screen is not
 * "acting within" any one organization, the same boundary
 * `apps/api`'s own `routes/admin.ts` draws. Every read here goes through
 * that router (`api/client.ts`'s own `fetchAdminOrganizations`/
 * `fetchDeletionPreview`/`fetchTenantDeletions`), not `dispatchAction` —
 * there is no organization id to dispatch within.
 *
 * **ADMIN-4's own boundary, on this page too:** nothing rendered here ever
 * shows a course, a student or a message — only an organization's name,
 * its usage totals and the platform's own process health. This app does
 * not hide that boundary by omission alone; `apps/api`'s own response
 * shape has nothing in it to show even if this page tried.
 *
 * ADMIN-5's confirmation is the prompt variant of this panel's one modal
 * (`components/modal/`) — an administrator types the organization's own
 * name to proceed, the same "severe enough to warrant the prompt variant"
 * treatment this slice's own brief calls for, never a plain confirm a
 * stray click could pass.
 *
 * **WEB-33 — every screen this console renders is its own address**, under
 * `routing/route.ts#AdminRoute`:
 *  - `'platform-admin'` — the console's one entry point from outside the
 *    app; resolved to `'admin-organizations'` and replaced, the identical
 *    "one-time landing address" treatment `App.tsx`'s own `'home'` gets for
 *    `/`, never somewhere back should return into.
 *  - `'admin-organizations'` — the organizations list, with usage and the
 *    per-organization Delete action inline (unchanged from before this
 *    slice — an operator does not have to drill into an organization just
 *    to delete it).
 *  - `'admin-organization'` — one organization's own card, reached by
 *    clicking its name in the list, so an operator can link a colleague to
 *    the exact organization they are looking at (this slice's own brief,
 *    quoting WEB-33). Resolved against the same `fetchAdminOrganizations`
 *    read the list already holds — there is no `admin.organizations.get`
 *    action, mirroring `pages/ProjectsPanel.tsx`'s own `useResolvedProject`
 *    reading the whole list rather than adding a single-item fetch a
 *    console this small does not otherwise need.
 *  - `'admin-deletions'` — ADMIN-5's own audit trail, broken out of the
 *    list's own page into its own address.
 * Every navigation between these pushes (`navigate`, no `{ replace: true }`)
 * — WEB-34's ordinary rule, the same the rest of the panel already follows.
 */

import { useCallback, useEffect, useState } from 'react'

import {
  ApiError,
  deleteTenant,
  fetchAdminOrganizations,
  fetchDeletionPreview,
  fetchTenantDeletions,
} from '../api/client.js'
import type {
  AdminOrganizationsResponse,
  AdminOrganizationSummary,
  OrganizationDeletionPreview,
  TenantDeletion,
} from '../api/types.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { useModal } from '../components/modal/ModalProvider.js'
import { DeleteIcon, FailureIcon, SuccessIcon } from '../icons.js'
import type { AdminRoute, Route } from '../routing/route.js'
import { NotFound } from './NotFound.js'

export interface AdminScreenProps {
  /** WEB-33 — which of the console's own screens is current. */
  route: AdminRoute
  navigate: (route: Route, options?: { replace?: boolean }) => void
  onBack: () => void
}

/** Integer micros (COST-1) to a plain dollar figure — the same unit `costLedger`'s own summaries use platform-wide; this app has no other place that formats one yet, so the conversion lives here rather than a shared module one caller does not justify. */
function formatMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`
}

function ProcessBadge({
  label,
  reachable,
}: {
  label: string
  reachable: boolean
}) {
  return (
    <span className="flex items-center gap-1 text-xs text-neutral-600">
      {reachable ? (
        <SuccessIcon aria-hidden="true" className="size-3 text-success-600" />
      ) : (
        <FailureIcon aria-hidden="true" className="size-3 text-danger-600" />
      )}
      {label}
    </span>
  )
}

export function Admin({ route, navigate, onBack }: AdminScreenProps) {
  const [data, setData] = useState<AdminOrganizationsResponse | undefined>(
    undefined
  )
  const [deletions, setDeletions] = useState<TenantDeletion[] | undefined>(
    undefined
  )
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [deletingId, setDeletingId] = useState<string | undefined>(undefined)
  const { prompt } = useModal()

  const refresh = useCallback(() => {
    fetchAdminOrganizations().then(
      (result) => setData(result),
      (caught: unknown) => {
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [])

  // ADMIN-5's own audit trail, read back — a rework finding: this screen's
  // own module comment already claimed every read went through
  // `fetchTenantDeletions`, but nothing here had ever actually called it.
  const refreshDeletions = useCallback(() => {
    fetchTenantDeletions().then(
      (result) => setDeletions(result),
      (caught: unknown) => {
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [])

  useEffect(() => {
    refresh()
    refreshDeletions()
  }, [refresh, refreshDeletions])

  // WEB-33/WEB-34: `/platform-admin` itself is never rendered past this —
  // once mounted, it replaces to the console's own landing screen, the
  // identical "one-time entry, resolved and replaced" shape `App.tsx`'s
  // own `'home'` effect already gives `/`.
  useEffect(() => {
    if (route.kind !== 'platform-admin') return
    navigate({ kind: 'admin-organizations' }, { replace: true })
  }, [route.kind, navigate])

  const handleDelete = async (organizationId: string, name: string) => {
    setError(undefined)
    let preview: OrganizationDeletionPreview
    try {
      preview = await fetchDeletionPreview(organizationId)
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
      return
    }

    // ADMIN-5's own "names exactly what will be deleted before it happens" —
    // read into the confirmation itself, not a separate screen an
    // administrator could click past without seeing it.
    const typed = await prompt({
      title: `Delete ${name}?`,
      description:
        `This permanently deletes ${preview.courses} course(s), ` +
        `${preview.people} student record(s), ${preview.conversations} conversation(s), ` +
        `${preview.messages} message(s), ${preview.enrolments} enrolment(s), ` +
        `${preview.courseAttachments} knowledge file(s) and its Discord server binding, if any. ` +
        (preview.queuedJobs > 0
          ? `${preview.queuedJobs} job(s) still queued or running for it will be deleted too — ` +
            'an export in progress will not produce a file. '
          : '') +
        'This cannot be undone. Type the organization’s name to confirm.',
      label: 'Organization name',
      placeholder: name,
      confirmLabel: 'Delete',
      destructive: true,
      validate: (value) =>
        value === name ? undefined : 'Type the name exactly to confirm.',
    })
    if (typed === undefined) return

    setDeletingId(organizationId)
    try {
      await deleteTenant(organizationId, typed)
      refresh()
      refreshDeletions()
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setDeletingId(undefined)
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-page-title font-semibold text-neutral-900">
          Platform administration
        </h1>
        <Button variant="secondary" onClick={onBack}>
          Back to the panel
        </Button>
      </div>

      {error && <ErrorMessage error={error} />}

      {data && (
        <div className="flex flex-wrap gap-3 rounded-md border border-neutral-200 p-4">
          <ProcessBadge
            label="Bot"
            reachable={data.platformHealth.bot.reachable}
          />
          <ProcessBadge
            label="Worker"
            reachable={data.platformHealth.worker.reachable}
          />
          <ProcessBadge
            label="API"
            reachable={data.platformHealth.api.reachable}
          />
        </div>
      )}

      {route.kind === 'admin-organization' ? (
        <OrganizationDetail
          organizationId={route.organizationId}
          data={data}
          deletingId={deletingId}
          onDelete={handleDelete}
          onBack={() => navigate({ kind: 'admin-organizations' })}
        />
      ) : route.kind === 'admin-deletions' ? (
        <DeletionsView
          deletions={deletions}
          onBack={() => navigate({ kind: 'admin-organizations' })}
        />
      ) : (
        <OrganizationsList
          data={data}
          deletingId={deletingId}
          onOpen={(organizationId) =>
            navigate({ kind: 'admin-organization', organizationId })
          }
          onDelete={handleDelete}
          onViewDeletions={() => navigate({ kind: 'admin-deletions' })}
        />
      )}
    </div>
  )
}

/** WEB-33's `'admin-organizations'` screen — unchanged from what `Admin` rendered directly before this slice, aside from the organization's own name now being a link into `'admin-organization'` and the deletion history moving to its own address (below `OrganizationsList`'s own link to it). */
function OrganizationsList({
  data,
  deletingId,
  onOpen,
  onDelete,
  onViewDeletions,
}: {
  data: AdminOrganizationsResponse | undefined
  deletingId: string | undefined
  onOpen: (organizationId: string) => void
  onDelete: (organizationId: string, name: string) => void
  onViewDeletions: () => void
}) {
  return (
    <>
      {data === undefined ? (
        <p role="status" className="text-sm text-neutral-500">
          Loading…
        </p>
      ) : data.organizations.length === 0 ? (
        <p className="text-sm text-neutral-500">No organizations yet.</p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="admin-organizations">
          {data.organizations.map((organization) => (
            <li
              key={organization.organizationId}
              data-testid={`admin-org-${organization.organizationId}`}
              className="flex flex-col gap-2 rounded-md border border-neutral-200 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <button
                  type="button"
                  onClick={() => onOpen(organization.organizationId)}
                  className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
                >
                  {organization.organizationName}
                </button>
                <p className="text-xs text-neutral-500">
                  {formatMicros(organization.totalCostMicros)} spent ·{' '}
                  {organization.callCount} call(s)
                  {organization.estimatedCostMicros > 0 &&
                    ' · partly estimated'}
                </p>
              </div>
              <Button
                variant="destructive"
                icon={<DeleteIcon aria-hidden="true" className="size-4" />}
                onClick={() =>
                  onDelete(
                    organization.organizationId,
                    organization.organizationName
                  )
                }
                disabled={deletingId === organization.organizationId}
              >
                {deletingId === organization.organizationId
                  ? 'Deleting…'
                  : 'Delete'}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div>
        <Button variant="secondary" onClick={onViewDeletions}>
          Deletion history
        </Button>
      </div>
    </>
  )
}

/** WEB-33's `'admin-organization'` screen — one organization's own card, reached by name from the list, so its own address can be shared directly. Resolved against `data` (the same `fetchAdminOrganizations` read `OrganizationsList` renders from) rather than a fetch of its own — mirrors `pages/ProjectsPanel.tsx`'s own `useResolvedProject`, the identical "no single-item read exists, so search the list" shape. */
function OrganizationDetail({
  organizationId,
  data,
  deletingId,
  onDelete,
  onBack,
}: {
  organizationId: string
  data: AdminOrganizationsResponse | undefined
  deletingId: string | undefined
  onDelete: (organizationId: string, name: string) => void
  onBack: () => void
}) {
  if (data === undefined) {
    return (
      <p role="status" className="text-sm text-neutral-500">
        Loading…
      </p>
    )
  }

  const organization: AdminOrganizationSummary | undefined =
    data.organizations.find(
      (candidate) => candidate.organizationId === organizationId
    )

  // An address naming an organization not in this read at all — deleted
  // since, or never real — gets the same not-found treatment the rest of
  // the panel gives (`pages/NotFound.tsx`), never an empty screen.
  if (organization === undefined) {
    return <NotFound onHome={onBack} />
  }

  return (
    <div
      className="flex flex-col gap-4"
      data-testid={`admin-org-detail-${organization.organizationId}`}
    >
      <Button variant="secondary" onClick={onBack}>
        ← Organizations
      </Button>
      <div className="flex flex-col gap-2 rounded-md border border-neutral-200 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-neutral-900">
            {organization.organizationName}
          </p>
          <p className="text-xs text-neutral-500">
            {formatMicros(organization.totalCostMicros)} spent ·{' '}
            {organization.callCount} call(s)
            {organization.estimatedCostMicros > 0 && ' · partly estimated'}
          </p>
        </div>
        <Button
          variant="destructive"
          icon={<DeleteIcon aria-hidden="true" className="size-4" />}
          onClick={() =>
            onDelete(organization.organizationId, organization.organizationName)
          }
          disabled={deletingId === organization.organizationId}
        >
          {deletingId === organization.organizationId ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
    </div>
  )
}

/** WEB-33's `'admin-deletions'` screen — ADMIN-5's own audit trail, unchanged in content from what `Admin` rendered inline before this slice, now at its own address. */
function DeletionsView({
  deletions,
  onBack,
}: {
  deletions: TenantDeletion[] | undefined
  onBack: () => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <Button variant="secondary" onClick={onBack}>
        ← Organizations
      </Button>
      <h2 className="text-sm font-semibold text-neutral-900">
        Deletion history
      </h2>
      {deletions === undefined ? (
        <p role="status" className="text-sm text-neutral-500">
          Loading…
        </p>
      ) : deletions.length === 0 ? (
        <p className="text-sm text-neutral-500">No deletions yet.</p>
      ) : (
        <ul
          className="flex flex-col gap-2"
          data-testid="admin-tenant-deletions"
        >
          {deletions.map((deletion) => (
            <li
              key={deletion.id}
              className="rounded-md border border-neutral-200 p-3 text-xs text-neutral-600"
            >
              <span className="font-medium text-neutral-900">
                {deletion.organizationName}
              </span>{' '}
              — deleted {new Date(deletion.deletedAt).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
