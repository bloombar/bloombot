/**
 * WEB-54 — the platform-health badges, fixed to the console's own viewport
 * bottom on every screen. `<footer>` (a `contentinfo` landmark), matching
 * the accessibility habit `components/AppShell.tsx`'s own `Footer` already
 * holds the rest of the panel to. Reads `data`, the one `fetchAdminOrganizations`
 * result `Admin` already holds for the organizations list itself — no
 * second read, even on a screen that has no other use for that response at
 * all.
 */

import type { AdminOrganizationsResponse } from '../../api/types.js'
import { FailureIcon, SuccessIcon } from '../../icons.js'

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

export function AdminHealthFooter({
  data,
}: {
  data: AdminOrganizationsResponse | undefined
}) {
  if (!data) return null
  return (
    <footer className="fixed inset-x-0 bottom-0 z-10 flex h-footer items-center gap-3 border-t border-neutral-200 bg-white px-6">
      <ProcessBadge label="Bot" reachable={data.platformHealth.bot.reachable} />
      <ProcessBadge
        label="Worker"
        reachable={data.platformHealth.worker.reachable}
      />
      <ProcessBadge label="API" reachable={data.platformHealth.api.reachable} />
    </footer>
  )
}
