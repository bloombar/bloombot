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
 * **WEB-52 reverses this screen's earlier "no email" choice.** Every row now
 * shows whichever of a full name (`firstName`/`lastName`), an email, and a
 * Discord display name (`displayName`) are known, omitting the rest — the
 * first of these that is known is the primary line, linking to the
 * transcript, and a smaller secondary line names whichever of the others
 * are known, followed by how the person joined and when (`SOURCE_LABELS`,
 * date *and* time) and, once ended, when that happened too. `personId` —
 * the bare UUID — is shown only when all three identifiers are unknown, the
 * same "nothing left to fall back to" case this screen has always had, just
 * pushed one identifier further out now that email and Discord name are
 * also tried first. This is an instructor-only view of their own course's
 * enrolments (`docs/DECISIONS.md`), which is why showing email here does
 * not reopen the concern the original "no email" choice was guarding
 * against.
 *
 * **Rework round 1: every detail is labelled, not only Discord's.** Before
 * this, only the secondary line's own `Discord: …` prefix named what it was
 * showing — a bare email or a bare name on the primary line, and a bare
 * date on the secondary one, left an instructor to infer what each thing
 * *was* from its shape alone, which breaks down the moment the primary line
 * is an email rather than a name (nothing about `jane@x.edu` on its own
 * says "this is standing in for a name"). `identityFields`/`primaryField`/
 * `secondaryFields` below build a small, uniform `{ label, value }` pair
 * (`PersonField`) for every known identifier and for the join/end facts,
 * labelled the same way regardless of which one ends up on the primary
 * line — the primary line's own label sits just above it, in small, muted
 * text of its own (`Name`/`Email`/`Discord`/`ID`), and the secondary line's
 * labels sit inline, right beside each value (`Email: … · Joined: …`); both
 * stay compact — one or two lines per row, no new visual weight — but
 * neither ever leaves a value unlabelled.
 *
 * WEB-36: every row's own name is also a real link to that person's
 * transcript for this course (`routing/route.ts#TranscriptsRoute`) — a
 * genuine `<a href>` (`buildPath`'s own output), so it can be copied,
 * opened in a new tab, or read by assistive technology as a link, but its
 * `onClick` navigates in-app (the `navigate` prop, a push, threaded down
 * from `pages/CourseEditor.tsx`/`pages/ProjectsPanel.tsx`) rather than
 * letting the browser reload the whole page for an address this app can
 * already render without one. `TranscriptLink`, below, is the one place
 * that click lives — both lists render the same component rather than each
 * repeating the plain-click predicate and the `href`/`onClick` pair by
 * hand, which used to drift apart by definition alone (rework round 1,
 * cheap fix).
 *
 * **Rework round 1: the link bypassed WEB-16's own unsaved-changes guard.**
 * A raw call to `navigate` unmounts `pages/CourseEditor.tsx` immediately —
 * `routing/useRoute.ts`'s own `navigate` only ever consults the registered
 * guard on a `popstate`, not on a call like this one — so a title edited on
 * the General tab and never saved was silently gone the moment a click
 * here landed on the People tab. Every other in-app navigation this shell
 * starts already goes through `useNavigationGuard()`'s own `guardedNavigate`
 * (`pages/Shell.tsx`'s own module comment) precisely so a dirty form gets
 * its say first; this component reads that same context directly (a plain
 * descendant of the one `NavigationGuardProvider` `pages/Shell.tsx` mounts
 * — no new prop needed to reach it) and wraps the `navigate` prop's own
 * call in it, rather than calling `navigate` bare. Both lists link
 * identically — ending an enrolment never deleted the transcript (ENRL-6),
 * and reading it afterwards is the point.
 */

import { useCallback, useEffect, useState, type MouseEvent } from 'react'

import {
  ApiError,
  endCourseEnrolment,
  listCourseEnrolments,
  reinstateCourseEnrolment,
} from '../api/client.js'
import type { CourseEnrolment } from '../api/types.js'
import { buildPath, type Route } from '../routing/route.js'
import { useNavigationGuard } from '../hooks/navigation-guard.js'
import { DisableIcon, RestoreIcon } from '../icons.js'
import { Button } from './Button.js'
import { ErrorMessage } from './ErrorMessage.js'
import { useModal } from './modal/ModalProvider.js'

export interface CoursePeopleProps {
  organizationId: string
  courseId: string
  /** WEB-36 — called with the address a row's own name links to, on an ordinary click (no modifier key, not a right-click — `TranscriptLink`'s own comment on why those are left to the browser's own new-tab/context-menu handling); pushes so Back returns to this People tab. Routed through `useNavigationGuard()`'s own `guardedNavigate` inside this component (this file's own module comment on why), so the caller never has to. */
  navigate: (route: Route, options?: { replace?: boolean }) => void
}

const SOURCE_LABELS: Record<CourseEnrolment['source'], string> = {
  join_link: 'Join link',
  discord_role: 'Discord role',
  roster: 'Roster import',
  // ENRL-13 — admitted by messaging a course carrying `selfEnrolFromDiscord`.
  self_enrolment: 'Self-enrolled',
}

/** `firstName`/`lastName` joined, whichever exists — `undefined` when neither is known, not an empty string, so callers can tell "no name" apart from a name that happens to be blank. */
function fullName(entry: CourseEnrolment): string | undefined {
  const parts = [entry.firstName, entry.lastName].filter(
    (part): part is string => part !== null && part !== ''
  )
  return parts.length > 0 ? parts.join(' ') : undefined
}

/** One labelled fact a row shows — `Name: Jane Doe`, `Email: jane@x.edu`, `Joined: Roster import — 16 Sep 2026, 14:03`, and so on. Always rendered as `${label}: ${value}` — a label is never separated from its own value. */
interface PersonField {
  label: string
  value: string
}

/**
 * WEB-52 (rework round 1) — every identifier this screen knows about a
 * person, labelled, in priority order: full name, email, Discord display
 * name. The first of these is what the primary line shows (`primaryField`,
 * below); the rest (`remainingFields`) go on the secondary line — each
 * still carrying its own label, so an email standing in for a missing name
 * on the primary line reads as `Email: jane@x.edu`, not a bare address with
 * no explanation of what it is standing in for.
 */
function identityFields(entry: CourseEnrolment): PersonField[] {
  const fields: PersonField[] = []
  const name = fullName(entry)
  if (name !== undefined) fields.push({ label: 'Name', value: name })
  if (entry.email !== null) fields.push({ label: 'Email', value: entry.email })
  if (entry.displayName !== null) {
    fields.push({ label: 'Discord', value: entry.displayName })
  }
  return fields
}

/**
 * The row's primary line: the first known identifier (this file's own
 * module comment has the ordering), or the bare person id when none of the
 * three is known — labelled `ID`, the same "nothing left to fall back to"
 * case this screen has always had.
 */
function primaryField(entry: CourseEnrolment): PersonField {
  return identityFields(entry)[0] ?? { label: 'ID', value: entry.personId }
}

/** Just the primary field's own value — what a confirmation dialog or an aria-label names the row by; those read as plain prose ("End Jane Doe's enrolment"), not as a labelled fact, so no `label` prefix belongs there. */
function identifierText(entry: CourseEnrolment): string {
  return primaryField(entry).value
}

/** Every known identifier *except* whichever one `primaryField` already used, so nothing repeats between the primary and secondary lines. */
function remainingIdentityFields(entry: CourseEnrolment): PersonField[] {
  return identityFields(entry).slice(1)
}

/** `Joined: <how> — <when>` — always present, on both the active and the ended list. */
function joinedField(entry: CourseEnrolment): PersonField {
  return {
    label: 'Joined',
    value: `${SOURCE_LABELS[entry.source]} — ${new Date(entry.createdAt).toLocaleString()}`,
  }
}

/** `Ended: <when>` — rework round 1, must-fix 2: an ended row used to show only this and never how/when the person had joined in the first place; `secondaryFields` below always puts `joinedField` before this one. */
function endedField(entry: CourseEnrolment): PersonField {
  return {
    label: 'Ended',
    value:
      entry.endedAt !== null ? new Date(entry.endedAt).toLocaleString() : '',
  }
}

/** The secondary line's own fields, in order — whichever identifiers were not already the primary line, then how/when the person joined, then (only once ended) when that happened too. */
function secondaryFields(entry: CourseEnrolment): PersonField[] {
  const fields = [...remainingIdentityFields(entry), joinedField(entry)]
  if (entry.endedAt !== null) fields.push(endedField(entry))
  return fields
}

/**
 * WEB-36 (rework round 1, cheap fix): the one link both lists render — a
 * real `<a href>`, so it survives being copied, opened in a new tab, or
 * read by assistive technology, with an `onClick` that intercepts only a
 * genuine plain click and lets everything else (a modified click, a
 * right-click) fall through to the browser's own handling. `event.button`
 * is not checked here — React's synthetic `onClick` is derived from the
 * DOM `click` event, which the browser never fires for the middle button
 * at all (that is `auxclick`'s own event, unhandled here), so a `button`
 * check on this event is always `0` and was dead code (rework round 1,
 * cheap fix).
 */
function TranscriptLink({
  organizationId,
  courseId,
  personId,
  onNavigate,
  children,
}: {
  organizationId: string
  courseId: string
  personId: string
  onNavigate: (route: Route) => void
  children: string
}) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return
    }
    event.preventDefault()
    onNavigate({ kind: 'transcripts', organizationId, courseId, personId })
  }

  return (
    <a
      href={buildPath({
        kind: 'transcripts',
        organizationId,
        courseId,
        personId,
      })}
      onClick={handleClick}
      className="block text-sm font-medium text-neutral-900 underline-offset-2 hover:underline"
    >
      {children}
    </a>
  )
}

export function CoursePeople({
  organizationId,
  courseId,
  navigate,
}: CoursePeopleProps) {
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
  // WEB-16/WEB-36 — this file's own module comment on why the transcript
  // link routes through this rather than calling `navigate` bare.
  const { guardedNavigate } = useNavigationGuard()

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
      title: `End ${identifierText(entry)}'s enrolment?`,
      description:
        'This stops them asking this course. It does not delete their transcript or the course’s record of what was asked.',
      confirmLabel: 'End enrolment',
      destructive: true,
    })
    if (!confirmed) return

    setEndingId(entry.id)
    try {
      await endCourseEnrolment(organizationId, entry.id)
      setStatusMessage(`Ended ${identifierText(entry)}'s enrolment.`)
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
      setStatusMessage(`Reinstated ${identifierText(entry)}'s enrolment.`)
      await refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setReinstateError(caught)
      else throw caught
    } finally {
      setReinstatingId(undefined)
    }
  }

  // WEB-16/WEB-36 — every navigation this file starts (a click on
  // `TranscriptLink`, below) goes through the same registered guard the
  // rest of the shell already consults, so a dirty course form gets its
  // say before it loses anything (this file's own module comment).
  const handleNavigate = useCallback(
    (route: Route) => guardedNavigate(() => navigate(route)),
    [guardedNavigate, navigate]
  )

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
                  <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                    {primaryField(entry).label}
                  </p>
                  <TranscriptLink
                    organizationId={organizationId}
                    courseId={courseId}
                    personId={entry.personId}
                    onNavigate={handleNavigate}
                  >
                    {primaryField(entry).value}
                  </TranscriptLink>
                  <p className="text-sm text-neutral-500">
                    {secondaryFields(entry)
                      .map((field) => `${field.label}: ${field.value}`)
                      .join(' · ')}
                  </p>
                </div>
                <Button
                  variant="destructive"
                  aria-label={`End ${identifierText(entry)}'s enrolment`}
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
                  {/* WEB-36 — an ended enrolment links identically (this
                      file's own module comment on why: ending never
                      deletes the transcript, ENRL-6). */}
                  <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                    {primaryField(entry).label}
                  </p>
                  <TranscriptLink
                    organizationId={organizationId}
                    courseId={courseId}
                    personId={entry.personId}
                    onNavigate={handleNavigate}
                  >
                    {primaryField(entry).value}
                  </TranscriptLink>
                  <p className="text-sm text-neutral-500">
                    {secondaryFields(entry)
                      .map((field) => `${field.label}: ${field.value}`)
                      .join(' · ')}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  aria-label={`Reinstate ${identifierText(entry)}'s enrolment`}
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
