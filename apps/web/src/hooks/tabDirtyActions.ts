/**
 * WEB-69 — the "save this tab's own pending edit, or throw it away" shape
 * a dirty-able tab on `pages/OrganizationSettings.tsx` exposes to it,
 * mirroring `components/CourseInstructions.tsx#CourseInstructionsActions`
 * (`pages/CourseEditor.tsx`'s own identical need, one level up) exactly:
 * that screen's per-tab "Save changes"/"Discard changes"/"Stay" prompt
 * (`goToTabGuarded`, `pages/OrganizationSettings.tsx`) cannot reach a tab's
 * own form state any other way. Shared here, rather than each tab
 * (`pages/Usage.tsx`, `components/Team.tsx`, `components/MembershipInvitations.tsx`)
 * declaring an identical interface of its own, since all three are the
 * exact same shape — unlike `CourseInstructionsActions`, which is the only
 * component on its own page that needs one.
 */
export interface TabDirtyActions {
  /** Saves the pending edit. Resolves `true` when it was written, `false` when the save was refused or never attempted (a refusal is rendered inline in the tab itself, as it already is for that tab's own Save/Save cap/Invite button). */
  save: () => Promise<boolean>
  /** Whether a save is in flight *right now* — read synchronously, so the screen's tab prompt can decline to open over a save this tab has already started (the same reasoning `pages/CourseEditor.tsx`'s own `goToTabGuarded` already holds itself to for `CourseInstructionsActions`). */
  isSaving: () => boolean
  /** Throws the pending edit away, putting the tab's own form back to its last-saved state. */
  discard: () => void
}
