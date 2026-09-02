/**
 * WEB-19/FILE-4: a course's instructions, edited as their own versioned
 * record instead of a plain field on `courses.save` — the third instance,
 * this phase, of a capability built and reviewed with no screen ever
 * offering it (`pages/CourseEditor.tsx`'s own module comment names the
 * other two). `courseInstructions.save`/`.list`/`.restore` already recorded
 * an authored revision on every save and let an earlier one be restored;
 * this component is what finally calls them.
 *
 * **Its own save, not the main course form's.** `pages/CourseEditor.tsx`
 * saves everything else in one `courses.save` call — but `courses.save`
 * no longer accepts `instructions` at all (`packages/actions/src/actions/courses.ts`'s
 * own comment, `docs/DECISIONS.md` D-54), so folding this into that one
 * call would mean dispatching two actions behind one button and reconciling
 * two independent failure states (a category collision but a fine
 * instructions save, or the reverse). A section of its own — the same
 * "existing record only" shape `components/CourseAttachments.tsx` already
 * uses for a course's knowledge files — keeps each save's own success or
 * failure legible on its own terms, and reuses the "gated on `courseId`"
 * precedent rather than inventing a second one: a brand-new course has
 * nothing yet for a revision's `courseId` foreign key to point at, so this
 * section is offered only once a course actually exists.
 *
 * **Dirtiness is reported up, not tracked with its own navigation guard.**
 * `hooks/navigation-guard.tsx` holds exactly one registered guard at a time
 * (that file's own module comment: "the form registers a guard"), so two
 * components on the same page each calling `useUnsavedChangesGuard`
 * independently would clobber each other's registration rather than both
 * being honoured. `onDirtyChange` lets `CourseEditor` fold this section's
 * own pending edit into the one `isDirty` it already feeds that hook, so an
 * unsaved instructions edit still blocks navigation exactly the way an
 * unsaved title edit does.
 *
 * **"Who"** is `savedByAccountId` (`api/types.ts`'s own comment on
 * `CourseInstructionRevisionSummary` — this app has no read that turns an
 * account id into a display name yet, D-54).
 *
 * **Restoring confirms first** (WEB-15) — it replaces what an instructor
 * currently sees, through the one modal primitive every destructive control
 * in this panel shares, and it is itself a new revision
 * (`courseInstructions.restore`'s own doc comment): the revision restored
 * from, and everything saved after it, is never deleted or rewritten.
 *
 * **Rework finding: a background load must never overwrite an edit already
 * in progress.** The first version of this component set the textarea from
 * every `refresh()`, unconditionally, including the mount effect's own
 * initial load — an instructor who started typing before
 * `courseInstructions.list` resolved (a slow link, or simply a fast typist
 * on a brand-new course) had it silently replaced with whatever the list
 * came back with, `Save instructions` left disabled because the wiped
 * textarea now matched the freshly-set baseline. `hasPendingEditRef`
 * (below) is what `refresh` checks before touching `text` — see its own
 * comment for why a ref, not a `text === baseline` comparison, is what a
 * memoized closure actually needs here.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ApiError,
  listCourseInstructionRevisions,
  restoreCourseInstructionRevision,
  saveCourseInstructions,
} from '../api/client.js'
import type { CourseInstructionRevisionSummary } from '../api/types.js'
import { RestoreIcon } from '../icons.js'
import { Button } from './Button.js'
import { ErrorMessage } from './ErrorMessage.js'
import { textInputClasses } from './fieldStyles.js'
import { FormField } from './FormField.js'
import { useModal } from './modal/ModalProvider.js'

export interface CourseInstructionsProps {
  organizationId: string
  courseId: string
  /** Called on every change to this section's own dirtiness — see this file's own module comment on why `CourseEditor` needs it folded into its one navigation guard rather than this component registering a second one. */
  onDirtyChange: (dirty: boolean) => void
}

export function CourseInstructions({
  organizationId,
  courseId,
  onDirtyChange,
}: CourseInstructionsProps) {
  const [revisions, setRevisions] = useState<
    CourseInstructionRevisionSummary[] | undefined
  >(undefined)
  const [loadError, setLoadError] = useState<ApiError | undefined>(undefined)
  // `text` is the live edit; `baseline` is the current revision's own text
  // (the newest entry in `revisions`, since every save and restore writes
  // both `courses.instructions` and a matching revision in the same
  // transaction — `course-instructions.ts`'s own doc comment) — the same
  // "what the server last agreed to" role `pages/CourseEditor.tsx`'s own
  // `baseline` plays for the rest of the form.
  const [text, setText] = useState('')
  const [baseline, setBaseline] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<ApiError | undefined>(undefined)
  const [restoringId, setRestoringId] = useState<string | undefined>(undefined)
  const [restoreError, setRestoreError] = useState<ApiError | undefined>(
    undefined
  )
  const { confirm } = useModal()

  // Rework finding: whether the textarea currently holds an edit `refresh`
  // must not clobber — a ref, not a comparison against the `text`/`baseline`
  // state read inside `refresh`'s own closure, because that closure is
  // captured once (`useCallback`'s deps below never change after mount) and
  // would otherwise always see the *initial* `text`/`baseline` ('', ''), not
  // whatever a person has actually typed by the time a fetch resolves. Set
  // `true` the moment the textarea changes; cleared only when `refresh`
  // itself decides the textarea should show the server's own value (below).
  const hasPendingEditRef = useRef(false)

  const refresh = useCallback(
    // `force`: `handleSave`/`handleRestore` pass `true` — an explicit save
    // or restore must always end with the textarea showing exactly what was
    // just written, even over an edit typed mid-round-trip, because that is
    // what each of their own confirmations already promises. The mount
    // effect below passes `false` (the default): a *background* load must
    // never overwrite an edit already in progress — the bug this rework
    // fixes was exactly this call, unconditionally, wiping out whatever an
    // instructor had already typed while `courseInstructions.list`'s own
    // first response was still in flight (reproduced by
    // `tests/course-instructions.test.tsx`'s own "a background load never
    // overwrites an edit already in progress" case).
    (options: { force?: boolean } = {}) =>
      listCourseInstructionRevisions(organizationId, courseId).then(
        (list) => {
          setRevisions(list)
          setLoadError(undefined)
          const current = list[0]?.instructions ?? ''
          setBaseline(current)
          if (options.force || !hasPendingEditRef.current) {
            setText(current)
            hasPendingEditRef.current = false
          }
          return list
        },
        (caught: unknown) => {
          if (caught instanceof ApiError) setLoadError(caught)
          else throw caught
          return undefined
        }
      ),
    [organizationId, courseId]
  )

  // Initial load, and whenever the course itself changes.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // Reported on every change, not only on save — a person mid-edit who
  // navigates away must be warned before the edit is even submitted, not
  // only after (WEB-16).
  useEffect(() => {
    onDirtyChange(text !== baseline)
  }, [text, baseline, onDirtyChange])

  const handleSave = async () => {
    setSaveError(undefined)
    setSaving(true)
    try {
      await saveCourseInstructions(organizationId, courseId, text)
      await refresh({ force: true })
    } catch (caught) {
      if (caught instanceof ApiError) setSaveError(caught)
      else throw caught
    } finally {
      setSaving(false)
    }
  }

  const handleRestore = async (revision: CourseInstructionRevisionSummary) => {
    setRestoreError(undefined)
    // WEB-15: restoring replaces what an instructor currently sees — the
    // same modal every other destructive control in this panel shares, not
    // a bespoke dialog.
    const confirmed = await confirm({
      title: 'Restore this revision?',
      description:
        text !== baseline
          ? 'This replaces the instructions text below, including the edit you have not saved yet, and is itself recorded as a new revision.'
          : 'This replaces the current instructions text and is itself recorded as a new revision.',
      confirmLabel: 'Restore',
      destructive: true,
    })
    if (!confirmed) return

    setRestoringId(revision.id)
    try {
      await restoreCourseInstructionRevision(organizationId, revision.id)
      await refresh({ force: true })
    } catch (caught) {
      if (caught instanceof ApiError) setRestoreError(caught)
      else throw caught
    } finally {
      setRestoringId(undefined)
    }
  }

  const isDirty = text !== baseline

  return (
    <div className="flex flex-col gap-3" data-testid="course-instructions">
      {loadError && <ErrorMessage error={loadError} />}

      <FormField label="Instructions">
        <textarea
          aria-label="Instructions"
          value={text}
          onChange={(event) => {
            hasPendingEditRef.current = true
            setText(event.target.value)
          }}
          rows={4}
          className={textInputClasses}
        />
      </FormField>

      {saveError && <ErrorMessage error={saveError} />}

      <div>
        <Button
          variant="primary"
          onClick={() => void handleSave()}
          // FILE-4's own `instructions: z.string().min(1)` refuses a blank
          // save server-side — refusing here too means an instructor never
          // makes that round trip only to be told the same thing back.
          disabled={saving || !isDirty || text.trim() === ''}
        >
          {saving ? 'Saving…' : 'Save instructions'}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-section-title font-semibold text-neutral-900">
          History
        </h3>
        {revisions === undefined && !loadError && (
          <p role="status" className="text-sm text-neutral-500">
            Loading…
          </p>
        )}
        {revisions && revisions.length === 0 && (
          <p className="text-sm text-neutral-500">No instructions saved yet.</p>
        )}
        {revisions && revisions.length > 0 && (
          <ul className="flex flex-col gap-2">
            {revisions.map((revision, index) => (
              <li
                key={revision.id}
                className="flex flex-col gap-1 rounded-md border border-neutral-200 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-neutral-600">
                    Saved by {revision.savedByAccountId} on{' '}
                    {new Date(revision.createdAt).toLocaleString()}
                  </p>
                  {index === 0 ? (
                    <span className="text-sm font-medium text-neutral-500">
                      Current
                    </span>
                  ) : (
                    <Button
                      variant="secondary"
                      icon={
                        <RestoreIcon aria-hidden="true" className="size-4" />
                      }
                      onClick={() => void handleRestore(revision)}
                      disabled={restoringId !== undefined}
                    >
                      {restoringId === revision.id
                        ? 'Restoring…'
                        : 'Restore this revision'}
                    </Button>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-sm text-neutral-800">
                  {revision.instructions}
                </p>
              </li>
            ))}
          </ul>
        )}
        {restoreError && <ErrorMessage error={restoreError} />}
      </div>
    </div>
  )
}
