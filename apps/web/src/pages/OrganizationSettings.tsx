/**
 * WEB-69: an organization's settings, one tabbed screen in place of the
 * four separate drawer entries and screens (Discord/Team/Usage/Jobs) this
 * app used to render for them — built the same way a course's own settings
 * already are (WEB-35, `pages/CourseEditor.tsx`): the tab is part of the
 * address (`routing/route.ts#ORGANIZATION_SETTINGS_TABS`, `pages/Shell.tsx`'s
 * own `onNavigateTab`), the tab bar is a real `role="tablist"` reachable by
 * arrow keys with roving `tabIndex`, and a tab's own contents load only once
 * it is first opened (`visitedTabs`, below — `pages/CourseEditor.tsx`'s own
 * "rework round 1, must-fix 1" reasoning applies verbatim: every tab ever
 * shown stays mounted, hidden, so switching tabs never strands an in-flight
 * fetch or a pending edit the way conditionally rendering the active tab
 * alone used to).
 *
 * **General is a fifth tab, added by this slice, first in the bar and the
 * default.** WEB-69's own SPEC text names four; this slice's own decision
 * (`docs/DECISIONS.md`) adds General for the organization's own name
 * (`components/GeneralSettings.tsx`, reusing WEB-57's existing rename) and,
 * at its own bottom, the Danger zone (`components/DangerZone.tsx`,
 * WEB-72/DATA-7's delete-organization control, moved out of
 * `components/Team.tsx` where it used to live). Rework round 1 tried a
 * *sixth* tab, Danger zone on its own, reached only by an owner; the user's
 * own final decision folds it into General instead — see
 * `components/GeneralSettings.tsx`'s own module comment and
 * `docs/DECISIONS.md` for why. Every tab here — General included — renders
 * for every caller regardless of role; a tab's own contents decide what an
 * owner sees that a non-owner does not, the same split Team/Usage already
 * draw for their own owner-only sections.
 *
 * **The Discord tab now fetches on its own first visit, like every other
 * tab.** Rework round 1 kept `discordServers.list` eager, in `Shell.tsx`,
 * as a deliberate one-tab exception. The user's own final decision removes
 * that exception: `components/DiscordSettings.tsx` fetches from its own
 * mount effect, and this screen's `visitedTabs` is what decides when that
 * mount happens — see that file's own module comment for the fetch itself,
 * carried over verbatim from `Shell.tsx`'s former implementation, and
 * `docs/DECISIONS.md` for why switching organization needs no extra logic
 * here beyond this screen's own existing `key={activeOrganizationId}`
 * remount (`pages/Shell.tsx`).
 *
 * **Per-tab unsaved changes, not one shared flag.** General's own name
 * field, Usage's spending-cap input and Team's grant/invitation forms are
 * the three tabs with anything to lose; Discord and Jobs never hold a
 * pending edit at all. Each dirty-able tab reports its own flag through
 * `onDirtyChange` and exposes a save/discard handle through
 * `onRegisterActions` (`hooks/tabDirtyActions.ts`), the same shape
 * `components/CourseInstructions.tsx` already exposes `pages/CourseEditor.tsx`
 * one level up — `tabDirty`/`tabActionsRef`, below, are this screen's own
 * versions of that file's `instructionsDirty`/`instructionsActionsRef`.
 * `goToTabGuarded` asks the WEB-38 three-answer question (save/discard/stay,
 * Cancel and `Escape` both meaning stay) exactly the way
 * `pages/CourseEditor.tsx#goToTabGuarded` already does; leaving the screen
 * altogether asks the identical question through a guard this screen
 * registers directly with `hooks/navigation-guard.tsx`'s own `registerGuard`
 * (below) rather than `hooks/useUnsavedChangesGuard.ts`'s own `confirmDiscard`
 * — that hook's own two-answer "discard, or keep editing" is right for
 * `pages/CourseEditor.tsx` (this screen's own decision on why it does not
 * reuse it verbatim is in `docs/DECISIONS.md`), but WEB-69's own text asks
 * for the identical three-answer prompt on *both* moves here, and a plain
 * `confirm` cannot express "save and carry on" as a third answer. The
 * `beforeunload` half of that hook is still what this screen wants for a
 * browser-level unload, so it is reproduced verbatim below rather than
 * invented twice.
 *
 * A tab's own label carries a small "•" once it holds an unsaved edit —
 * kept from this slice's first round; `docs/DECISIONS.md` records that it
 * is optional but harmless, not a requirement this rework needed to add.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'

import type { AccountSummary } from '../api/types.js'
import { DiscordSettings } from '../components/DiscordSettings.js'
import { GeneralSettings } from '../components/GeneralSettings.js'
import { useModal } from '../components/modal/ModalProvider.js'
import { Team } from '../components/Team.js'
import { useNavigationGuard } from '../hooks/navigation-guard.js'
import type { TabDirtyActions } from '../hooks/tabDirtyActions.js'
import {
  ORGANIZATION_SETTINGS_TABS,
  type OrganizationSettingsTab,
  type Route,
} from '../routing/route.js'
import { Jobs } from './Jobs.js'
import { Usage } from './Usage.js'

/** WEB-69 — a label for each of `ORGANIZATION_SETTINGS_TABS`'s own ids — the tab bar's own concern, not the routing module's, the same split `pages/CourseEditor.tsx#TAB_LABELS` already holds itself to. */
const TAB_LABELS: Record<OrganizationSettingsTab, string> = {
  general: 'General',
  discord: 'Discord',
  team: 'Team',
  usage: 'Usage',
  jobs: 'Jobs',
}

export interface OrganizationSettingsProps {
  organizationId: string
  /** WEB-69 — which tab is on screen; always concrete (`parseRoute` fills in the first tab for a bare `/settings`), never `undefined`, the same discipline `pages/CourseEditor.tsx`'s own `tab` prop holds for an existing course. */
  tab: OrganizationSettingsTab
  /** WEB-69 — called when a tab control is clicked (or the arrow keys move selection), so `pages/Shell.tsx` can push the new address; this component's own `activeTab` state updates immediately regardless, the same "the click renders before the parent's prop comes back" reasoning `pages/CourseEditor.tsx`'s own `onNavigateTab` doc comment gives. */
  onNavigateTab: (tab: OrganizationSettingsTab) => void
  /** Whether the caller's own membership in this organization is `'owner'` — decides whether General's own name field and Danger zone render editable/at all, and whether Team's own grant form renders (`components/Team.tsx`'s own module comment). */
  isOwner: boolean
  /** The caller's own account id (ENRL-11) — threaded straight to `components/Team.tsx`. */
  viewerAccountId: string
  /** This organization's own name, threaded straight to `components/GeneralSettings.tsx` (its own field, and its own `DangerZone`'s typed-name gate). */
  organizationName: string
  /** `pages/Shell.tsx`'s own `navigate`, threaded straight to `components/GeneralSettings.tsx`. */
  navigate: (route: Route, options?: { replace?: boolean }) => void
  /** `App.tsx`'s own `refreshAccount` adapter, threaded straight to `components/GeneralSettings.tsx` — called after a rename, and after a delete. */
  refreshAccount: () => Promise<AccountSummary | undefined>
  /** TEN-8/WEB-4 — threaded straight to `components/DiscordSettings.tsx`, which is the one place that actually reads it (this file's own module comment on why the Discord tab no longer needs anything else from this screen). */
  justInstalled?: { organizationId: string; serverId: string }
}

export function OrganizationSettings({
  organizationId,
  tab,
  onNavigateTab,
  isOwner,
  viewerAccountId,
  organizationName,
  navigate,
  refreshAccount,
  justInstalled,
}: OrganizationSettingsProps) {
  // WEB-69 — every tab renders for every caller now; a role decides what a
  // tab's own contents show (General's own field/Danger zone, Team's own
  // grant form), not whether the tab exists at all (this file's own module
  // comment on why rework round 1's owner-only Danger zone tab did not
  // survive to this round).
  const tabs = ORGANIZATION_SETTINGS_TABS

  // The same `activeTab`/`activeTabRef`/`visitedTabs` shape
  // `pages/CourseEditor.tsx` already holds itself to — see that file's own
  // module comment for why a ref is needed alongside the state (reading the
  // *current* tab from inside an async save that has crossed an `await`)
  // and why a tab, once visited, stays mounted rather than being unmounted
  // the moment it is not the active one.
  const [activeTab, setActiveTab] = useState<OrganizationSettingsTab>(tab)
  const activeTabRef = useRef(activeTab)
  const [visitedTabs, setVisitedTabs] = useState<Set<OrganizationSettingsTab>>(
    () => new Set([tab])
  )
  useEffect(() => {
    activeTabRef.current = tab
    setActiveTab(tab)
    setVisitedTabs((current) =>
      current.has(tab) ? current : new Set(current).add(tab)
    )
  }, [tab])

  const tabButtonRefs = useRef<Map<OrganizationSettingsTab, HTMLButtonElement>>(
    new Map()
  )
  const goToTab = useCallback(
    (next: OrganizationSettingsTab) => {
      activeTabRef.current = next
      setActiveTab(next)
      setVisitedTabs((current) =>
        current.has(next) ? current : new Set(current).add(next)
      )
      onNavigateTab(next)
      tabButtonRefs.current.get(next)?.focus()
    },
    [onNavigateTab]
  )

  // WEB-69 — each dirty-able tab's own flag, and its own save/discard
  // handle, keyed by tab id — the same `instructionsDirty`/
  // `instructionsActionsRef` shape `pages/CourseEditor.tsx` holds for its
  // one nested section, generalised here to however many of this screen's
  // own tabs actually register one (today: General, Team and Usage;
  // Discord and Jobs never call `onRegisterActions`/`onDirtyChange` at
  // all, so they simply never appear in either map).
  const [tabDirty, setTabDirty] = useState<
    Partial<Record<OrganizationSettingsTab, boolean>>
  >({})
  const tabActionsRef = useRef<
    Partial<Record<OrganizationSettingsTab, TabDirtyActions>>
  >({})
  const registerTabDirty = useCallback(
    (id: OrganizationSettingsTab) => (dirty: boolean) => {
      setTabDirty((current) =>
        current[id] === dirty ? current : { ...current, [id]: dirty }
      )
    },
    []
  )
  const registerTabActions = useCallback(
    (id: OrganizationSettingsTab) => (actions: TabDirtyActions | null) => {
      if (actions) tabActionsRef.current[id] = actions
      else delete tabActionsRef.current[id]
    },
    []
  )

  const isDirty = Object.values(tabDirty).some(Boolean)
  const { choose } = useModal()
  // Round 2 finding (mirroring `pages/CourseEditor.tsx#saveDirtyWork`'s own
  // "which of two independent halves is actually dirty" split) — true only
  // for the currently active tab's own flag, since a switch or a leave only
  // ever asks about the tab actually showing.
  const activeTabDirty = tabDirty[activeTabRef.current] ?? false

  /** Saves whichever tab this screen is asking about, through that tab's own registered actions. `false` when no actions are registered at all — defended, not assumed, the same discipline `pages/CourseEditor.tsx#saveDirtyWork`'s own doc comment already holds itself to for the identical "should never happen but is not asserted" case. */
  const saveTab = async (id: OrganizationSettingsTab): Promise<boolean> => {
    const actions = tabActionsRef.current[id]
    if (!actions) return false
    return actions.save()
  }
  const discardTab = (id: OrganizationSettingsTab) => {
    tabActionsRef.current[id]?.discard()
  }
  const isTabSaving = (id: OrganizationSettingsTab): boolean =>
    tabActionsRef.current[id]?.isSaving() ?? false

  /**
   * WEB-38/WEB-69 — a tab switch a person actually asked for (a click, or
   * the arrow keys), mirroring `pages/CourseEditor.tsx#goToTabGuarded`
   * almost exactly: three answers (save/discard/stay), Cancel and `Escape`
   * both meaning stay, and a tab click ignored outright while a save for
   * the active tab is already in flight (that file's own "must-fix 1"
   * reasoning — opening a second prompt over a save whose `baseline` has
   * not moved yet).
   */
  const goToTabGuarded = async (next: OrganizationSettingsTab) => {
    if (next === activeTabRef.current) return
    if (isTabSaving(activeTabRef.current)) return
    if (!activeTabDirty) {
      goToTab(next)
      return
    }
    const choice = await choose({
      title: 'Save your changes?',
      description:
        'You have changed settings that are not saved yet. Save them, discard them, or stay on this tab.',
      confirmLabel: 'Save changes',
      altLabel: 'Discard changes',
      cancelLabel: 'Cancel',
    })
    if (choice === 'cancel') return
    if (choice === 'confirm') {
      if (!(await saveTab(activeTabRef.current))) return
    } else {
      discardTab(activeTabRef.current)
    }
    goToTab(next)
  }

  // WEB-69 — leaving the screen altogether (the drawer, the home control,
  // an organization switch) asks the identical three-answer question, not
  // `hooks/useUnsavedChangesGuard.ts`'s own two-answer `confirmDiscard` —
  // this screen's own module comment, and `docs/DECISIONS.md`, have why.
  // Registered directly with `hooks/navigation-guard.tsx` rather than
  // through that hook, since the hook bundles this registration together
  // with its own two-answer dialog and there is no way to take only its
  // `beforeunload` half.
  const { registerGuard } = useNavigationGuard()
  useEffect(() => {
    if (!isDirty) {
      registerGuard(null)
      return () => registerGuard(null)
    }
    registerGuard(async () => {
      if (isTabSaving(activeTabRef.current)) return false
      const choice = await choose({
        title: 'Save your changes?',
        description:
          'You have changed settings that are not saved yet. Save them, discard them, or stay on this screen.',
        confirmLabel: 'Save changes',
        altLabel: 'Discard changes',
        cancelLabel: 'Cancel',
      })
      if (choice === 'cancel') return false
      if (choice === 'confirm') return saveTab(activeTabRef.current)
      discardTab(activeTabRef.current)
      return true
    })
    return () => registerGuard(null)
    // `isTabSaving`/`saveTab`/`discardTab` read `tabActionsRef.current`
    // fresh on every call already (a plain ref, not a dependency), and
    // `activeTabRef.current` is read the same way `pages/CourseEditor.tsx#goToTabGuarded`
    // reads its own — deliberately not in this effect's own deps, so
    // re-registering on every tab switch (which does not change whether
    // this screen is dirty) is not needed.
  }, [isDirty, registerGuard, choose])

  // The same `beforeunload` half `hooks/useUnsavedChangesGuard.ts` already
  // gives every other dirty form in this app — reproduced here rather than
  // shared, since that hook's own registration half is not what this screen
  // wants (this file's own module comment on why).
  useEffect(() => {
    if (!isDirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  // Rework round 1, must-fix 6 mirror (`pages/CourseEditor.tsx`'s own
  // keyboard handler) — Left/Right cycle with wraparound, Home/End jump to
  // the first/last tab, attached to the `tablist` itself.
  const handleTabListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = tabs.indexOf(activeTabRef.current)
    let nextIndex: number
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (currentIndex + 1) % tabs.length
        break
      case 'ArrowLeft':
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = tabs.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    void goToTabGuarded(tabs[nextIndex]!)
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-page-title font-semibold text-neutral-900">
        Organization settings
      </h1>

      <div
        role="tablist"
        aria-label="Organization settings"
        // WEB-48/WEB-71 mirror — `pages/CourseEditor.tsx`'s own tablist
        // uses the identical `overflow-x-auto`: five tabs do not all fit a
        // phone-width screen, and a tablist that cannot scroll sideways
        // instead pushed the whole page wider than the viewport
        // (`e2e/mobile-viewport.spec.ts`'s own WEB-48 case).
        className="flex gap-1 overflow-x-auto border-b border-neutral-200"
        onKeyDown={handleTabListKeyDown}
      >
        {tabs.map((id) => (
          <button
            key={id}
            ref={(element) => {
              if (element) tabButtonRefs.current.set(id, element)
              else tabButtonRefs.current.delete(id)
            }}
            id={`organization-settings-tab-${id}`}
            role="tab"
            type="button"
            aria-selected={activeTab === id}
            aria-controls={`organization-settings-tabpanel-${id}`}
            tabIndex={activeTab === id ? 0 : -1}
            onClick={() => void goToTabGuarded(id)}
            className={
              activeTab === id
                ? 'border-b-2 border-brand-600 px-3 py-2 text-sm font-medium text-brand-700'
                : 'border-b-2 border-transparent px-3 py-2 text-sm font-medium text-neutral-500 hover:text-neutral-700'
            }
          >
            {TAB_LABELS[id]}
            {tabDirty[id] && ' •'}
          </button>
        ))}
      </div>

      {visitedTabs.has('general') && (
        <div
          role="tabpanel"
          id="organization-settings-tabpanel-general"
          aria-labelledby="organization-settings-tab-general"
          hidden={activeTab !== 'general'}
        >
          <GeneralSettings
            organizationId={organizationId}
            organizationName={organizationName}
            isOwner={isOwner}
            navigate={navigate}
            refreshAccount={refreshAccount}
            onDirtyChange={registerTabDirty('general')}
            onRegisterActions={registerTabActions('general')}
          />
        </div>
      )}

      {visitedTabs.has('discord') && (
        <div
          role="tabpanel"
          id="organization-settings-tabpanel-discord"
          aria-labelledby="organization-settings-tab-discord"
          hidden={activeTab !== 'discord'}
        >
          <DiscordSettings
            organizationId={organizationId}
            {...(justInstalled ? { justInstalled } : {})}
          />
        </div>
      )}

      {visitedTabs.has('team') && (
        <div
          role="tabpanel"
          id="organization-settings-tabpanel-team"
          aria-labelledby="organization-settings-tab-team"
          hidden={activeTab !== 'team'}
        >
          <Team
            organizationId={organizationId}
            isOwner={isOwner}
            viewerAccountId={viewerAccountId}
            onDirtyChange={registerTabDirty('team')}
            onRegisterActions={registerTabActions('team')}
          />
        </div>
      )}

      {visitedTabs.has('usage') && (
        <div
          role="tabpanel"
          id="organization-settings-tabpanel-usage"
          aria-labelledby="organization-settings-tab-usage"
          hidden={activeTab !== 'usage'}
        >
          <Usage
            organizationId={organizationId}
            isOwner={isOwner}
            onDirtyChange={registerTabDirty('usage')}
            onRegisterActions={registerTabActions('usage')}
          />
        </div>
      )}

      {visitedTabs.has('jobs') && (
        <div
          role="tabpanel"
          id="organization-settings-tabpanel-jobs"
          aria-labelledby="organization-settings-tab-jobs"
          hidden={activeTab !== 'jobs'}
        >
          <Jobs organizationId={organizationId} />
        </div>
      )}
    </div>
  )
}
