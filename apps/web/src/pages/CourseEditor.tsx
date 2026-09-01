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
 */

import { useEffect, useState } from 'react'

import { ApiError, getCourse, saveCourse } from '../api/client.js'
import { disableCourse, enableCourse } from '../api/client.js'
import type { SaveCourseCategoryInput, SaveCourseInput } from '../api/client.js'
import type { Course, Project } from '../api/types.js'
import { ErrorMessage } from '../components/ErrorMessage.js'

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
  const [loading, setLoading] = useState(courseId !== undefined)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [togglingEnabled, setTogglingEnabled] = useState(false)

  useEffect(() => {
    if (courseId === undefined) {
      setForm(blankForm())
      setLoading(false)
      return
    }
    setLoading(true)
    getCourse(organizationId, courseId).then(
      (course) => {
        setForm(formFromCourse(course))
        setLoading(false)
      },
      (caught: unknown) => {
        setLoading(false)
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [organizationId, courseId])

  const handleSave = async () => {
    setError(undefined)
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
        // comment on why this form never relies on "omitted."
        promptId: form.promptId.trim() === '' ? null : form.promptId.trim(),
        instructions:
          form.instructions.trim() === '' ? null : form.instructions,
        model: form.model.trim() === '' ? null : form.model.trim(),
        vectorStoreId:
          form.vectorStoreId.trim() === '' ? null : form.vectorStoreId.trim(),
        maxRequestsPerDay:
          form.maxRequestsPerDay.trim() === ''
            ? null
            : Number(form.maxRequestsPerDay),
        categories,
      }
      const saved = await saveCourse(organizationId, input)
      setForm(formFromCourse(saved))
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
    setError(undefined)
    setTogglingEnabled(true)
    try {
      if (form.enabled) {
        await disableCourse(organizationId, courseId)
        setForm((current) => ({ ...current, enabled: false }))
      } else {
        await enableCourse(organizationId, courseId)
        setForm((current) => ({ ...current, enabled: true }))
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
  const removeCategory = (key: string) => {
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
  const removeChannel = (categoryKey: string, channelKey: string) => {
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

  if (loading) {
    return <p>Loading…</p>
  }

  return (
    <section aria-label="Course" data-testid="course-editor">
      <button type="button" onClick={onCancel}>
        ← {project.name}
      </button>
      <h2>{courseId === undefined ? 'New course' : form.title || 'Course'}</h2>

      {/* WEB-9: what decides routing, shown together and up front. */}
      <section aria-label="What this course routes on">
        <p>
          A message reaches this course by the Discord category it arrived in,
          or by the author&apos;s role — these names have to match your Discord
          server exactly.
        </p>
        <label>
          Admins role
          <input
            aria-label="Admins role"
            value={form.adminsRole}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                adminsRole: event.target.value,
              }))
            }
          />
        </label>
        <label>
          Students role
          <input
            aria-label="Students role"
            value={form.studentsRole}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                studentsRole: event.target.value,
              }))
            }
          />
        </label>
      </section>

      <label>
        Title
        <input
          aria-label="Title"
          value={form.title}
          onChange={(event) =>
            setForm((current) => ({ ...current, title: event.target.value }))
          }
        />
      </label>

      <label>
        File prefix
        <input
          aria-label="File prefix"
          value={form.filePrefix}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              filePrefix: event.target.value,
            }))
          }
        />
      </label>

      <label>
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
        />{' '}
        Enabled
      </label>
      {courseId !== undefined && (
        <button
          type="button"
          onClick={() => void handleToggleEnabled()}
          disabled={togglingEnabled}
        >
          {form.enabled ? 'Disable' : 'Enable'}
        </button>
      )}

      <fieldset>
        <legend>Categories</legend>
        {form.categories.map((category) => (
          <fieldset key={category.key}>
            <legend>
              <input
                aria-label="Category name"
                value={category.name}
                onChange={(event) =>
                  updateCategory(category.key, event.target.value)
                }
              />
              <button
                type="button"
                onClick={() => removeCategory(category.key)}
              >
                Remove category
              </button>
            </legend>
            {category.channels.map((channel) => (
              <div key={channel.key}>
                <input
                  aria-label="Channel name"
                  value={channel.name}
                  onChange={(event) =>
                    updateChannel(category.key, channel.key, {
                      name: event.target.value,
                    })
                  }
                />
                <label>
                  <input
                    type="checkbox"
                    aria-label="Admins only"
                    checked={channel.adminsOnly}
                    onChange={(event) =>
                      updateChannel(category.key, channel.key, {
                        adminsOnly: event.target.checked,
                      })
                    }
                  />{' '}
                  Admins only
                </label>
                <button
                  type="button"
                  onClick={() => removeChannel(category.key, channel.key)}
                >
                  Remove channel
                </button>
              </div>
            ))}
            <button type="button" onClick={() => addChannel(category.key)}>
              Add channel
            </button>
          </fieldset>
        ))}
        <button type="button" onClick={addCategory}>
          Add category
        </button>
      </fieldset>

      <label>
        Instructions
        <textarea
          aria-label="Instructions"
          value={form.instructions}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              instructions: event.target.value,
            }))
          }
        />
      </label>

      <label>
        Model
        <input
          aria-label="Model"
          value={form.model}
          onChange={(event) =>
            setForm((current) => ({ ...current, model: event.target.value }))
          }
        />
      </label>

      <label>
        Prompt id
        <input
          aria-label="Prompt id"
          value={form.promptId}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              promptId: event.target.value,
            }))
          }
        />
      </label>

      <label>
        Vector store id
        <input
          aria-label="Vector store id"
          value={form.vectorStoreId}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              vectorStoreId: event.target.value,
            }))
          }
        />
      </label>

      <label>
        Max requests per day
        <input
          aria-label="Max requests per day"
          value={form.maxRequestsPerDay}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              maxRequestsPerDay: event.target.value,
            }))
          }
        />
      </label>

      {error && <ErrorMessage error={error} />}

      <button type="button" onClick={() => void handleSave()} disabled={saving}>
        {saving ? 'Saving…' : 'Save course'}
      </button>
    </section>
  )
}
