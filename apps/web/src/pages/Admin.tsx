/**
 * ADMIN-4/ADMIN-5: the platform-administrator console — organizations,
 * their usage and their health, and the one operation that deletes a
 * tenant's data entirely.
 *
 * Reached at `/platform-admin` (`App.tsx`'s own module comment — not
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
  OrganizationDeletionPreview,
  TenantDeletion,
} from '../api/types.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { useModal } from '../components/modal/ModalProvider.js'
import { DeleteIcon, FailureIcon, SuccessIcon } from '../icons.js'

export interface AdminScreenProps {
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

export function Admin({ onBack }: AdminScreenProps) {
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

      {data === undefined ? (
        !error && (
          <p role="status" className="text-sm text-neutral-500">
            Loading…
          </p>
        )
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
                <p className="text-sm font-medium text-neutral-900">
                  {organization.organizationName}
                </p>
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
                  void handleDelete(
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

      {deletions && deletions.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-neutral-900">
            Deletion history
          </h2>
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
        </div>
      )}
    </div>
  )
}
