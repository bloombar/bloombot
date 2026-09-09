/**
 * WEB-8/WEB-9: a course, defined entirely in the panel — CFG-2 (OpenAI
 * settings), CFG-3 (roles) and CFG-4 (categories and channels), saved
 * through `courses.save` (create when `courseId` is `undefined`, update
 * otherwise). Whether a course is enabled is one of those fields, saved
 * with the rest — this screen no longer carries an immediate
 * `courses.enable`/`courses.disable` control of its own (`enabledControl`,
 * below, on why, and `pages/Courses.tsx` for the one that remains).
 *
 * WEB-9: the category and role names are what decides which questions reach
 * this course, so they are shown together, prominently, at the top of the
 * form — not buried among the other fields — and a save refused for a
 * PROJ-3 collision is rendered through the same `ErrorMessage` every other
 * refusal in this app uses, which already renders `conflict.message`
 * (`components/ErrorMessage.tsx`) — the sentence `repos/courses.ts` writes
 * naming the other course and its project (D-18).
 *
 * How this form's fields map onto `courses.save`'s own partial-update rule
 * (an omitted field preserves what is stored, an explicit `null` clears
 * it — `docs/DECISIONS.md`): this form always submits every field it
 * manages, translating an empty input into an explicit `null` rather than
 * ever omitting the key — so it never relies on "omitted" at all for those
 * fields (that distinction exists for a partial API caller, not a form that
 * always knows the whole record it is editing). `conversationScope` is the
 * one field this form does not manage at all (CFG-2..4 do not mention it);
 * leaving it out of the request body is a deliberate use of "omitted", not
 * an oversight — the save preserves it on an update and lets `courses.save`
 * apply its own default on a create.
 *
 * MDL-8: `promptId` is the other field this form does not manage as an
 * editable control — it is read-only where a course already has one (a
 * banner above Instructions says the stored prompt is what actually
 * answers, and the field itself, plain text below it), and never rendered
 * for a course that does not. The request never carries the key at all
 * (see `handleSave`'s own comment on why) — this is not another instance of
 * this file's own "always submit every field it manages" rule, since this
 * form does not manage this one; `courses.save`'s own execute enforces the
 * write-side half (no new course may acquire one even if a caller supplies
 * one directly, `packages/actions/src/actions/courses.ts`'s own comment).
 *
 * WEB-19/FILE-4: Instructions is not one of this form's own fields at all
 * any more — `components/CourseInstructions.tsx`, embedded below, saves it
 * through the versioned `courseInstructions.save` instead of this form's
 * `courses.save`, which no longer accepts the field
 * (`packages/actions/src/actions/courses.ts`'s own comment,
 * `docs/DECISIONS.md` D-54). Offered on the same "existing record only" gate
 * as the knowledge files and Discord channels sections below — a course
 * that does not exist yet has nothing for a revision's `courseId` to point
 * at. Its own dirtiness is folded into this form's one `isDirty`
 * (`instructionsDirty`, below) rather than that component registering a
 * second navigation guard — see its own module comment for why.
 *
 * WEB-18/FILE-1..3: a course's knowledge files (what it is grounded in) are
 * `components/CourseAttachments.tsx`'s own screen, embedded below — see
 * that file's module comment for the upload/pending/ready/failed/detach
 * shape; this file only decides where it sits and that it is offered for
 * an existing course, the same "existing record only" gate the Discord
 * channels section and the enable/disable toggle both already use.
 *
 * WEB-20/WEB-21: a course's join links and roster import are, respectively,
 * `components/JoinLinks.tsx` and `components/RosterImport.tsx`'s own
 * screens, embedded below on the same "existing record only" gate — see
 * each file's own module comment for its own shape (a link's secret shown
 * once at creation; an import's format description, progress and per-row
 * report). This file only decides where the two sit, keeping this already
 * large form's own growth to that.
 *
 * WEB-22/ENRL-9: a course's people — everyone it has ever enrolled, active
 * and ended alike, with ending (ENRL-6) and reinstating (ENRL-9) both
 * offered — are `components/CoursePeople.tsx`'s own screen, embedded below
 * on the same "existing record only" gate as everything else in this list.
 *
 * WEB-35: an existing course renders these sections under five named tabs
 * (General/AI/Discord/Roster/People) rather than one long scroll — the tab
 * is part of the course's own canonical address
 * (`routing/route.ts#CourseEditorTab`), so `activeTab`, below, is seeded
 * from the `tab` prop `pages/ProjectsPanel.tsx` reads off the route, and a
 * click on a tab calls `onNavigateTab` so that address changes too, the
 * same "a tab is a real address" discipline WEB-32/WEB-34 already hold this
 * whole panel to.
 *
 * Rework round 1, must-fix 1: every tab this course editor has ever shown
 * stays mounted — hidden with the `hidden` attribute, never unmounted —
 * once it has been shown once (`visitedTabs`, below); a tab never opened
 * this render still does not mount at all, so a course editor still does
 * not fetch attachments, people or websites until asked. Conditionally
 * rendering each panel (mounting only the active one) used to unmount
 * whatever was not showing, which cost `CourseInstructions` and
 * `JoinLinks` their own local state (an in-progress edit, a shown-once
 * plaintext secret) and killed `RosterImport`/`CourseAttachments`'s
 * in-flight polling outright — so switching tabs now genuinely cannot
 * strand anything on this whole screen, not merely the `form`/`baseline`
 * object every tab already shared. `activeTab` only ever decides which
 * mounted panel is *visible*.
 *
 * WEB-38: leaving a tab with unsaved settings asks first — save, discard,
 * or stay put (`goToTabGuarded`, below). Nothing is lost by switching
 * tabs (every panel stays mounted), so this is about not wandering away
 * from an edit and forgetting it, not about rescuing state.
 *
 * A brand-new course (`courseId === undefined`) has none of this — it
 * cannot have join links, a roster import, people, attachments,
 * instructions or websites (they are all already gated on
 * `courseId !== undefined`, unchanged by this slice), so there is nothing
 * worth splitting into tabs; it keeps the single-form layout it always
 * had, and `tab`/`onNavigateTab` are simply not read.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'

import {
  ApiError,
  getCourse,
  listDiscordServers,
  saveCourse,
} from '../api/client.js'
import type { SaveCourseCategoryInput, SaveCourseInput } from '../api/client.js'
import { isActiveDiscordBinding } from '../api/types.js'
import type {
  Course,
  DiscordServerBindingSummary,
  Project,
} from '../api/types.js'
import {
  COURSE_EDITOR_TABS as COURSE_EDITOR_TAB_IDS,
  type CourseEditorTab,
  type Route,
} from '../routing/route.js'
import { Button } from '../components/Button.js'
import { CourseAttachments } from '../components/CourseAttachments.js'
import { CourseInstructions } from '../components/CourseInstructions.js'
import type { CourseInstructionsActions } from '../components/CourseInstructions.js'
import { CoursePeople } from '../components/CoursePeople.js'
import { CourseWebSources } from '../components/CourseWebSources.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { checkboxClasses, textInputClasses } from '../components/fieldStyles.js'
import { FormField } from '../components/FormField.js'
import { JoinLinks } from '../components/JoinLinks.js'
import { useModal } from '../components/modal/ModalProvider.js'
import { RosterImport } from '../components/RosterImport.js'
import { ScaffoldButton } from '../components/ScaffoldButton.js'
import { useFormDirty } from '../hooks/useFormDirty.js'
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard.js'
import { AddIcon, RemoveFromListIcon, WarningIcon } from '../icons.js'

export interface CourseEditorProps {
  organizationId: string
  project: Project
  /** `undefined` — define a new course. A string — edit the course with that id. */
  courseId: string | undefined
  /**
   * WEB-35 — which of the five tabs is on screen, for an existing course.
   * `undefined` for a new course (this file's own module comment on why),
   * and optional here besides — every call site that does not care which
   * tab is showing (most of `tests/course-editor.test.tsx`) can leave it
   * out and get `'general'`, the same default `routing/route.ts` gives a
   * bare `/courses/:courseId` URL.
   */
  tab?: CourseEditorTab
  /** WEB-35 — called when a tab control is clicked, so the caller (`pages/ProjectsPanel.tsx`) can push the new address; this component's own `activeTab` state updates immediately regardless, so a caller that ignores this (a unit test with no `navigate`) still sees the tab switch render. */
  onNavigateTab?: (tab: CourseEditorTab) => void
  /** WEB-36 — threaded straight through to `components/CoursePeople.tsx`'s own People tab, so a click on a person's name there can push that person's transcript address; see that file's own module comment for the click itself. */
  navigate: (route: Route, options?: { replace?: boolean }) => void
  onSaved: (course: Course) => void
  onCancel: () => void
}

/** WEB-35 — a label for each of `routing/route.ts#COURSE_EDITOR_TABS`'s own ids — the tab bar's own concern, not the routing module's, so it stays here rather than growing that array into something UI-shaped. */
const TAB_LABELS: Record<CourseEditorTab, string> = {
  general: 'General',
  ai: 'AI',
  discord: 'Discord',
  roster: 'Roster',
  people: 'People',
}

/** WEB-35 (rework round 1, cheap fix) — derived from `routing/route.ts#COURSE_EDITOR_TABS`, the one array the type, the parser's runtime guard and this tab bar all now agree with — a sixth tab is one edit there, plus one label above. */
const COURSE_EDITOR_TABS: { id: CourseEditorTab; label: string }[] =
  COURSE_EDITOR_TAB_IDS.map((id) => ({ id, label: TAB_LABELS[id] }))

/**
 * WEB-35/WEB-16: which tab a given `SaveCourseInput` field's name lives
 * under — a refused save's `error.body.issues` names a field
 * (`fieldErrorMessage`, above), and a field on a tab other than the one
 * showing would otherwise refuse silently, with `fieldErrorProp`'s own
 * inline message rendered on a tab nobody is looking at. `categories` maps
 * here too even though no single `FormField` reads it through
 * `fieldErrorProp` — the fieldset itself lives on the Discord tab, so a
 * collision naming it still lands somewhere the category/channel rows are
 * visible. Every field named here has a `fieldErrorProp` somewhere in this
 * form (rework round 1, must-fix 5: `model` used not to, which meant a
 * refusal naming it switched tabs and pushed a history entry for a message
 * that then rendered nowhere at all — `aiFields`, below, now reads it).
 */
const FIELD_TABS: Record<string, CourseEditorTab> = {
  title: 'general',
  adminsRole: 'discord',
  studentsRole: 'discord',
  discordServerId: 'discord',
  categories: 'discord',
  model: 'ai',
  maxRequestsPerDay: 'ai',
}

/** Form-local shape for one category being edited — a generated `key` for React's list identity, never sent to the server (`SaveCourseCategoryInput` carries no id at all — `courses.save` always replaces a course's whole category/channel list). */
interface EditableChannel {
  key: string
  name: string
  adminsOnly: boolean
}
interface EditableCategory {
  key: string
  name: string
  channels: EditableChannel[]
}

function newKey(): string {
  return crypto.randomUUID()
}

function emptyCategory(): EditableCategory {
  return { key: newKey(), name: '', channels: [] }
}

/**
 * `form.maxRequestsPerDay` is a raw text input, so it has to be validated
 * before it can become `SaveCourseInput.maxRequestsPerDay` — `courses.save`
 * requires it to be either absent (kept), `null` (cleared) or a positive
 * integer (`packages/actions/src/actions/courses.ts`'s own
 * `z.number().int().positive()`). Blank means "clear it," anything else has
 * to parse as that same positive integer or this returns `{ ok: false }` —
 * never a `NaN`, which `JSON.stringify` would silently turn into `null` and
 * clear the stored cap without telling anyone (finding 2 of the WEB-7
 * rework).
 */
function parseMaxRequestsPerDay(
  raw: string
): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  if (!/^\d+$/.test(trimmed)) return { ok: false }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value <= 0) return { ok: false }
  return { ok: true, value }
}

/**
 * WEB-16: "a refusal names the field it concerns and appears next to it
 * rather than only at the top." `error.body.issues` already carries
 * `{ path, message }` per field — both this form's own client-side check
 * (`handleSave`'s own `maxRequestsPerDay` refusal, above) and a refused
 * `courses.save` (`action_input_invalid`) build it the same way — this
 * just reads the one issue naming `fieldName`, if any, so the field's own
 * `FormField` can render it right there. `ErrorMessage` at the top of this
 * form still renders the same summary it always has (WEB-5's own
 * convention every other refusal in this app already follows); this is
 * additive, not a replacement for it.
 */
function fieldErrorMessage(
  error: ApiError | undefined,
  fieldName: string
): string | undefined {
  return error?.body.issues?.find((issue) => issue.path[0] === fieldName)
    ?.message
}

/**
 * `FormField`'s own `error?: string` is exact-optional (`tsconfig.base.json`),
 * so passing `error={fieldErrorMessage(...)}` directly fails to typecheck
 * whenever it is `undefined` — this spreads the prop in only when there
 * actually is a message, the same `{...(x ? { prop: x } : {})}` device this
 * file's own `handleSave` already uses for `SaveCourseInput`'s optional
 * fields.
 */
function fieldErrorProp(
  error: ApiError | undefined,
  fieldName: string
): { error: string } | Record<string, never> {
  const message = fieldErrorMessage(error, fieldName)
  return message !== undefined ? { error: message } : {}
}

/** Blank editable state for a brand-new course — `enabled: false`: a fresh course's category and role names have not been confirmed against this term's Discord server yet, so it starts disabled the same way a duplicated course does (D-23), rather than defaulting to routing immediately. Carries no `instructions` field at all (WEB-19) — `components/CourseInstructions.tsx` manages that on its own, gated to an existing course. */
function blankForm() {
  return {
    title: '',
    enabled: false,
    adminsRole: '',
    studentsRole: '',
    promptId: '',
    model: '',
    vectorStoreId: '',
    maxRequestsPerDay: '',
    // ENRL-13/ENRL-14 — the same defaults `schema.ts`'s own database columns
    // carry: a brand-new course starts with today's behaviour, not with
    // either box already ticked or unticked the other way.
    selfEnrolFromDiscord: false,
    answerUnenrolled: true,
    // TEN-9 — `null` resolves through the organization's own single active
    // binding, the same "not configured yet" reading `promptId`/`model`
    // etc. above already carry — a brand-new course starts undecided, not
    // pinned to whichever server happens to be active right now.
    discordServerId: null as string | null,
    categories: [] as EditableCategory[],
  }
}

function formFromCourse(course: Course) {
  return {
    title: course.title,
    enabled: course.enabled,
    adminsRole: course.adminsRole,
    studentsRole: course.studentsRole,
    promptId: course.promptId ?? '',
    model: course.model ?? '',
    vectorStoreId: course.vectorStoreId ?? '',
    maxRequestsPerDay:
      course.maxRequestsPerDay === null ? '' : String(course.maxRequestsPerDay),
    selfEnrolFromDiscord: course.selfEnrolFromDiscord,
    answerUnenrolled: course.answerUnenrolled,
    discordServerId: course.discordServerId,
    categories: course.categories.map((category) => ({
      key: newKey(),
      name: category.name,
      channels: category.channels.map((channel) => ({
        key: newKey(),
        name: channel.name,
        adminsOnly: channel.adminsOnly,
      })),
    })),
  }
}

type FormState = ReturnType<typeof blankForm>

export function CourseEditor({
  organizationId,
  project,
  courseId,
  tab,
  onNavigateTab,
  navigate,
  onSaved,
  onCancel,
}: CourseEditorProps) {
  // WEB-35 — local UI state, not part of `form`/`baseline`: which tab is
  // rendered is not part of the record being edited. Seeded from the `tab`
  // prop (the route's own reading, or `'general'` for either a bare URL or
  // a call site that does not pass one), and re-seeded whenever the prop
  // itself changes — the one path a click on a tab control does *not* take
  // (that path sets this directly, below, so the tab switches on the same
  // render as the click rather than waiting on the parent to feed the new
  // `tab` back down) but a browser Back/Forward between tabs does, since
  // `routing/useRoute.ts`'s own `popstate` handler bypasses the
  // unsaved-changes guard for exactly this move
  // (`route.ts#isSameCourseEditorScreen`) and lets the new `tab` prop
  // through directly (WEB-34).
  const [activeTab, setActiveTab] = useState<CourseEditorTab>(tab ?? 'general')
  // Rework round 1, must-fix 3: `switchToTabForField` runs inside a
  // `handleSave` that has just crossed an `await` (the server round trip),
  // so a plain closure over `activeTab` would read whatever tab was active
  // when `handleSave` was *called*, not the one showing when the refusal
  // actually lands — a save started on General, followed by a click to AI
  // before the response arrives, compared the refusal's tab against a
  // `'general'` that is no longer true. Kept in lockstep with `activeTab`
  // everywhere the latter is set, rather than read fresh from state,
  // exactly so `switchToTabForField` (and the keyboard handler below) can
  // read the *current* tab through a ref without waiting on a render.
  const activeTabRef = useRef(activeTab)
  // Rework round 1, must-fix 1: every tab ever shown for this course stays
  // mounted from here on (hidden, not unmounted) — seeded with whichever
  // tab is showing first, the same "General unless the address says
  // otherwise" reasoning `activeTab` itself already uses. Reset to just
  // the incoming tab whenever `courseId` changes (the data-loading effect,
  // below) — otherwise a tab visited on one course would wrongly start
  // "already visited," and therefore mounted and fetching, the moment a
  // different course loaded into this same, reused component instance.
  const [visitedTabs, setVisitedTabs] = useState<Set<CourseEditorTab>>(
    () => new Set([tab ?? 'general'])
  )
  useEffect(() => {
    const next = tab ?? 'general'
    activeTabRef.current = next
    setActiveTab(next)
    setVisitedTabs((current) =>
      current.has(next) ? current : new Set(current).add(next)
    )
  }, [tab])
  // Rework round 1, must-fix 6: the WAI-ARIA tabs keyboard interaction —
  // roving `tabIndex` (`course-editor-tab`'s own `tabIndex` prop, below)
  // plus Left/Right/Home/End moving *and activating* selection (automatic
  // activation, the same model a native `<select>` gives arrow keys) —
  // needs to move DOM focus itself, not only React state, so each tab
  // button's own element is kept here through a ref callback.
  const tabButtonRefs = useRef<Map<CourseEditorTab, HTMLButtonElement>>(
    new Map()
  )
  const goToTab = useCallback(
    (next: CourseEditorTab) => {
      activeTabRef.current = next
      setActiveTab(next)
      setVisitedTabs((current) =>
        current.has(next) ? current : new Set(current).add(next)
      )
      onNavigateTab?.(next)
      // Rework round 1, must-fix 6: also runs for a save-refusal's own
      // auto-switch (`switchToTabForField`, below) — moving focus there is
      // what makes that switch not silent; harmless on an ordinary click,
      // which already put focus on this same button.
      tabButtonRefs.current.get(next)?.focus()
    },
    [onNavigateTab]
  )
  const [form, setForm] = useState<FormState>(blankForm())
  // WEB-16: the form's own last agreed-with-the-server state — set
  // alongside `form` in the same three places `form` is ever set *from* a
  // real record rather than an edit (a fresh blank form, a load, a save),
  // never on a field-by-field edit. `useFormDirty` compares this against
  // the live `form` below; see that hook's own module comment for why
  // "dirty" is a value comparison, not a keystroke count.
  const [baseline, setBaseline] = useState<FormState>(blankForm())
  // WEB-19: `components/CourseInstructions.tsx` manages its own text and
  // its own save, entirely outside `form`/`baseline` above — this is the
  // one piece of *its* dirtiness this page needs, folded into the same
  // `isDirty` the navigation guard already reads, since
  // `hooks/navigation-guard.tsx` only ever honours one registered guard at
  // a time (that component's own module comment).
  const [instructionsDirty, setInstructionsDirty] = useState(false)
  // Kept apart from `isDirty` below because the tab prompt has to act on
  // each half separately: "Save changes" saves the course form through
  // `courses.save` and the instructions through their own
  // `courseInstructions.save`, and either half may be clean while the
  // other is not (`saveDirtyWork`, below).
  const formDirty = useFormDirty(baseline, form)
  const isDirty = formDirty || instructionsDirty
  const { confirmDiscard } = useUnsavedChangesGuard(isDirty)
  const { confirm, choose } = useModal()
  // The handles `components/CourseInstructions.tsx` registers, so the tab
  // prompt's own Save/Discard can reach an unsaved instructions edit —
  // that section owns its text and its own save (its module comment), so
  // there is no other way in. `null` whenever the AI tab has never been
  // opened (the section is not mounted) or the course is brand new.
  const instructionsActionsRef = useRef<CourseInstructionsActions | null>(null)
  const handleRegisterInstructionsActions = useCallback(
    (actions: CourseInstructionsActions | null) => {
      instructionsActionsRef.current = actions
    },
    []
  )
  const [loading, setLoading] = useState(courseId !== undefined)
  // Finding 3 (WEB-7 rework): a failed `courses.get` used to clear `loading`
  // and fall through to the same form a real, empty course renders — fillable
  // and saveable straight over the top of the course that failed to load
  // (and `courses.save`'s update path deletes and reinserts, so that save
  // would have destroyed the stored categories, channels, instructions and
  // model settings). Kept apart from `error` below, which is the *save*
  // failure this form already renders inline, over a form that did load —
  // a load failure instead replaces the form entirely; see the render below.
  const [loadError, setLoadError] = useState<ApiError | undefined>(undefined)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  // Review must-fix 1: true for the whole of the tab prompt's own "Save
  // changes" — `saving` alone leaves the `Save course` button live while
  // `saveDirtyWork` is awaiting the instructions half.
  const [switchSaving, setSwitchSaving] = useState(false)
  // True only for the one case that needs saying out loud: the prompt's
  // "Save changes" wrote the instructions and then the form was refused.
  const [halfSaved, setHalfSaved] = useState(false)
  // TEN-9 — every binding this organization has ever held (active or
  // removed, `discordServers.list`'s own shape), fetched once per
  // organization. Only the active ones (`activeBindings`, below) decide
  // whether the server selector *offers a choice* — "one binding is not a
  // choice worth making anybody make" (this slice's own brief) — so a
  // removed binding never offers itself as a choice, but is still fetched
  // rather than narrowed server-side, matching `pages/Shell.tsx`'s own
  // `listDiscordServers` read.
  const [discordBindings, setDiscordBindings] = useState<
    DiscordServerBindingSummary[]
  >([])
  const activeBindings = discordBindings.filter(isActiveDiscordBinding)
  // Must-fix 3 (coordinator round 1 rework): `activeBindings.length > 1`
  // alone stranded a course whose own `discordServerId` names a binding
  // that has since been removed — the owner removes the second of two
  // bindings through `pages/Shell.tsx`'s own per-row Remove, this drops
  // back to one active binding, the selector disappears, and
  // `keepOrClear` (`handleSave`, below) keeps preserving the now-inactive
  // id forever: every save of an enabled course is refused
  // ("...no longer active..."), with no control anywhere in the panel to
  // choose a different one or clear it. Offered whenever there is an
  // actual choice to make (2+ active bindings) *or* the course, as loaded
  // (`baseline`, not the live `form`), already names one explicitly,
  // active or not — the second half is what makes a stale assignment
  // recoverable rather than only diagnosable. `baseline`, deliberately,
  // not `form`: reading `form.discordServerId` here would make clearing
  // the field to `null` (choosing the blank option, below) flip this
  // condition to `false` mid-edit, which would then omit the field from
  // the save payload entirely — silently un-doing the very clear the
  // instructor just asked for, since an omitted field means "keep what is
  // stored" (`handleSave`'s own comment). `baseline` never changes except
  // when a fresh record is loaded or a save actually succeeds, so this
  // stays stable for the whole edit, the same way `isDirty`'s own
  // comparison already relies on it.
  const offersServerSelector =
    activeBindings.length > 1 || baseline.discordServerId !== null
  // The course's own id, when it is not one of `activeBindings` — a stale
  // reference the `<select>` below still has to show *as* an option (not
  // silently fall back to showing nothing selected, which would look
  // identical to "cleared" while the form still carries the stale value).
  const staleServerId =
    form.discordServerId !== null &&
    !activeBindings.some((binding) => binding.serverId === form.discordServerId)
      ? form.discordServerId
      : undefined

  useEffect(() => {
    let stale = false
    listDiscordServers(organizationId).then(
      (bindings) => {
        if (!stale) setDiscordBindings(bindings)
      },
      () => {
        // Best-effort: a failed lookup here just means the selector stays
        // hidden (`activeBindings.length` reads `0`) — an organization with
        // exactly one binding, or none, keeps saving exactly as it always
        // has (TEN-9's own requirement), and a genuinely ambiguous course
        // still gets refused server-side, with the reason surfaced through
        // this form's ordinary `ErrorMessage` (`handleSave`'s own catch).
      }
    )
    return () => {
      stale = true
    }
  }, [organizationId])

  useEffect(() => {
    // Finding 8 (WEB-7 rework): guards against an out-of-order response —
    // if `courseId` changes again before this fetch resolves, the response
    // that lands is stale and must not overwrite what the current props
    // asked for.
    let stale = false
    // Rework round 1, must-fix 1: a freshly loaded course starts with only
    // its own incoming tab "visited" — carrying a previous course's own
    // visited set into this one would wrongly mount (and fetch for) a tab
    // nobody has opened on *this* course yet, the moment the same
    // `CourseEditor` instance is reused for a different `courseId`
    // (`pages/ProjectsPanel.tsx` does not remount it between courses).
    const initialTab = tab ?? 'general'
    activeTabRef.current = initialTab
    setActiveTab(initialTab)
    setVisitedTabs(new Set([initialTab]))
    if (courseId === undefined) {
      const blank = blankForm()
      setForm(blank)
      setBaseline(blank)
      setLoadError(undefined)
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(undefined)
    getCourse(organizationId, courseId).then(
      (course) => {
        if (stale) return
        const loaded = formFromCourse(course)
        setForm(loaded)
        setBaseline(loaded)
        setLoading(false)
      },
      (caught: unknown) => {
        if (stale) return
        setLoading(false)
        if (caught instanceof ApiError) setLoadError(caught)
        else throw caught
      }
    )
    return () => {
      stale = true
    }
  }, [organizationId, courseId])

  // WEB-35/WEB-16: switches to the tab a refused field lives on, if it is
  // not already the one showing — shared by `handleSave`'s own
  // client-side `maxRequestsPerDay` refusal and its server-refused catch,
  // below, so both refusal paths land the instructor on a tab where
  // `fieldErrorProp`'s inline message is actually visible, not only the
  // top-level `ErrorMessage`. Reads `activeTabRef.current`, not `activeTab`
  // (rework round 1, must-fix 3) — this runs from inside `handleSave`,
  // after an `await` on the server round trip, so a plain closure over
  // `activeTab` would compare against whatever tab was active when the
  // save *started*, not the one showing once the refusal actually lands.
  const switchToTabForField = useCallback(
    (fieldName: string | number | undefined) => {
      const targetTab =
        typeof fieldName === 'string' ? FIELD_TABS[fieldName] : undefined
      // Idempotent: a field already on the tab showing must not push a
      // redundant, identical history entry.
      if (targetTab && targetTab !== activeTabRef.current) goToTab(targetTab)
    },
    [goToTab]
  )

  /**
   * Saves the course form. Resolves `true` when the save landed and
   * `false` when it was refused (client-side or by the server) — the
   * refusal is rendered inline either way, but a caller that saves on the
   * way somewhere else (`goToTabGuarded`, below) needs to know not to go.
   */
  const handleSave = async (): Promise<boolean> => {
    setError(undefined)
    setHalfSaved(false)
    const maxRequestsPerDay = parseMaxRequestsPerDay(form.maxRequestsPerDay)
    if (!maxRequestsPerDay.ok) {
      // Finding 2 (WEB-7 rework): refuse client-side rather than ever
      // sending a `NaN` — `JSON.stringify(NaN)` is `null`, which
      // `courses.save` reads as "clear the stored cap," silently, on a
      // typo. Rendered through the same `ErrorMessage` a server-side
      // validation failure uses, so the instructor is told, not obeyed.
      setError(
        new ApiError(400, {
          error: 'action_input_invalid',
          issues: [
            {
              path: ['maxRequestsPerDay'],
              message:
                'Enter a whole number greater than zero, or leave it blank to use the platform default.',
            },
          ],
        })
      )
      switchToTabForField('maxRequestsPerDay')
      return false
    }
    setSaving(true)
    try {
      const categories: SaveCourseCategoryInput[] = form.categories.map(
        (category) => ({
          name: category.name,
          channels: category.channels.map((channel) => ({
            name: channel.name,
            adminsOnly: channel.adminsOnly,
          })),
        })
      )
      const input: SaveCourseInput = {
        ...(courseId !== undefined ? { id: courseId } : {}),
        projectId: project.id,
        title: form.title,
        enabled: form.enabled,
        adminsRole: form.adminsRole,
        studentsRole: form.studentsRole,
        // Every optional field below is sent explicitly — `null` when the
        // input is empty, the value otherwise — per this module's own
        // comment on why this form never relies on "omitted." `promptId`
        // and `vectorStoreId` are two deliberate exceptions (MDL-8,
        // WEB-18): this form has no control that can change either any
        // more, so neither is ever sent at all
        // — `courses.save`'s own "omitted preserves what is stored" rule
        // is exactly what keeps a course that already has one answered
        // through it, unchanged, save after save. `instructions` is not a
        // field of `SaveCourseInput` at all any more (WEB-19) —
        // `components/CourseInstructions.tsx` saves it through
        // `courseInstructions.save` instead.
        model: form.model.trim() === '' ? null : form.model.trim(),
        maxRequestsPerDay: maxRequestsPerDay.value,
        // ENRL-13/ENRL-14 — sent explicitly, like `enabled` above: this
        // form manages both checkboxes directly, so there is no "omitted"
        // case for it to rely on.
        selfEnrolFromDiscord: form.selfEnrolFromDiscord,
        answerUnenrolled: form.answerUnenrolled,
        // TEN-9 — sent only while the selector is actually offered
        // (`offersServerSelector`, kept in lockstep with the render gate
        // above — must-fix 3, coordinator round 1 rework): a course this
        // form does not offer a choice for is not a field this form
        // manages this render, the same "omitted preserves what is stored"
        // treatment `promptId`/`vectorStoreId` get above, rather than
        // forcing every course back to `null` the moment an organization
        // happens to install a second server.
        ...(offersServerSelector
          ? { discordServerId: form.discordServerId }
          : {}),
        categories,
      }
      const saved = await saveCourse(organizationId, input)
      const savedForm = formFromCourse(saved)
      setForm(savedForm)
      // WEB-16: a successful save clears the dirty state — the form now
      // agrees with the server again, the same reason `setForm` above is
      // set from `saved` rather than left as whatever was typed.
      setBaseline(savedForm)
      onSaved(saved)
      return true
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught)
        // WEB-35/WEB-16: switches to the first *mapped* issue's own tab,
        // not merely the first issue (rework round 1, must-fix 5) — a
        // refusal whose first issue names a field this form does not
        // render at all (`projectId`, `enabled`) while a later one names
        // `title` used to leave the switch never firing, stranding the
        // inline message `fieldErrorProp` renders on whichever tab
        // happened to be showing. Otherwise the top `ErrorMessage` would
        // be the only sign anything was refused at all, on a tab with
        // nothing else wrong with it.
        const mappedIssue = caught.body.issues?.find(
          (issue) =>
            typeof issue.path[0] === 'string' && issue.path[0] in FIELD_TABS
        )
        switchToTabForField(mappedIssue?.path[0])
      } else throw caught
      return false
    } finally {
      setSaving(false)
    }
  }

  /**
   * Saves whatever is actually unsaved, and reports whether all of it
   * landed. Instructions first, then the course form: each is its own
   * action with its own failure (`components/CourseInstructions.tsx`'s own
   * module comment on why they were never folded into one call), and a
   * half that is already clean is not re-sent.
   *
   * Review must-fix 4: an instructions edit this page cannot reach is a
   * failure, not a success. `instructionsActionsRef` is `null` only when
   * that section is not mounted, which cannot happen while
   * `instructionsDirty` is true (a tab, once visited, stays mounted — this
   * file's own module comment) — but "cannot happen" is an invariant
   * nothing here asserts, and reading `undefined` as "saved" would move
   * the tab while the edit sat unsaved and unreachable. Refusing is the
   * answer that stays true if the mounting rule ever changes.
   */
  const saveDirtyWork = async (): Promise<boolean> => {
    let instructionsWritten = false
    if (instructionsDirty) {
      const actions = instructionsActionsRef.current
      if (!actions) return false
      if (!(await actions.save())) return false
      instructionsWritten = true
    }
    if (formDirty) {
      const savedForm = await handleSave()
      // The two halves are two requests, not one transaction (review
      // note): the instructions are already stored and no later "Discard"
      // can take them back, so a refusal of the *form* half says so
      // rather than leaving someone to assume nothing was written.
      setHalfSaved(!savedForm && instructionsWritten)
      return savedForm
    }
    return true
  }

  /** Throws away every unsaved edit on this screen, both halves. */
  const discardDirtyWork = () => {
    setForm(baseline)
    setError(undefined)
    // Round 2, finding 4: cleared with the refusal it explains. Left
    // behind, "your instructions were saved before this was refused"
    // stayed on screen after a later discard, with no refusal in sight.
    setHalfSaved(false)
    instructionsActionsRef.current?.discard()
  }

  /**
   * A tab switch a person actually asked for (a click, or the arrow keys),
   * as opposed to the ones this component makes on its own.
   *
   * The five tabs share one form and one `Save course` button, so an edit
   * made on one tab is never *lost* by looking at another — but "I changed
   * something and then wandered off" is exactly how an edit ends up
   * abandoned, so leaving a tab with unsaved settings asks first. Three
   * answers, not the usual two: save them and carry on, discard them and
   * carry on, or stay on this tab (Cancel, and `Escape`) — a plain
   * confirm would have to fold "discard" and "stay here" together, and
   * either answer is wrong for half the people who meant the other.
   *
   * **A refused save lands wherever the refusal can be read** (WEB-38) —
   * never as a consequence of the click. `switchToTabForField`, not this
   * function, decides: a refusal naming a field goes to that field's own
   * tab so the inline message is visible (WEB-16), which may or may not be
   * the tab that was clicked (`model` and `maxRequestsPerDay` both live on
   * AI, so a refusal naming either lands on AI whether or not AI is where
   * the click was headed); a refusal naming no field this form renders
   * leaves the person exactly where they were. Either way the edit is
   * still unsaved and still theirs to deal with, and the prompt itself
   * never carries them onward. Review round 1 found this comment claiming
   * "stays on the tab they were on"; round 2 found the replacement
   * ("never reaches the tab that was clicked") false in the other
   * direction. This is the narrow true statement.
   *
   * Review must-fix 1: while a save is in flight — this one's, or the
   * `Save course` button's — a tab click is ignored rather than opening a
   * second prompt over a `baseline` that has not moved yet. Clicking Save
   * course and then a tab used to fire a second, concurrent
   * `courses.save`, both racing to set `form`, `baseline` and `onSaved`.
   */
  const goToTabGuarded = async (next: CourseEditorTab) => {
    if (next === activeTabRef.current) return
    // Round 2, finding 5: the instructions section's *own* Save counts as
    // a save in flight too. Without it the prompt opened, "Save changes"
    // hit that section's own in-flight guard, and the whole thing closed
    // having done nothing and said nothing — no duplicate request, but a
    // silent dead end. Not opening the prompt at all is the honest
    // version of "a save is already running."
    if (saving || switchSaving) return
    if (instructionsActionsRef.current?.isSaving()) return
    if (!isDirty) {
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
      // `switchSaving` covers the whole of `saveDirtyWork`, including the
      // stretch where it is awaiting the *instructions* save and the
      // form's own `saving` is still false — without it the `Save course`
      // button stayed live through that window (must-fix 1's own mirror).
      setSwitchSaving(true)
      let saved: boolean
      try {
        saved = await saveDirtyWork()
      } finally {
        setSwitchSaving(false)
      }
      if (!saved) return
    } else {
      discardDirtyWork()
    }
    goToTab(next)
  }

  // Rework round 1, must-fix 6: Left/Right cycle with wraparound (the
  // WAI-ARIA "tabs (automatic activation)" pattern), Home/End jump to the
  // first/last tab — attached to the `tablist` itself so focus anywhere in
  // the row reaches it, not to each individual `tab` button.
  const handleTabListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const ids = COURSE_EDITOR_TAB_IDS
    const currentIndex = ids.indexOf(activeTabRef.current)
    let nextIndex: number
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (currentIndex + 1) % ids.length
        break
      case 'ArrowLeft':
        nextIndex = (currentIndex - 1 + ids.length) % ids.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = ids.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    void goToTabGuarded(ids[nextIndex]!)
  }

  const updateCategory = (key: string, name: string) => {
    setForm((current) => ({
      ...current,
      categories: current.categories.map((category) =>
        category.key === key ? { ...category, name } : category
      ),
    }))
  }
  const addCategory = () => {
    setForm((current) => ({
      ...current,
      categories: [...current.categories, emptyCategory()],
    }))
  }
  // WEB-15: removing a category (with it, every channel inside) or a
  // channel from the list below confirms first — "removing from a list"
  // is explicitly one of this panel's own destructive intents, the same
  // modal every other one shares, even though nothing here is sent to the
  // server until Save; the list itself is what a person sees change.
  const removeCategory = async (key: string, name: string) => {
    const confirmed = await confirm({
      title: `Remove ${name || 'this category'}?`,
      description:
        'Every channel inside it is removed too. This takes effect once the form is saved.',
      confirmLabel: 'Remove',
      destructive: true,
    })
    if (!confirmed) return
    setForm((current) => ({
      ...current,
      categories: current.categories.filter((category) => category.key !== key),
    }))
  }
  const addChannel = (categoryKey: string) => {
    setForm((current) => ({
      ...current,
      categories: current.categories.map((category) =>
        category.key === categoryKey
          ? {
              ...category,
              channels: [
                ...category.channels,
                { key: newKey(), name: '', adminsOnly: false },
              ],
            }
          : category
      ),
    }))
  }
  const updateChannel = (
    categoryKey: string,
    channelKey: string,
    fields: Partial<Pick<EditableChannel, 'name' | 'adminsOnly'>>
  ) => {
    setForm((current) => ({
      ...current,
      categories: current.categories.map((category) =>
        category.key === categoryKey
          ? {
              ...category,
              channels: category.channels.map((channel) =>
                channel.key === channelKey ? { ...channel, ...fields } : channel
              ),
            }
          : category
      ),
    }))
  }
  const removeChannel = async (
    categoryKey: string,
    channelKey: string,
    name: string
  ) => {
    const confirmed = await confirm({
      title: `Remove ${name || 'this channel'}?`,
      description: 'This takes effect once the form is saved.',
      confirmLabel: 'Remove',
      destructive: true,
    })
    if (!confirmed) return
    setForm((current) => ({
      ...current,
      categories: current.categories.map((category) =>
        category.key === categoryKey
          ? {
              ...category,
              channels: category.channels.filter(
                (channel) => channel.key !== channelKey
              ),
            }
          : category
      ),
    }))
  }

  // WEB-16: Cancel goes through the same unsaved-changes confirmation a
  // navigation started outside this form does (`useUnsavedChangesGuard`'s
  // own module comment) — `confirmDiscard` resolves `true` immediately
  // when the form is clean, so this never prompts over nothing.
  const handleCancel = async () => {
    if (await confirmDiscard()) onCancel()
  }

  // WEB-19: `useCallback` so `CourseInstructions`'s own `useEffect`
  // (`onDirtyChange` in its dependency array) does not re-run on every
  // render of this component for no reason — a new inline arrow function
  // here every render would still be functionally correct (the same value
  // set again is a no-op), just needlessly re-running that effect.
  const handleInstructionsDirtyChange = useCallback((dirty: boolean) => {
    setInstructionsDirty(dirty)
  }, [])

  // WEB-35 — the fields the brief's own "What this course routes on" box
  // held, split out of that box so the Discord tab (below) can reuse the
  // controls under its own intro copy instead of a second, redundant
  // bordered box; the new-course path (this component's own "no tab
  // address to invent" case, this file's module comment) keeps the
  // original box around this same pair of controls, unchanged.
  const rolesAndServerFields = (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Admins role" {...fieldErrorProp(error, 'adminsRole')}>
          <input
            aria-label="Admins role"
            value={form.adminsRole}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                adminsRole: event.target.value,
              }))
            }
            className={textInputClasses}
          />
        </FormField>
        <FormField
          label="Students role"
          {...fieldErrorProp(error, 'studentsRole')}
        >
          <input
            aria-label="Students role"
            value={form.studentsRole}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                studentsRole: event.target.value,
              }))
            }
            className={textInputClasses}
          />
        </FormField>
      </div>

      {/* TEN-9 — offered once there is an actual choice to make (2+
          active bindings — "one binding is not a choice worth making
          anybody make", this slice's own brief) *or* the course already
          names a server explicitly, even one that is no longer active
          (must-fix 3, coordinator round 1 rework) — otherwise a course
          pinned to a since-removed binding has no way in the product to
          be re-pointed or cleared, only a refusal that names the problem
          with no control to fix it. An organization with zero or one
          active binding and a course that has never named one never sees
          this at all — it still resolves correctly through
          `resolveCourseDiscordServer`'s own single-binding fallback,
          unedited. */}
      {offersServerSelector && (
        <FormField
          label="Discord server"
          {...fieldErrorProp(error, 'discordServerId')}
        >
          <select
            aria-label="Discord server"
            value={form.discordServerId ?? ''}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                discordServerId:
                  event.target.value === '' ? null : event.target.value,
              }))
            }
            className={textInputClasses}
          >
            <option value="">Choose a server…</option>
            {/* The stale option itself, shown so a course pinned to a
                removed binding reads as exactly that in the control,
                rather than looking identical to "cleared" while the form
                still carries the old id — selectable only in the sense
                that leaving it selected is what a re-save would already
                do; `disabled` steers toward picking an active server or
                clearing to `null` instead. */}
            {staleServerId && (
              <option value={staleServerId} disabled>
                {staleServerId} (no longer active)
              </option>
            )}
            {activeBindings.map((binding) => (
              <option key={binding.serverId} value={binding.serverId}>
                {binding.serverId}
              </option>
            ))}
          </select>
        </FormField>
      )}
    </>
  )

  const titleField = (
    <FormField label="Title" {...fieldErrorProp(error, 'title')}>
      <input
        aria-label="Title"
        value={form.title}
        onChange={(event) =>
          setForm((current) => ({ ...current, title: event.target.value }))
        }
        className={textInputClasses}
      />
    </FormField>
  )

  /**
   * Whether this course answers students at all — an ordinary field of
   * this form, saved by the one `Save course` button like every other
   * field on every other tab.
   *
   * There used to be a second control here: an `Enable`/`Disable` button
   * that dispatched `courses.enable`/`courses.disable` immediately, beside
   * a checkbox that only took effect on the next save. Two controls for
   * one flag, disagreeing with each other whenever the checkbox held an
   * unsaved edit, needed a whole second piece of state
   * (`confirmedEnabled`) to keep the button honest. The immediate control
   * still exists where it is actually useful — each course's own kebab
   * menu on the project page (`pages/Courses.tsx`), which is where someone
   * shutting a misbehaving course off is already looking, and which keeps
   * WEB-15's own confirmation before disabling a live course. Here, one
   * checkbox and one Save is the whole story.
   */
  const enabledControl = (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
        <input
          type="checkbox"
          aria-label="Enabled"
          checked={form.enabled}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              enabled: event.target.checked,
            }))
          }
          className={checkboxClasses}
        />
        Enabled
      </label>
      <p className="text-sm text-neutral-600">
        Students can only ask this course while it is enabled. Like every other
        setting here, this takes effect when you save.
      </p>
    </div>
  )

  /** ENRL-13 — whether a student's own message enrols them. */
  const selfEnrolControl = (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
        <input
          type="checkbox"
          aria-label="Students can enrol themselves by messaging this course"
          checked={form.selfEnrolFromDiscord}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              selfEnrolFromDiscord: event.target.checked,
            }))
          }
          className={checkboxClasses}
        />
        Students can enrol themselves by messaging this course
      </label>
      <p className="text-sm text-neutral-600">
        When checked, a student who messages this course is enrolled in it —
        immediately if they already have a connected account, or as soon as they
        connect one afterwards.
      </p>
    </div>
  )

  /** ENRL-14 — whether an unenrolled student is still answered. */
  const answerUnenrolledControl = (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
        <input
          type="checkbox"
          aria-label="Answer students who are not enrolled"
          checked={form.answerUnenrolled}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              answerUnenrolled: event.target.checked,
            }))
          }
          className={checkboxClasses}
        />
        Answer students who are not enrolled
      </label>
      <p className="text-sm text-neutral-600">
        When unchecked, only a student this course has enrolled gets an answer —
        everyone else is told plainly that they are not enrolled.
      </p>
    </div>
  )

  const categoriesFieldset = (
    <fieldset className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4">
      <legend className="px-1 text-section-title font-semibold text-neutral-900">
        Categories
      </legend>
      {form.categories.map((category) => (
        <fieldset
          key={category.key}
          className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3"
        >
          <legend className="sr-only">Category</legend>
          <div className="flex items-center gap-2">
            <input
              aria-label="Category name"
              value={category.name}
              onChange={(event) =>
                updateCategory(category.key, event.target.value)
              }
              className={textInputClasses}
            />
            <Button
              variant="ghost"
              aria-label={`Remove category ${category.name || ''}`.trim()}
              icon={
                <RemoveFromListIcon aria-hidden="true" className="size-4" />
              }
              onClick={() => void removeCategory(category.key, category.name)}
            >
              Remove category
            </Button>
          </div>
          {category.channels.map((channel) => (
            <div
              key={channel.key}
              className="flex flex-wrap items-center gap-2 pl-4"
            >
              <input
                aria-label="Channel name"
                value={channel.name}
                onChange={(event) =>
                  updateChannel(category.key, channel.key, {
                    name: event.target.value,
                  })
                }
                className={textInputClasses}
              />
              <label className="flex items-center gap-2 text-sm text-neutral-700">
                <input
                  type="checkbox"
                  aria-label="Admins only"
                  checked={channel.adminsOnly}
                  onChange={(event) =>
                    updateChannel(category.key, channel.key, {
                      adminsOnly: event.target.checked,
                    })
                  }
                  className={checkboxClasses}
                />
                Admins only
              </label>
              <Button
                variant="ghost"
                aria-label={`Remove channel ${channel.name || ''}`.trim()}
                icon={
                  <RemoveFromListIcon aria-hidden="true" className="size-4" />
                }
                onClick={() =>
                  void removeChannel(category.key, channel.key, channel.name)
                }
              >
                Remove channel
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            icon={<AddIcon aria-hidden="true" className="size-4" />}
            onClick={() => addChannel(category.key)}
          >
            Add channel
          </Button>
        </fieldset>
      ))}
      <Button
        variant="secondary"
        icon={<AddIcon aria-hidden="true" className="size-4" />}
        onClick={addCategory}
      >
        Add category
      </Button>
    </fieldset>
  )

  // WEB-35 — Model, the read-only Prompt id field and its MDL-8 warning
  // banner, then Max requests per day: the AI tab's own order, per the
  // brief. Reused unchanged by the new-course path below, where
  // `form.promptId` is always empty (this file's own module comment on
  // why no new course can acquire one) so the banner and the read-only
  // field both simply do not render there.
  const aiFields = (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Model"
          help="Leave blank to use the platform default."
          {...fieldErrorProp(error, 'model')}
        >
          <input
            aria-label="Model"
            value={form.model}
            onChange={(event) =>
              setForm((current) => ({ ...current, model: event.target.value }))
            }
            className={textInputClasses}
          />
        </FormField>

        {/* Read-only, and only ever rendered for a course that already has
            one — MDL-8's "keep reading it... no new course can acquire
            one." Shown so an instructor can still see (and copy) the id
            behind the banner below, never so it can be typed into or
            cleared here. */}
        {form.promptId && (
          <FormField
            label="Prompt id"
            help="Inherited from before this panel existed. Deprecated — see the notice below."
          >
            <input
              aria-label="Prompt id"
              value={form.promptId}
              readOnly
              className={textInputClasses}
            />
          </FormField>
        )}
      </div>

      {/* MDL-8: a course with a stored prompt id (D-3's Python-era escape
          hatch) is answered through it — `buildResponsesRequestBody`
          (`packages/openai/src/responses.ts`) sends `prompt` instead of
          `instructions` whenever one is set, so the `CourseInstructions`
          section below is inert on exactly these courses. This is the
          visibility half of MDL-8: an instructor editing instructions there
          must know that, not discover it by an answer never changing. Never
          shown for a new course — `form.promptId` only ever comes from a
          loaded course (`blankForm` carries no way to set one) — and this
          banner itself is read-only, matching the read-only "Prompt id"
          field above; see `packages/actions/src/actions/courses.ts`'s own
          `promptId` comment for the write-side half of the same refusal. */}
      {form.promptId && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-md border border-warning-600 bg-warning-50 px-3 py-2 text-sm text-warning-600"
        >
          <WarningIcon aria-hidden="true" className="size-4 shrink-0" />
          This course is answered through a stored OpenAI prompt (configured
          outside this panel, before it existed). The instructions below are not
          being used.
        </p>
      )}

      {/*
        WEB-18: an instructor never sees a vector store id. The store is the
        platform's own bookkeeping — `courseAttachments.attach` creates one
        on the first upload and adopts a hand-typed one if the course already
        has it — and offering a text box for it is the vendor-dashboard
        workflow FILE-1 exists to replace. Leaving it beside a knowledge-files
        list would give an instructor two contradictory ways to say what a
        course is grounded in.

        Deprecated on the same terms as the prompt id: a course that already
        has a value keeps working and keeps being answered through it, the
        value is never cleared behind anybody's back, and no new course can
        acquire one because the field it was typed into is gone.
      */}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Max requests per day"
          help="A whole number greater than zero, or leave blank to use the platform default."
          {...fieldErrorProp(error, 'maxRequestsPerDay')}
        >
          <input
            aria-label="Max requests per day"
            value={form.maxRequestsPerDay}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                maxRequestsPerDay: event.target.value,
              }))
            }
            className={textInputClasses}
          />
        </FormField>
      </div>
    </>
  )

  if (loading) {
    return (
      <p role="status" className="text-sm text-neutral-500">
        Loading…
      </p>
    )
  }

  if (loadError) {
    // Finding 3 (WEB-7 rework): a failed `courses.get` renders only this —
    // never the form, which for an existing `courseId` would otherwise be
    // an *editable, saveable* blank standing in for a real course.
    return (
      <section
        aria-label="Course"
        data-testid="course-editor"
        className="flex flex-col gap-4"
      >
        <Button variant="ghost" onClick={onCancel}>
          ← {project.name}
        </Button>
        <ErrorMessage error={loadError} />
      </section>
    )
  }

  // WEB-35 — the Discord tab's join-links/roster/people/attachments/website
  // sections are all still gated on `courseId !== undefined`, unchanged;
  // inside the `courseId !== undefined` branch below that gate is always
  // true, so it is dropped from each of these — the branch itself is the
  // gate.
  return (
    <section
      aria-label="Course"
      data-testid="course-editor"
      className="flex flex-col gap-6"
    >
      <Button variant="ghost" onClick={() => void handleCancel()}>
        ← {project.name}
      </Button>
      <h1 className="text-page-title font-semibold text-neutral-900">
        {courseId === undefined ? 'New course' : form.title || 'Course'}
      </h1>

      {courseId === undefined ? (
        // WEB-35 — a new course cannot have join links, a roster import,
        // people, attachments, instructions or websites (all already gated
        // on `courseId !== undefined`, unchanged by this slice), so there is
        // nothing worth splitting into tabs, and no tab address for a course
        // that does not exist yet to be part of. This keeps the single-form
        // layout the whole screen always had, field for field.
        <>
          {/* WEB-9: what decides routing, shown together and up front. */}
          <section
            aria-label="What this course routes on"
            className="flex flex-col gap-3 rounded-md border border-neutral-200 bg-neutral-50 p-4"
          >
            <p className="text-sm text-neutral-600">
              A message reaches this course by the Discord category it arrived
              in, or by the author&apos;s role — these names have to match your
              Discord server exactly.
            </p>
            {rolesAndServerFields}
          </section>

          {titleField}

          {enabledControl}
          {selfEnrolControl}
          {answerUnenrolledControl}

          {categoriesFieldset}

          {aiFields}
        </>
      ) : (
        <>
          {/* WEB-35: a real tab pattern — `role="tablist"` of `role="tab"`
              controls, each `aria-selected` against `activeTab`, each
              controlling the one `role="tabpanel"` actually rendered below.
              A tab is an address (this file's own module comment), so a
              click calls `goToTab`, which pushes the new route through
              `onNavigateTab` rather than only flipping local state — the
              same "navigate, don't just re-render" convention
              `pages/ProjectsPanel.tsx` and `pages/Shell.tsx` already hold
              every other screen in this panel to.

              Rework round 1, must-fix 6: the WAI-ARIA tabs keyboard
              interaction — roving `tabIndex` (only the selected tab is
              ever `0`, so Tab enters/leaves the whole row in one stop, the
              same as a native control) and Left/Right/Home/End moving *and
              activating* selection (`handleTabListKeyDown`, above), which
              also moves focus onto the newly active button
              (`goToTab`'s own final line) — including when a refused save
              switches tabs on its own, so that move is never silent. */}
          <div
            role="tablist"
            aria-label="Course settings"
            className="flex gap-1 border-b border-neutral-200"
            onKeyDown={handleTabListKeyDown}
          >
            {COURSE_EDITOR_TABS.map((courseTab) => (
              <button
                key={courseTab.id}
                ref={(element) => {
                  if (element) tabButtonRefs.current.set(courseTab.id, element)
                  else tabButtonRefs.current.delete(courseTab.id)
                }}
                type="button"
                role="tab"
                id={`course-tab-${courseTab.id}`}
                aria-selected={activeTab === courseTab.id}
                aria-controls={`course-tabpanel-${courseTab.id}`}
                tabIndex={activeTab === courseTab.id ? 0 : -1}
                onClick={() => void goToTabGuarded(courseTab.id)}
                className={
                  activeTab === courseTab.id
                    ? 'border-b-2 border-neutral-900 px-3 py-2 text-sm font-semibold text-neutral-900'
                    : 'border-b-2 border-transparent px-3 py-2 text-sm font-medium text-neutral-500 hover:text-neutral-800'
                }
              >
                {courseTab.label}
              </button>
            ))}
          </div>

          {/* Rework round 1, must-fix 1: this wrapper — id, aria-labelledby,
              `hidden` — stays mounted for every one of the five tabs,
              always, so a `role="tab"`'s own `aria-controls` never points
              at an id that does not exist in the DOM (rework round 1,
              finding 6). Only the *content* inside is gated on
              `visitedTabs`, and it is that content — not this div — whose
              mount is what a fetch or a piece of local state actually
              depends on. */}
          <div
            role="tabpanel"
            id="course-tabpanel-general"
            aria-labelledby="course-tab-general"
            hidden={activeTab !== 'general'}
            className="flex flex-col gap-6"
          >
            {visitedTabs.has('general') && (
              <>
                {titleField}
                {enabledControl}
                {selfEnrolControl}
                {answerUnenrolledControl}

                {/* WEB-20: a course's join links — belongs to an existing
                    course. */}
                <section
                  aria-label="Join links"
                  className="flex flex-col gap-2"
                >
                  <h2 className="text-section-title font-semibold text-neutral-900">
                    Join links
                  </h2>
                  <p className="text-sm text-neutral-600">
                    Share a link that lets a student enrol themselves, without a
                    Discord role — each link&apos;s secret is shown only once,
                    right after you create it.
                  </p>
                  <JoinLinks
                    organizationId={organizationId}
                    courseId={courseId}
                  />
                </section>
              </>
            )}
          </div>

          <div
            role="tabpanel"
            id="course-tabpanel-ai"
            aria-labelledby="course-tab-ai"
            hidden={activeTab !== 'ai'}
            className="flex flex-col gap-6"
          >
            {visitedTabs.has('ai') && (
              <>
                {aiFields}

                {/* WEB-19/FILE-4: see this file's own module comment for
                    why this section owns its own save and reports its own
                    dirtiness up. Mounted only once this tab is first
                    visited (rework round 1, must-fix 1) and never
                    unmounted after — an in-progress edit here used to be
                    silently destroyed by switching away, which also left
                    `instructionsDirty` (below) stuck `true` over a change
                    that no longer existed anywhere. */}
                <CourseInstructions
                  organizationId={organizationId}
                  courseId={courseId}
                  onDirtyChange={handleInstructionsDirtyChange}
                  onRegisterActions={handleRegisterInstructionsActions}
                />

                {/* WEB-18/FILE-1: a course's knowledge files. */}
                <section
                  aria-label="Knowledge files"
                  className="flex flex-col gap-2"
                >
                  <h2 className="text-section-title font-semibold text-neutral-900">
                    Knowledge files
                  </h2>
                  <p className="text-sm text-neutral-600">
                    The notes, syllabus and schedule this course is grounded in.
                    Detaching one stops it grounding answers immediately, and
                    reaches the provider — it cannot be undone.
                  </p>
                  <CourseAttachments
                    organizationId={organizationId}
                    courseId={courseId}
                  />
                </section>

                {/* FILE-6/MDL-9: a course's websites, alongside its
                    knowledge files. */}
                <section aria-label="Websites" className="flex flex-col gap-2">
                  <h2 className="text-section-title font-semibold text-neutral-900">
                    Websites
                  </h2>
                  <p className="text-sm text-neutral-600">
                    Sites this course is grounded in, alongside its knowledge
                    files. Bloombot searches only the domains named here — never
                    the open web. Removing one takes effect immediately.
                  </p>
                  <CourseWebSources
                    organizationId={organizationId}
                    courseId={courseId}
                  />
                </section>
              </>
            )}
          </div>

          <div
            role="tabpanel"
            id="course-tabpanel-discord"
            aria-labelledby="course-tab-discord"
            hidden={activeTab !== 'discord'}
            className="flex flex-col gap-6"
          >
            {visitedTabs.has('discord') && (
              <>
                {/* WEB-35 — the intro copy from the former "What this
                    course routes on" box, kept, with the bordered box
                    itself dropped: the Discord tab is already its own
                    visually distinct region, so a second border around the
                    same fields read as redundant. See `docs/DECISIONS.md`
                    if this needs reconsidering. */}
                <p className="text-sm text-neutral-600">
                  A message reaches this course by the Discord category it
                  arrived in, or by the author&apos;s role — these names have to
                  match your Discord server exactly.
                </p>
                {rolesAndServerFields}

                {categoriesFieldset}

                {/* SRV-6: scaffolding needs a persisted course to name in
                    the job payload. Mounted only once this tab is first
                    visited (rework round 1, must-fix 1) — its own polling
                    used to be silently killed by switching away mid-job. */}
                <section
                  aria-label="Discord channels"
                  className="flex flex-col gap-2"
                >
                  <h2 className="text-section-title font-semibold text-neutral-900">
                    Discord channels
                  </h2>
                  <p className="text-sm text-neutral-600">
                    Create this course&apos;s declared categories and channels
                    in the Discord server bound to this organization.
                  </p>
                  <ScaffoldButton
                    organizationId={organizationId}
                    courseId={courseId}
                    // SRV-6 — `ScaffoldButton` has no route access of
                    // its own; when its own click-time check finds no
                    // active Discord server binding, it confirms and then
                    // defers to this to take the person to the
                    // organization's Discord page, where `InstallButton`
                    // lives. Routed through `confirmDiscard()` first — the
                    // same unsaved-changes prompt `handleCancel` (above)
                    // uses for its own leave-the-editor navigation — since
                    // this, like Cancel, unmounts the whole editor: a
                    // dirty category/channel edit on this very tab would
                    // otherwise vanish with no prompt the moment "Connect
                    // a server" is clicked, unlike every other way out of
                    // this form.
                    onConnectDiscord={async () => {
                      if (await confirmDiscard()) {
                        navigate({ kind: 'discord', organizationId })
                      }
                    }}
                  />
                </section>
              </>
            )}
          </div>

          <div
            role="tabpanel"
            id="course-tabpanel-roster"
            aria-labelledby="course-tab-roster"
            hidden={activeTab !== 'roster'}
            className="flex flex-col gap-6"
          >
            {visitedTabs.has('roster') && (
              <>
                {/* WEB-21/ROST-9..12: a course's roster import. Mounted
                    only once this tab is first visited (rework round 1,
                    must-fix 1) — an in-flight job's own poll and its
                    ROST-11/12 per-row report used to be killed outright by
                    switching away from this tab mid-import. */}
                <section
                  aria-label="Roster import"
                  className="flex flex-col gap-2"
                >
                  <h2 className="text-section-title font-semibold text-neutral-900">
                    Roster
                  </h2>
                  <p className="text-sm text-neutral-600">
                    Import a class roster to enrol every student and create
                    their private Discord channel.
                  </p>
                  <RosterImport
                    organizationId={organizationId}
                    courseId={courseId}
                    courseTitle={form.title}
                  />
                </section>
              </>
            )}
          </div>

          <div
            role="tabpanel"
            id="course-tabpanel-people"
            aria-labelledby="course-tab-people"
            hidden={activeTab !== 'people'}
            className="flex flex-col gap-6"
          >
            {visitedTabs.has('people') && (
              <section aria-label="People" className="flex flex-col gap-2">
                <h2 className="text-section-title font-semibold text-neutral-900">
                  People
                </h2>
                <p className="text-sm text-neutral-600">
                  Everyone this course has ever enrolled, however they were
                  admitted. Ending stops someone asking this course without
                  deleting their transcript; reinstating undoes an end.
                </p>
                <CoursePeople
                  organizationId={organizationId}
                  courseId={courseId}
                  navigate={navigate}
                />
              </section>
            )}
          </div>
        </>
      )}

      {error && <ErrorMessage error={error} />}
      {halfSaved && (
        <p role="status" className="text-sm text-neutral-600">
          Your instructions were saved before this was refused, and stay saved —
          discarding now would only discard the settings above.
        </p>
      )}

      {/* WEB-15/WEB-35: the one primary action this form offers, always
          visible regardless of which tab is showing — an edit made on one
          tab is never stranded when someone is looking at another. */}
      <div>
        <Button
          variant="primary"
          onClick={() => void handleSave()}
          disabled={saving || switchSaving}
        >
          {saving || switchSaving ? 'Saving…' : 'Save course'}
        </Button>
      </div>
    </section>
  )
}
