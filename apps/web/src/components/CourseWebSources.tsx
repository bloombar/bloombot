/**
 * FILE-6/MDL-9: the screen a course's websites were missing entirely —
 * `courseWebSources.add/.list/.remove` already exist (`packages/actions`),
 * but nothing before this component ever offered any of it in the panel.
 * Modelled directly on `CourseAttachments.tsx` and `JoinLinks.tsx`: a list
 * of what a course is grounded in, one text field and an "Add website"
 * button, and a per-entry remove behind the same confirmation modal
 * pattern `CourseAttachments.tsx`'s own detach confirmation uses.
 *
 * **WEB-31: accepted, and reduced, not refused.** An instructor may type a
 * full URL — `https://docs.python.org/3/` — and this panel shows back
 * whatever `courseWebSources.add` actually stored: the bare domain the
 * action reduced it to (`docs.python.org`), never the string as typed.
 * That is not a bug this component works around; it is the requirement's
 * own contract, so there is nothing here re-deriving or re-displaying the
 * original input once the add has succeeded.
 *
 * **Adding a domain the course already names refuses, legibly** — the same
 * "surfaced through `ErrorMessage`, never swallowed" discipline every write
 * in this app already holds itself to; `courseWebSources.add`'s own
 * `ActionConflictError` carries a message naming the collision, which
 * `describeApiError` (`components/ErrorMessage.tsx`) already knows how to
 * render.
 *
 * **Removing confirms** (FILE-6): the confirmation says plainly that
 * removing a website changes what the course answers from — the same
 * "state the consequence before it happens" discipline
 * `CourseAttachments.tsx`'s own detach confirmation already holds itself
 * to for a knowledge file.
 */

import { useCallback, useEffect, useState } from 'react'

import {
  addCourseWebSource,
  ApiError,
  listCourseWebSources,
  removeCourseWebSource,
} from '../api/client.js'
import type { CourseWebSourceSummary } from '../api/types.js'
import { AddIcon, DeleteIcon, WebsiteIcon } from '../icons.js'
import { Button } from './Button.js'
import { ErrorMessage } from './ErrorMessage.js'
import { FormField } from './FormField.js'
import { textInputClasses } from './fieldStyles.js'
import { useModal } from './modal/ModalProvider.js'

export interface CourseWebSourcesProps {
  organizationId: string
  courseId: string
}

export function CourseWebSources({
  organizationId,
  courseId,
}: CourseWebSourcesProps) {
  const [sources, setSources] = useState<CourseWebSourceSummary[] | undefined>(
    undefined
  )
  const [loadError, setLoadError] = useState<ApiError | undefined>(undefined)
  const [domain, setDomain] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<ApiError | undefined>(undefined)
  const [removingId, setRemovingId] = useState<string | undefined>(undefined)
  const [removeError, setRemoveError] = useState<ApiError | undefined>(
    undefined
  )
  const { confirm } = useModal()

  const refresh = useCallback(
    () =>
      listCourseWebSources(organizationId, courseId).then(
        (list) => {
          setSources(list)
          setLoadError(undefined)
        },
        (caught: unknown) => {
          if (caught instanceof ApiError) setLoadError(caught)
          else throw caught
        }
      ),
    [organizationId, courseId]
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleAdd = async () => {
    const trimmedDomain = domain.trim()
    if (!trimmedDomain) return

    setAddError(undefined)
    setAdding(true)
    try {
      // WEB-31: `trimmedDomain` may be a full URL — `courseWebSources.add`
      // reduces it to a bare domain; `refresh` below reads back whatever it
      // actually stored, so this component never has to guess at the
      // reduction itself.
      await addCourseWebSource(organizationId, courseId, trimmedDomain)
      setDomain('')
      await refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setAddError(caught)
      else throw caught
    } finally {
      setAdding(false)
    }
  }

  const handleRemove = async (source: CourseWebSourceSummary) => {
    setRemoveError(undefined)
    // FILE-6: state the consequence before it happens — the same
    // discipline `CourseAttachments.tsx`'s own detach confirmation already
    // holds itself to.
    const confirmed = await confirm({
      title: `Remove "${source.domain}"?`,
      description:
        "This removes it from what the course is grounded in — the course's answers are no longer drawn from this site.",
      confirmLabel: 'Remove',
      destructive: true,
    })
    if (!confirmed) return

    setRemovingId(source.id)
    try {
      await removeCourseWebSource(organizationId, source.id)
      await refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setRemoveError(caught)
      else throw caught
    } finally {
      setRemovingId(undefined)
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="course-web-sources">
      {loadError && <ErrorMessage error={loadError} />}

      {sources && sources.length === 0 && (
        <p className="text-sm text-neutral-500">No websites added yet.</p>
      )}

      {sources && sources.length > 0 && (
        <ul className="flex flex-col gap-2">
          {sources.map((source) => (
            <li
              key={source.id}
              className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 p-3"
            >
              <div className="flex min-w-0 items-center gap-2">
                <WebsiteIcon
                  aria-hidden="true"
                  className="size-4 text-neutral-500"
                />
                <p className="truncate text-sm font-medium text-neutral-900">
                  {source.domain}
                </p>
              </div>
              <Button
                variant="ghost"
                aria-label={`Remove ${source.domain}`}
                icon={<DeleteIcon aria-hidden="true" className="size-4" />}
                onClick={() => void handleRemove(source)}
                disabled={removingId === source.id}
              >
                {removingId === source.id ? 'Removing…' : 'Remove'}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {removeError && <ErrorMessage error={removeError} />}

      <div className="flex flex-wrap items-end gap-2">
        <div className="w-64">
          <FormField label="Website">
            <input
              type="text"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              className={textInputClasses}
              placeholder="example.edu"
            />
          </FormField>
        </div>
        <Button
          variant="secondary"
          icon={<AddIcon aria-hidden="true" className="size-4" />}
          onClick={() => void handleAdd()}
          disabled={adding || domain.trim() === ''}
        >
          {adding ? 'Adding…' : 'Add website'}
        </Button>
      </div>
      {addError && <ErrorMessage error={addError} />}
    </div>
  )
}
