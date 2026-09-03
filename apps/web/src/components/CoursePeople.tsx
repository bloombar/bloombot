/**
 * WEB-22: the screen a course's people were missing entirely —
 * `enrolments.end` has existed as an action with no surface (removing a
 * student has only ever been possible by dispatching it by hand), and the
 * repo could not even list an ended person for an instructor to choose
 * between (`listPeopleForCourse` returns active enrolments only). This
 * lists everyone the course has ever enrolled, active and ended alike, how
 * each was admitted, and lets an instructor end an active enrolment or
 * reinstate an ended one (ENRL-9).
 *
 * **Two lists, not one with a status column.** A status column that only
 * differs by a word is easy to misread right before removing somebody — so
 * "Enrolled" and "Enrolment ended" are two visually distinct lists, each
 * with its own heading, the same way this screen's sibling `JoinLinks.tsx`
 * separates a live link from a revoked one by section rather than by
 * scanning a column.
 *
 * **Ending confirms both halves of ENRL-6; reinstating does not confirm at
 * all.** Ending is destructive in the sense that matters here — it removes
 * someone's access — so its confirmation states plainly what it does *and
 * does not* do, the same "say both halves" discipline `JoinLinks.tsx`'s own
 * revoke confirmation already holds itself to for ENRL-4. Reinstating
 * grants access back rather than taking anything away, so it runs
 * immediately, the same "no confirmation for a grant" choice this app makes
 * nowhere else needs stating twice.
 *
 * **No email.** `CourseEnrolment.displayName` is nullable — a person PPL-3
 * created on first contact and never named since — and this screen falls
 * back to `personId` for that row, not the person's own email
 * (`api/types.ts#CourseEnrolment`'s own doc comment): a `null` display name
 * is already told apart from another by a distinct id, and these are real
 * students' addresses, shown only where a screen genuinely cannot tell two
 * people apart without one, which is not the case here.
 */

import { useCallback, useEffect, useState } from 'react'

import {
  ApiError,
  endCourseEnrolment,
  listCourseEnrolments,
  reinstateCourseEnrolment,
} from '../api/client.js'
import type { CourseEnrolment } from '../api/types.js'
import { DisableIcon, RestoreIcon } from '../icons.js'
import { Button } from './Button.js'
import { ErrorMessage } from './ErrorMessage.js'
import { useModal } from './modal/ModalProvider.js'

export interface CoursePeopleProps {
  organizationId: string
  courseId: string
}

const SOURCE_LABELS: Record<CourseEnrolment['source'], string> = {
  join_link: 'Join link',
  discord_role: 'Discord role',
  roster: 'Roster import',
}

/** What a row shows in place of a name — `displayName` when the person has one, `personId` otherwise (this file's own module comment on why never email). */
function label(entry: CourseEnrolment): string {
  return entry.displayName ?? entry.personId
}

export function CoursePeople({ organizationId, courseId }: CoursePeopleProps) {
  const [entries, setEntries] = useState<CourseEnrolment[] | undefined>(
    undefined
  )
  const [loadError, setLoadError] = useState<ApiError | undefined>(undefined)
  const [endingId, setEndingId] = useState<string | undefined>(undefined)
  const [endError, setEndError] = useState<ApiError | undefined>(undefined)
  const [reinstatingId, setReinstatingId] = useState<string | undefined>(
    undefined
  )
  const [reinstateError, setReinstateError] = useState<ApiError | undefined>(
    undefined
  )
  // A live region for the one thing a screen reader cannot otherwise learn
  // from this screen's own re-render: a sighted user sees a row move from
  // "Enrolled" to "Enrolment ended" (or back) after an end or a reinstate
  // succeeds, but nothing about that move is itself announced. `sr-only` —
  // the row's own move already carries the same information visually, so
  // this only needs to reach the one audience that move does not reach.
  // Cleared on every new attempt so a stale announcement never lingers
  // alongside a fresh error.
  const [statusMessage, setStatusMessage] = useState<string | undefined>(
    undefined
  )
  const { confirm } = useModal()

  const refresh = useCallback(
    () =>
      listCourseEnrolments(organizationId, courseId).then(
        (list) => {
          setEntries(list)
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

  const handleEnd = async (entry: CourseEnrolment) => {
    setEndError(undefined)
    setStatusMessage(undefined)
    // ENRL-6: both halves, stated plainly, before anything happens — the
    // same discipline `JoinLinks.tsx`'s own revoke confirmation holds
    // itself to for ENRL-4.
    const confirmed = await confirm({
      title: `End ${label(entry)}'s enrolment?`,
      description:
        'This stops them asking this course. It does not delete their transcript or the course’s record of what was asked.',
      confirmLabel: 'End enrolment',
      destructive: true,
    })
    if (!confirmed) return

    setEndingId(entry.id)
    try {
      await endCourseEnrolment(organizationId, entry.id)
      setStatusMessage(`Ended ${label(entry)}'s enrolment.`)
      await refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setEndError(caught)
      else throw caught
    } finally {
      setEndingId(undefined)
    }
  }

  const handleReinstate = async (entry: CourseEnrolment) => {
    setReinstateError(undefined)
    setStatusMessage(undefined)
    // ENRL-9: reinstating grants access back rather than removing it — no
    // confirmation, the same "a grant does not confirm" choice this file's
    // own module comment states.
    setReinstatingId(entry.id)
    try {
      await reinstateCourseEnrolment(organizationId, entry.id)
      setStatusMessage(`Reinstated ${label(entry)}'s enrolment.`)
      await refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setReinstateError(caught)
      else throw caught
    } finally {
      setReinstatingId(undefined)
    }
  }

  if (loadError) return <ErrorMessage error={loadError} />
  if (!entries) return null

  const active = entries.filter((entry) => entry.endedAt === null)
  const ended = entries.filter((entry) => entry.endedAt !== null)

  return (
    <div className="flex flex-col gap-4" data-testid="course-people">
      <p role="status" className="sr-only">
        {statusMessage}
      </p>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-neutral-900">
          Enrolled ({active.length})
        </h3>
        {active.length === 0 && (
          <p className="text-sm text-neutral-500">Nobody is enrolled yet.</p>
        )}
        {active.length > 0 && (
          <ul className="flex flex-col gap-2">
            {active.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 p-3"
              >
                <div>
                  <p className="text-sm font-medium text-neutral-900">
                    {label(entry)}
                  </p>
                  <p className="text-sm text-neutral-500">
                    {SOURCE_LABELS[entry.source]} — admitted{' '}
                    {new Date(entry.createdAt).toLocaleString()}
                  </p>
                </div>
                <Button
                  variant="destructive"
                  aria-label={`End ${label(entry)}'s enrolment`}
                  icon={<DisableIcon aria-hidden="true" className="size-4" />}
                  onClick={() => void handleEnd(entry)}
                  disabled={endingId === entry.id}
                >
                  {endingId === entry.id ? 'Ending…' : 'End'}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {endError && <ErrorMessage error={endError} />}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-neutral-900">
          Enrolment ended ({ended.length})
        </h3>
        {ended.length === 0 && (
          <p className="text-sm text-neutral-500">
            Nobody&apos;s enrolment has ended.
          </p>
        )}
        {ended.length > 0 && (
          <ul className="flex flex-col gap-2">
            {ended.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 bg-neutral-50 p-3"
              >
                <div>
                  <p className="text-sm font-medium text-neutral-900">
                    {label(entry)}
                  </p>
                  <p className="text-sm text-neutral-500">
                    {SOURCE_LABELS[entry.source]} — ended{' '}
                    {entry.endedAt !== null
                      ? new Date(entry.endedAt).toLocaleString()
                      : ''}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  aria-label={`Reinstate ${label(entry)}'s enrolment`}
                  icon={<RestoreIcon aria-hidden="true" className="size-4" />}
                  onClick={() => void handleReinstate(entry)}
                  disabled={reinstatingId === entry.id}
                >
                  {reinstatingId === entry.id ? 'Reinstating…' : 'Reinstate'}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {reinstateError && <ErrorMessage error={reinstateError} />}
      </div>
    </div>
  )
}
