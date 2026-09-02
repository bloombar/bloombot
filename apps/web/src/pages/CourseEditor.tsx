/**
 * WEB-8/WEB-9: a course, defined entirely in the panel — CFG-2 (OpenAI
 * settings), CFG-3 (roles) and CFG-4 (categories and channels), saved
 * through `courses.save` (create when `courseId` is `undefined`, update
 * otherwise), plus `courses.enable`/`courses.disable` once a course exists
 * to enable or disable.
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
 * WEB-18/FILE-1..3: a course's knowledge files (what it is grounded in) are
 * `components/CourseAttachments.tsx`'s own screen, embedded below — see
 * that file's module comment for the upload/pending/ready/failed/detach
 * shape; this file only decides where it sits and that it is offered for
 * an existing course, the same "existing record only" gate the Discord
 * channels section and the enable/disable toggle both already use.
 */

import { useEffect, useState } from 'react'

import { ApiError, getCourse, saveCourse } from '../api/client.js'
import { disableCourse, enableCourse } from '../api/client.js'
import type { SaveCourseCategoryInput, SaveCourseInput } from '../api/client.js'
import type { Course, Project } from '../api/types.js'
import { Button } from '../components/Button.js'
import { CourseAttachments } from '../components/CourseAttachments.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { checkboxClasses, textInputClasses } from '../components/fieldStyles.js'
import { FormField } from '../components/FormField.js'
import { useModal } from '../components/modal/ModalProvider.js'
import { ScaffoldButton } from '../components/ScaffoldButton.js'
import { useFormDirty } from '../hooks/useFormDirty.js'
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard.js'
import {
  AddIcon,
  DisableIcon,
  EnableIcon,
  RemoveFromListIcon,
  WarningIcon,
} from '../icons.js'

export interface CourseEditorProps {
  organizationId: string
  project: Project
  /** `undefined` — define a new course. A string — edit the course with that id. */
  courseId: string | undefined
  onSaved: (course: Course) => void
  onCancel: () => void
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

/** Blank editable state for a brand-new course — `enabled: false`: a fresh course's category and role names have not been confirmed against this term's Discord server yet, so it starts disabled the same way a duplicated course does (D-23), rather than defaulting to routing immediately. */
function blankForm() {
  return {
    title: '',
    filePrefix: '',
    enabled: false,
    adminsRole: '',
    studentsRole: '',
    promptId: '',
    instructions: '',
    model: '',
    vectorStoreId: '',
    maxRequestsPerDay: '',
    categories: [] as EditableCategory[],
  }
}

function formFromCourse(course: Course) {
  return {
    title: course.title,
    filePrefix: course.filePrefix,
    enabled: course.enabled,
    adminsRole: course.adminsRole,
    studentsRole: course.studentsRole,
    promptId: course.promptId ?? '',
    instructions: course.instructions ?? '',
    model: course.model ?? '',
    vectorStoreId: course.vectorStoreId ?? '',
    maxRequestsPerDay:
      course.maxRequestsPerDay === null ? '' : String(course.maxRequestsPerDay),
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
  onSaved,
  onCancel,
}: CourseEditorProps) {
  const [form, setForm] = useState<FormState>(blankForm())
  // WEB-16: the form's own last agreed-with-the-server state — set
  // alongside `form` in the same three places `form` is ever set *from* a
  // real record rather than an edit (a fresh blank form, a load, a save),
  // never on a field-by-field edit. `useFormDirty` compares this against
  // the live `form` below; see that hook's own module comment for why
  // "dirty" is a value comparison, not a keystroke count.
  const [baseline, setBaseline] = useState<FormState>(blankForm())
  const isDirty = useFormDirty(baseline, form)
  const { confirmDiscard } = useUnsavedChangesGuard(isDirty)
  const { confirm } = useModal()
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
  const [togglingEnabled, setTogglingEnabled] = useState(false)
  // Finding 4 (WEB-7 rework): the last enabled state `courses.save`,
  // `courses.enable` or `courses.disable` actually confirmed — separate from
  // `form.enabled`, the checkbox's own pending edit. Without the split, a
  // save the API refused (a PROJ-3 collision) left `form.enabled` ticked from
  // the edit that never took, and the live toggle button read it too — so
  // the button claimed a never-enabled course was enabled, and clicking it
  // sent `courses.disable` for a course that had never actually been
  // enabled. The button below always reads `confirmedEnabled`; only the
  // checkbox reads `form.enabled`.
  const [confirmedEnabled, setConfirmedEnabled] = useState(false)

  useEffect(() => {
    // Finding 8 (WEB-7 rework): guards against an out-of-order response —
    // if `courseId` changes again before this fetch resolves, the response
    // that lands is stale and must not overwrite what the current props
    // asked for.
    let stale = false
    if (courseId === undefined) {
      const blank = blankForm()
      setForm(blank)
      setBaseline(blank)
      setLoadError(undefined)
      setConfirmedEnabled(false)
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
        setConfirmedEnabled(course.enabled)
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

  const handleSave = async () => {
    setError(undefined)
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
      return
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
        filePrefix: form.filePrefix,
        enabled: form.enabled,
        adminsRole: form.adminsRole,
        studentsRole: form.studentsRole,
        // Every optional field below is sent explicitly — `null` when the
        // input is empty, the value otherwise — per this module's own
        // comment on why this form never relies on "omitted." `promptId`
        // is the one deliberate exception (MDL-8): this form has no
        // control that can change it any more, so it is never sent at all
        // — `courses.save`'s own "omitted preserves what is stored" rule
        // is exactly what keeps a course that already has one answered
        // through it, unchanged, save after save.
        instructions:
          form.instructions.trim() === '' ? null : form.instructions,
        model: form.model.trim() === '' ? null : form.model.trim(),
        vectorStoreId:
          form.vectorStoreId.trim() === '' ? null : form.vectorStoreId.trim(),
        maxRequestsPerDay: maxRequestsPerDay.value,
        categories,
      }
      const saved = await saveCourse(organizationId, input)
      const savedForm = formFromCourse(saved)
      setForm(savedForm)
      // WEB-16: a successful save clears the dirty state — the form now
      // agrees with the server again, the same reason `setForm` above is
      // set from `saved` rather than left as whatever was typed.
      setBaseline(savedForm)
      setConfirmedEnabled(saved.enabled)
      onSaved(saved)
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setSaving(false)
    }
  }

  const handleToggleEnabled = async () => {
    if (courseId === undefined) return
    // WEB-15: disabling a live course is destructive — students stop
    // being answered the moment this runs — so it confirms first, the
    // same modal every other destructive control in this panel shares
    // (`components/modal/`). Enabling is not: nothing is lost by turning a
    // course back on, so it runs immediately, the same as before.
    if (confirmedEnabled) {
      const confirmed = await confirm({
        title: 'Disable this course?',
        description:
          'Students stop being answered here until it is enabled again.',
        confirmLabel: 'Disable',
        destructive: true,
      })
      if (!confirmed) return
    }
    setError(undefined)
    setTogglingEnabled(true)
    try {
      // Reads and sets `confirmedEnabled`, not `form.enabled` — the button
      // acts on the server-confirmed state, not a pending, unsaved edit to
      // the checkbox above (finding 4 of the WEB-7 rework). A successful
      // toggle has no pending edit left to disagree with, so both states
      // move together here.
      if (confirmedEnabled) {
        await disableCourse(organizationId, courseId)
        setConfirmedEnabled(false)
        setForm((current) => ({ ...current, enabled: false }))
        // Already persisted (unlike the checkbox above, this button acts
        // immediately, not on the next Save) — the baseline moves with it,
        // the same reason `handleSave`'s own success path moves `baseline`
        // to match what was just saved.
        setBaseline((current) => ({ ...current, enabled: false }))
      } else {
        await enableCourse(organizationId, courseId)
        setConfirmedEnabled(true)
        setForm((current) => ({ ...current, enabled: true }))
        setBaseline((current) => ({ ...current, enabled: true }))
      }
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setTogglingEnabled(false)
    }
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

      {/* WEB-9: what decides routing, shown together and up front. */}
      <section
        aria-label="What this course routes on"
        className="flex flex-col gap-3 rounded-md border border-neutral-200 bg-neutral-50 p-4"
      >
        <p className="text-sm text-neutral-600">
          A message reaches this course by the Discord category it arrived in,
          or by the author&apos;s role — these names have to match your Discord
          server exactly.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            label="Admins role"
            {...fieldErrorProp(error, 'adminsRole')}
          >
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
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
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

        <FormField label="File prefix" {...fieldErrorProp(error, 'filePrefix')}>
          <input
            aria-label="File prefix"
            value={form.filePrefix}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                filePrefix: event.target.value,
              }))
            }
            className={textInputClasses}
          />
        </FormField>
      </div>

      <div className="flex items-center gap-3">
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
        {courseId !== undefined && (
          <Button
            variant={confirmedEnabled ? 'destructive' : 'secondary'}
            icon={
              confirmedEnabled ? (
                <DisableIcon aria-hidden="true" className="size-4" />
              ) : (
                <EnableIcon aria-hidden="true" className="size-4" />
              )
            }
            onClick={() => void handleToggleEnabled()}
            disabled={togglingEnabled}
          >
            {/* Reads `confirmedEnabled`, not `form.enabled` — see this
                component's own comment on that state (finding 4). */}
            {confirmedEnabled ? 'Disable' : 'Enable'}
          </Button>
        )}
      </div>

      {/* SRV-6: scaffolding needs a persisted course to name in the job
          payload — offered only once this course actually has a `courseId`,
          the same "existing record only" gate the enable/disable toggle
          above already applies. */}
      {courseId !== undefined && (
        <section aria-label="Discord channels" className="flex flex-col gap-2">
          <h2 className="text-section-title font-semibold text-neutral-900">
            Discord channels
          </h2>
          <p className="text-sm text-neutral-600">
            Create this course&apos;s declared categories and channels in the
            Discord server bound to this organization.
          </p>
          <ScaffoldButton organizationId={organizationId} courseId={courseId} />
        </section>
      )}

      {/* WEB-18/FILE-1: a course's knowledge files — same gate as Discord
          channels above, an attachment belongs to an existing course. */}
      {courseId !== undefined && (
        <section aria-label="Knowledge files" className="flex flex-col gap-2">
          <h2 className="text-section-title font-semibold text-neutral-900">
            Knowledge files
          </h2>
          <p className="text-sm text-neutral-600">
            The notes, syllabus and schedule this course is grounded in.
            Detaching one stops it grounding answers immediately, and reaches
            the provider — it cannot be undone.
          </p>
          <CourseAttachments
            organizationId={organizationId}
            courseId={courseId}
          />
        </section>
      )}

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

      {/* MDL-8: a course with a stored prompt id (D-3's Python-era escape
          hatch) is answered through it — `buildResponsesRequestBody`
          (`packages/openai/src/responses.ts`) sends `prompt` instead of
          `instructions` whenever one is set, so the field below is inert on
          exactly these courses. This is the visibility half of MDL-8: an
          instructor editing Instructions here must know that, not discover
          it by an answer never changing. The field itself is never offered
          for a new course (`blankForm` carries no way to set one) and is no
          longer editable at all here — MDL-8's own "stop offering it,"
          applied to an update as well as a create; see
          `packages/actions/src/actions/courses.ts`'s own `promptId` comment
          for the write-side half of the same refusal. */}
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

      <FormField label="Instructions">
        <textarea
          aria-label="Instructions"
          value={form.instructions}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              instructions: event.target.value,
            }))
          }
          rows={4}
          className={textInputClasses}
        />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Model"
          help="Leave blank to use the platform default."
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
            behind the banner above, never so it can be typed into or
            cleared here. */}
        {form.promptId && (
          <FormField
            label="Prompt id"
            help="Inherited from before this panel existed. Deprecated — see the notice above."
          >
            <input
              aria-label="Prompt id"
              value={form.promptId}
              readOnly
              className={textInputClasses}
            />
          </FormField>
        )}

        <FormField label="Vector store id">
          <input
            aria-label="Vector store id"
            value={form.vectorStoreId}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                vectorStoreId: event.target.value,
              }))
            }
            className={textInputClasses}
          />
        </FormField>

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

      {error && <ErrorMessage error={error} />}

      {/* WEB-15: the one primary action this form offers. */}
      <div>
        <Button
          variant="primary"
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save course'}
        </Button>
      </div>
    </section>
  )
}
