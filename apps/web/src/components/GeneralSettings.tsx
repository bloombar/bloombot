/**
 * WEB-69/D-143 (`docs/DECISIONS.md`): the Organization settings screen's
 * own General tab — the organization's own name, editable, and (owner-only,
 * at the bottom, visibly separated) its Danger zone.
 *
 * **The rename itself is not new** — WEB-57 already built it, reached from
 * `components/OrganizationList.tsx`'s own row kebab (the Account page's
 * organization menu) and, separately, an MCP tool (`organizations_rename`,
 * `apps/mcp/src/tool-surface.ts`). This component is a second surface for
 * the identical capability, reusing `api/client.ts#renameOrganization`
 * (`organizations.rename`) rather than adding anything server-side.
 * `OrganizationList.tsx`'s own rename stays exactly where it is (a
 * kebab-driven `prompt()` dialog on the Account page's own organization
 * list) — this is a second way to reach the same action, an inline field on
 * the tab an owner is already looking at, not a replacement for it.
 *
 * **Owner-only, both to write and to show the control at all** — the same
 * "the server refuses regardless, this only decides what the panel offers"
 * split every other owner-only form in this app already holds itself to
 * (`pages/Usage.tsx`/`components/Team.tsx`'s own module comments):
 * `organizations.rename`'s own `execute` (`packages/actions/src/actions/organizations.ts`)
 * refuses anyone who is not an owner of *this* organization, unconditionally.
 * A non-owner sees the name read-only, as plain text, not a disabled input
 * — a control nobody reading it could ever use is not a control.
 *
 * **The Danger zone lives here, not its own tab** (D-143) —
 * `components/DangerZone.tsx` itself is unchanged, still owner-only, still
 * the last, visibly separated section, still deleting exactly what it
 * always deleted.
 *
 * **Dirtiness and the save/discard handle** follow the identical
 * `TabDirtyActions` shape `pages/Usage.tsx`/`components/Team.tsx` already
 * expose `pages/OrganizationSettings.tsx` (`hooks/tabDirtyActions.ts`):
 * dirty is the trimmed name input disagreeing with the organization's own
 * current name (the `organizationName` prop — `pages/Shell.tsx`'s own
 * `activeOrganizationName`, already resolved from `account.memberships`,
 * so nothing new is fetched to seed this field either). Save runs the
 * rename and then `refreshAccount` (the same "resolve the fresh account
 * afterward" discipline `OrganizationList.tsx`'s own module comment already
 * holds itself to) so the header, switcher and drawer all pick up the new
 * name; a refusal is rendered inline and the tab is not left. Discard
 * simply puts the input back to `organizationName`.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, renameOrganization } from '../api/client.js'
import type { AccountSummary } from '../api/types.js'
import type { TabDirtyActions } from '../hooks/tabDirtyActions.js'
import { Button } from './Button.js'
import { DangerZone } from './DangerZone.js'
import { ErrorMessage } from './ErrorMessage.js'
import { FormField } from './FormField.js'
import { textInputClasses } from './fieldStyles.js'
import type { Route } from '../routing/route.js'

export interface GeneralSettingsProps {
  organizationId: string
  /** This organization's own current name — `pages/Shell.tsx`'s own `activeOrganizationName`, resolved from `account.memberships`; this is what seeds the field and what "dirty" compares against. */
  organizationName: string
  /** Whether the caller's own membership in this organization is `'owner'` — decides whether the name is an editable field or plain text, and whether the Danger zone renders at all (this file's own module comment). */
  isOwner: boolean
  /** `pages/Shell.tsx`'s own `navigate`, threaded straight to `components/DangerZone.tsx`. */
  navigate: (route: Route, options?: { replace?: boolean }) => void
  /** `App.tsx`'s own `refreshAccount` adapter — called after a successful rename (this file's own module comment on why) and threaded straight to `components/DangerZone.tsx` for its own delete. */
  refreshAccount: () => Promise<AccountSummary | undefined>
  /** WEB-69 — called on every change to whether the name input disagrees with `organizationName`, so `pages/OrganizationSettings.tsx` can fold it into that tab's one dirty flag. Optional, defaulting to a no-op — most of this file's own tests do not care. */
  onDirtyChange?: (dirty: boolean) => void
  /** WEB-69 — this tab's own save/discard handle, the same `onRegisterActions` shape `pages/Usage.tsx` already exposes; called with `null` on unmount. Optional — most of this file's own tests do not care. */
  onRegisterActions?: (actions: TabDirtyActions | null) => void
}

export function GeneralSettings({
  organizationId,
  organizationName,
  isOwner,
  navigate,
  refreshAccount,
  onDirtyChange = () => {},
  onRegisterActions,
}: GeneralSettingsProps) {
  const [nameInput, setNameInput] = useState(organizationName)
  const [saving, setSaving] = useState(false)
  // WEB-69 — read synchronously by `isSaving`, the same reason
  // `pages/Usage.tsx`'s own `savingRef` exists: a tab prompt that may fire
  // in the same tick as this section's own Save button needs the answer
  // before any re-render.
  const savingRef = useRef(false)
  const [saveError, setSaveError] = useState<ApiError | undefined>(undefined)
  const [statusMessage, setStatusMessage] = useState<string | undefined>(
    undefined
  )

  // The field's own starting value tracks `organizationName` — the same
  // "seeded from the current, canonical value" timing `pages/Usage.tsx`'s
  // own `capInput` effect already holds itself to for its own seed
  // (`report`).
  useEffect(() => {
    setNameInput(organizationName)
  }, [organizationName])

  // WEB-69: returns whether the rename actually landed, so a caller that
  // saves on the way somewhere else (`pages/OrganizationSettings.tsx`'s own
  // tab prompt, via `onRegisterActions`) knows whether it is safe to move
  // on — the same `Promise<boolean>` shape `pages/Usage.tsx#handleSave`
  // already returns for the identical reason. A `useCallback`, for the
  // identical reason that file's own `handleSave` is one: its identity has
  // to track everything it closes over, since it is handed out through
  // `onRegisterActions`, below.
  const handleSave = useCallback(async (): Promise<boolean> => {
    const trimmed = nameInput.trim()
    if (trimmed === '') {
      // Reached through the tab-switch/leave-screen prompt too, not only
      // this section's own Save button — that button is `disabled` for a
      // blank name (below), but the prompt calls this function directly,
      // bypassing that disabled state. The server would refuse this
      // identically (`organizations.ts#renameInputSchema`'s own `.min(1)`),
      // so this renders the same validation message inline rather than
      // making a request that could only fail.
      setSaveError(
        new ApiError(400, {
          error: 'action_input_invalid',
          issues: [{ path: ['name'], message: 'Enter an organization name.' }],
        })
      )
      return false
    }
    setSaveError(undefined)
    setStatusMessage(undefined)
    setSaving(true)
    savingRef.current = true
    try {
      await renameOrganization(organizationId, trimmed)
      setStatusMessage(`Renamed to ${trimmed}.`)
      // WEB-57/OrganizationList.tsx's own discipline: re-read the fresh
      // account rather than trusting this response, so the header, the
      // switcher and the drawer all show the new name too, not only this
      // field.
      await refreshAccount()
      return true
    } catch (caught) {
      if (caught instanceof ApiError) setSaveError(caught)
      else throw caught
      return false
    } finally {
      setSaving(false)
      savingRef.current = false
    }
  }, [nameInput, organizationId, refreshAccount])

  // "Dirty" for this tab: the trimmed input disagrees with the
  // organization's own current name — the same value comparison
  // `pages/Usage.tsx`'s own cap input uses against its seeded value.
  const isDirty = nameInput.trim() !== organizationName.trim()

  useEffect(() => {
    onDirtyChange(isDirty)
  }, [isDirty, onDirtyChange])

  const discard = useCallback(() => {
    setNameInput(organizationName)
    setSaveError(undefined)
  }, [organizationName])

  useEffect(() => {
    if (!onRegisterActions) return
    onRegisterActions({
      save: handleSave,
      isSaving: () => savingRef.current,
      discard,
    })
    return () => onRegisterActions(null)
  }, [handleSave, discard, onRegisterActions])

  return (
    <div className="flex flex-col gap-6" data-testid="general-settings-panel">
      <h1 className="text-page-title font-semibold text-neutral-900">
        General
      </h1>

      <p role="status" className="sr-only">
        {statusMessage}
      </p>

      {/* `aria-label` deliberately distinct from the field's own "Organization
          name" label, below — `getByLabelText` (and a screen reader's
          landmark navigation) would otherwise find both this section and
          the input for the identical string, the same collision
          `pages/Usage.tsx`'s own "Spending cap" section/"Spending cap ($)"
          field pairing already avoids by not repeating itself either. */}
      <section aria-label="Name" className="flex flex-col gap-3">
        {isOwner ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-64">
              <FormField label="Organization name">
                <input
                  type="text"
                  value={nameInput}
                  onChange={(event) => {
                    setNameInput(event.target.value)
                    // WEB-69 — a blank-name refusal (above) is rendered
                    // inline rather than as a toast, so it has to be
                    // cleared the moment the person starts fixing it; left
                    // in place, it kept showing the old error text over a
                    // name that was no longer blank.
                    setSaveError(undefined)
                  }}
                  className={textInputClasses}
                />
              </FormField>
            </div>
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              disabled={saving || nameInput.trim() === ''}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        ) : (
          // A non-owner cannot rename — the server's own check refuses
          // regardless, so this reads as plain text rather than a disabled
          // control nobody reading it could ever use (this file's own
          // module comment).
          <div>
            <p className="text-sm font-medium text-neutral-800">
              Organization name
            </p>
            <p className="text-base text-neutral-900">{organizationName}</p>
          </div>
        )}
        {saveError && <ErrorMessage error={saveError} />}
      </section>

      {isOwner && (
        <div className="border-t border-neutral-200 pt-4">
          <DangerZone
            organizationId={organizationId}
            organizationName={organizationName}
            navigate={navigate}
            refreshAccount={refreshAccount}
          />
        </div>
      )}
    </div>
  )
}
