/**
 * WEB-20: the screen a course's join links were missing entirely — ENRL-3
 * and ENRL-4 already give a course shareable, revocable, optionally
 * expiring links, and `courseJoinLinks.create`/`.list`/`.revoke` (the last
 * two this same slice's own addition) already exist, but nothing before
 * this component ever offered any of it in the panel: the one way to admit
 * a student who is not already carrying a Discord role did not exist in
 * practice.
 *
 * **The secret is shown once, at creation, and never again.** The database
 * only ever stores its SHA-256 hash (`repos/course-join-links.ts`'s own
 * module comment) — this panel does not withhold the secret out of caution,
 * it genuinely cannot recover it after this screen's own `created` state is
 * gone (a reload, navigating away). That is stated plainly in the banner
 * below, at the moment it matters, rather than left for an instructor to
 * discover the hard way by coming back later and finding nothing.
 *
 * **Revoking confirms, and the confirmation says both halves of ENRL-4**:
 * it stops the link admitting anyone new, and it does not un-enrol anybody
 * who already redeemed it — the same "say what it does and does not do"
 * discipline `CourseAttachments.tsx`'s own detach confirmation already
 * holds itself to for FILE-3.
 *
 * **A failed copy is reported, not swallowed** (rework finding, cheap-fix):
 * `handleCopy`'s own comment has the mechanics — `navigator.clipboard` is
 * `undefined` on a non-secure origin, which threw before this was caught,
 * as an unhandled rejection with no visible change to the "Copy link"
 * label. The URL stays on screen regardless (`created` is never cleared by
 * a copy attempt), so a failed copy always leaves the secret still
 * copyable by hand.
 *
 * **WEB-23: an expiry is chosen at issue, not left to default forever.**
 * `createCourseJoinLink`/`courseJoinLinks.create` have always accepted an
 * `expiresAt`, but nothing before this offered it, so every link this
 * panel issued was permanent and `formatExpiry` below could only ever print
 * "No expiry" for one. The control is a small set of relative durations
 * (`EXPIRY_OPTIONS`), not a raw datetime field: an instructor issuing a
 * link for a term is thinking in weeks, not timestamps, and a picker
 * invites exactly the past-value refusal `createInputSchema` exists to
 * catch (`packages/actions/src/actions/course-join-links.ts`'s own comment
 * on why). The chosen duration is only ever added to `Date.now()` at the
 * moment `handleCreate` actually sends the request — never at the moment
 * the option was selected — so an instructor who pauses between choosing
 * and clicking never has the request's own value fall behind.
 *
 * **ENRL-12: a live link's secret can be shown again, per row, not only at
 * creation.** `handleReveal` calls `revealCourseJoinLink`
 * (`courseJoinLinks.reveal`) and keeps at most one revealed secret in
 * memory at a time (`revealed`), the same "never stored past the moment it
 * is needed" discipline `created` above already holds itself to — revealing
 * a different link replaces it outright, and an explicit "Hide" control
 * lets an instructor clear it from screen without navigating away or
 * waiting for a reload. A row offers the control at all only when both
 * `isLiveForReveal` (not revoked, not expired — the same two refusals
 * `courseJoinLinks.reveal` itself gives, checked here so this screen never
 * offers a control certain to fail) and `link.revealable` (WEB-20's own
 * projection, `CourseJoinLinkSummary`) hold; a live but non-revealable link
 * — created before ENRL-12 shipped, or while no encryption key was
 * configured — gets a plain sentence explaining why in terms an instructor
 * reads as an explanation, not an error, rather than a control that can
 * only refuse. Copying a revealed secret is its own small copy handler
 * (`handleCopyRevealed`), deliberately not `handleCopy` above: sharing one
 * `copied`/`copyError` pair between the creation banner and a revealed row
 * would flip both labels to "Copied!" (or both to a failure) on a single
 * click in whichever one a caller actually used, which is wrong whenever
 * both are on screen at once.
 */

import { useCallback, useEffect, useState } from 'react'

import {
  ApiError,
  createCourseJoinLink,
  listCourseJoinLinks,
  revealCourseJoinLink,
  revokeCourseJoinLink,
} from '../api/client.js'
import type {
  CourseJoinLinkSummary,
  CreatedCourseJoinLink,
  RevealedCourseJoinLink,
} from '../api/types.js'
import {
  AddIcon,
  CopyIcon,
  DisableIcon,
  JoinLinkIcon,
  RevealIcon,
} from '../icons.js'
import { Button } from './Button.js'
import { ErrorMessage } from './ErrorMessage.js'
import { FormField } from './FormField.js'
import { useModal } from './modal/ModalProvider.js'

export interface JoinLinksProps {
  organizationId: string
  courseId: string
}

/** The full address a student actually follows — `App.tsx`'s own `/join/:secret` route, joined with this browser's own origin so the copied text is a real, absolute URL rather than a path an instructor would have to know to prefix. */
function joinUrl(secret: string): string {
  return `${window.location.origin}/join/${secret}`
}

// WEB-23: the durations this panel offers, in place of a raw datetime field
// — see the module comment above for why. `durationMs: null` is "no
// expiry", the default and today's unchanged behaviour; every other value
// is added to `Date.now()` at send time, never stored as an absolute
// timestamp before then.
const EXPIRY_OPTIONS: {
  value: string
  label: string
  durationMs: number | null
}[] = [
  { value: 'none', label: 'Never', durationMs: null },
  { value: '1d', label: '1 day', durationMs: 24 * 60 * 60 * 1000 },
  { value: '1w', label: '1 week', durationMs: 7 * 24 * 60 * 60 * 1000 },
  { value: '1mo', label: '1 month', durationMs: 30 * 24 * 60 * 60 * 1000 },
  {
    value: '1term',
    label: '1 term (16 weeks)',
    durationMs: 16 * 7 * 24 * 60 * 60 * 1000,
  },
]

/** A link this panel has never seen redeemed against is still either "not yet due" or "past due" — `revokedAt` is a distinct, instructor-caused state from an expiry the clock alone produced, so the two must never read the same way (WEB-23). */
function formatExpiry(link: CourseJoinLinkSummary): string {
  if (link.revokedAt)
    return `Revoked ${new Date(link.revokedAt).toLocaleString()}`
  if (link.expiresAt === null) return 'No expiry'
  if (link.expiresAt <= Date.now())
    return `Expired ${new Date(link.expiresAt).toLocaleString()}`
  return `Expires ${new Date(link.expiresAt).toLocaleString()}`
}

/**
 * ENRL-12 — the same two refusals `courseJoinLinks.reveal` itself gives
 * (revoked, or expired), checked here so this panel never renders a reveal
 * control that is certain to fail. Deliberately distinct from the revoke
 * button's own gate (`!link.revokedAt` alone, below) — an already-expired,
 * never-revoked link still offers "Revoke" (WEB-23's own test), but reveal
 * refuses it too, so this helper checks both.
 */
function isLiveForReveal(link: CourseJoinLinkSummary): boolean {
  return (
    !link.revokedAt && (link.expiresAt === null || link.expiresAt > Date.now())
  )
}

export function JoinLinks({ organizationId, courseId }: JoinLinksProps) {
  const [links, setLinks] = useState<CourseJoinLinkSummary[] | undefined>(
    undefined
  )
  const [loadError, setLoadError] = useState<ApiError | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<ApiError | undefined>(
    undefined
  )
  // WEB-20: the one link this screen has ever seen the plaintext secret
  // for, and only until the next reload — nothing here persists it, and
  // nothing could read it back even if something tried (this file's own
  // module comment).
  const [created, setCreated] = useState<CreatedCourseJoinLink | undefined>(
    undefined
  )
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<ApiError | undefined>(undefined)
  const [revokingId, setRevokingId] = useState<string | undefined>(undefined)
  const [revokeError, setRevokeError] = useState<ApiError | undefined>(
    undefined
  )
  // ENRL-12 — the one link this screen has ever seen a *re*-revealed secret
  // for, and only until the next reveal, an explicit hide, or this
  // component unmounts — the same "never persisted, nothing could read it
  // back" property `created` above already has (this file's own module
  // comment). `revealingId` mirrors `revokingId`'s own per-row in-flight
  // marker; `revealCopied`/`revealCopyError` are deliberately their own
  // state, not shared with `copied`/`copyError` above (this file's own
  // module comment on why sharing would cross-talk).
  const [revealed, setRevealed] = useState<
    { linkId: string; secret: string } | undefined
  >(undefined)
  const [revealingId, setRevealingId] = useState<string | undefined>(undefined)
  const [revealError, setRevealError] = useState<ApiError | undefined>(
    undefined
  )
  const [revealCopied, setRevealCopied] = useState(false)
  const [revealCopyError, setRevealCopyError] = useState<ApiError | undefined>(
    undefined
  )
  // WEB-23: which `EXPIRY_OPTIONS` entry is selected for the *next* link —
  // `'none'` (no expiry) is the default, so an instructor who never touches
  // this control gets exactly today's behaviour.
  const [expiryOption, setExpiryOption] = useState('none')
  const { confirm } = useModal()

  const refresh = useCallback(
    () =>
      listCourseJoinLinks(organizationId, courseId).then(
        (list) => {
          setLinks(list)
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

  const handleCreate = async () => {
    setCreateError(undefined)
    setCopied(false)
    setCreating(true)
    try {
      // WEB-23: the chosen duration is added to `Date.now()` right here, at
      // send time, never earlier — this file's own module comment has the
      // reasoning. `durationMs: null` (the default, "Never") sends no third
      // argument at all, matching `createCourseJoinLink`'s own "omitted
      // means no expiry" and leaving today's behaviour exactly unchanged.
      const durationMs = EXPIRY_OPTIONS.find(
        (option) => option.value === expiryOption
      )?.durationMs
      const result =
        durationMs == null
          ? await createCourseJoinLink(organizationId, courseId)
          : await createCourseJoinLink(
              organizationId,
              courseId,
              Date.now() + durationMs
            )
      setCreated(result)
      setExpiryOption('none')
      await refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setCreateError(caught)
      else throw caught
    } finally {
      setCreating(false)
    }
  }

  // WEB-20: `navigator.clipboard` is `undefined` on a non-secure origin (an
  // `http://` LAN or staging host without TLS) — reading `.writeText` off
  // it throws a `TypeError` before any promise even exists to await, which
  // an un-guarded `await` would otherwise leave as an unhandled rejection
  // with the label stuck on "Copy link" and no signal at all. This is the
  // one control the requirement names, for the one value that is never
  // recoverable once lost, so a failure here is reported the same visible
  // way every other refusal in this app already is — and the URL itself
  // stays on screen either way, still copyable by hand.
  const handleCopy = async (secret: string) => {
    setCopyError(undefined)
    try {
      await navigator.clipboard.writeText(joinUrl(secret))
      setCopied(true)
    } catch {
      setCopyError(new ApiError(0, { error: 'clipboard_unavailable' }))
    }
  }

  const handleRevoke = async (link: CourseJoinLinkSummary) => {
    setRevokeError(undefined)
    // ENRL-4: both halves, stated plainly, before anything happens.
    const confirmed = await confirm({
      title: 'Revoke this join link?',
      description:
        'This stops the link admitting anyone new. It does not un-enrol anybody who already joined through it.',
      confirmLabel: 'Revoke',
      destructive: true,
    })
    if (!confirmed) return

    setRevokingId(link.id)
    try {
      await revokeCourseJoinLink(organizationId, link.id)
      // ENRL-12: nothing left to reveal again for a link this instructor
      // just revoked — clears an already-open reveal panel for it rather
      // than leaving a now-stale secret on screen after the refresh below
      // updates its row.
      if (revealed?.linkId === link.id) setRevealed(undefined)
      await refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setRevokeError(caught)
      else throw caught
    } finally {
      setRevokingId(undefined)
    }
  }

  // ENRL-12: show a live link's secret again — refuses (an ordinary
  // `ApiError`) for anything `isLiveForReveal`/`link.revealable` (below)
  // already exists to keep this screen from attempting in the first place;
  // reaching this handler at all means either state, so a refusal here is
  // still reported the same visible way every other one in this app is.
  const handleReveal = async (link: CourseJoinLinkSummary) => {
    setRevealError(undefined)
    setRevealCopied(false)
    setRevealCopyError(undefined)
    setRevealingId(link.id)
    try {
      const result: RevealedCourseJoinLink = await revealCourseJoinLink(
        organizationId,
        link.id
      )
      // At most one revealed secret in memory at a time — revealing a
      // different link replaces whichever was showing, the same "never
      // stored past the moment it is needed" property `created` above
      // already has.
      setRevealed({ linkId: link.id, secret: result.secret })
    } catch (caught) {
      if (caught instanceof ApiError) setRevealError(caught)
      else throw caught
    } finally {
      setRevealingId(undefined)
    }
  }

  // ENRL-12: an instructor's own explicit "done looking" — clears the
  // revealed secret from this component's state (and so from the DOM, the
  // only place it was ever written) without waiting for a reveal of a
  // different link, a refresh, or a reload to do it implicitly.
  const handleHideRevealed = () => {
    setRevealed(undefined)
    setRevealCopied(false)
    setRevealCopyError(undefined)
    setRevealError(undefined)
  }

  // The same `navigator.clipboard`-may-be-`undefined` handling `handleCopy`
  // above gives the creation banner's own secret (that function's own
  // comment has the mechanics) — kept separate rather than shared so a copy
  // of a revealed secret never flips the creation banner's own "Copy link"
  // label, or vice versa, when both happen to be on screen at once (this
  // file's own module comment).
  const handleCopyRevealed = async (secret: string) => {
    setRevealCopyError(undefined)
    try {
      await navigator.clipboard.writeText(joinUrl(secret))
      setRevealCopied(true)
    } catch {
      setRevealCopyError(new ApiError(0, { error: 'clipboard_unavailable' }))
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="join-links">
      {loadError && <ErrorMessage error={loadError} />}

      {created && (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-md border border-warning-600 bg-warning-50 p-3 text-sm text-warning-700"
        >
          <p className="font-medium">
            Copy this link now — it is shown only this once. Bloombot stores
            only a hash of it and cannot show it to you again.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code
              data-testid="created-join-link-url"
              className="break-all rounded bg-white px-2 py-1 text-neutral-900"
            >
              {joinUrl(created.secret)}
            </code>
            <Button
              variant="secondary"
              icon={<CopyIcon aria-hidden="true" className="size-4" />}
              onClick={() => void handleCopy(created.secret)}
            >
              {copied ? 'Copied!' : 'Copy link'}
            </Button>
          </div>
          {copyError && <ErrorMessage error={copyError} />}
        </div>
      )}

      {links && links.length === 0 && !created && (
        <p className="text-sm text-neutral-500">No join links issued yet.</p>
      )}

      {links && links.length > 0 && (
        <ul className="flex flex-col gap-2">
          {links.map((link) => {
            const createdLabel = new Date(link.createdAt).toLocaleString()
            const live = isLiveForReveal(link)
            const isRevealedHere = revealed?.linkId === link.id
            return (
              <li
                key={link.id}
                className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <JoinLinkIcon
                      aria-hidden="true"
                      className="size-4 text-neutral-500"
                    />
                    <div>
                      <p className="text-sm font-medium text-neutral-900">
                        Created {createdLabel}
                      </p>
                      <p className="text-sm text-neutral-500">
                        {formatExpiry(link)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {/* ENRL-12: only when reaching `courseJoinLinks.reveal`
                        could plausibly succeed — never a control certain to
                        fail (this file's own module comment) — and only
                        while its own panel is not already open below. */}
                    {live && link.revealable && !isRevealedHere && (
                      <Button
                        variant="secondary"
                        aria-label={`Show join link secret created ${createdLabel}`}
                        icon={
                          <RevealIcon aria-hidden="true" className="size-4" />
                        }
                        onClick={() => void handleReveal(link)}
                        disabled={revealingId === link.id}
                      >
                        {revealingId === link.id ? 'Showing…' : 'Show secret'}
                      </Button>
                    )}
                    {!link.revokedAt && (
                      <Button
                        variant="destructive"
                        aria-label={`Revoke join link created ${createdLabel}`}
                        icon={
                          <DisableIcon aria-hidden="true" className="size-4" />
                        }
                        onClick={() => void handleRevoke(link)}
                        disabled={revokingId === link.id}
                      >
                        {revokingId === link.id ? 'Revoking…' : 'Revoke'}
                      </Button>
                    )}
                  </div>
                </div>

                {/* ENRL-12: a live link with nothing encrypted to show —
                    created before this shipped, or while no encryption key
                    was configured — reads as an explanation, not an error;
                    a revoked or expired link needs none, since
                    `formatExpiry` above already says why. */}
                {live && !link.revealable && (
                  <p className="text-xs text-neutral-500">
                    Bloombot didn&apos;t keep a recoverable copy of this
                    link&apos;s secret, so it can&apos;t be shown again. Revoke
                    it and create a new one if students still need a link.
                  </p>
                )}

                {isRevealedHere && revealed && (
                  <div
                    role="status"
                    className="flex flex-col gap-2 rounded-md border border-warning-600 bg-warning-50 p-3 text-sm text-warning-700"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <code
                        data-testid="revealed-join-link-url"
                        className="break-all rounded bg-white px-2 py-1 text-neutral-900"
                      >
                        {joinUrl(revealed.secret)}
                      </code>
                      <Button
                        variant="secondary"
                        icon={
                          <CopyIcon aria-hidden="true" className="size-4" />
                        }
                        onClick={() => void handleCopyRevealed(revealed.secret)}
                      >
                        {revealCopied ? 'Copied!' : 'Copy link'}
                      </Button>
                      <Button variant="ghost" onClick={handleHideRevealed}>
                        Hide
                      </Button>
                    </div>
                    {revealCopyError && (
                      <ErrorMessage error={revealCopyError} />
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {revealError && <ErrorMessage error={revealError} />}

      {revokeError && <ErrorMessage error={revokeError} />}

      <div className="flex flex-wrap items-end gap-2">
        {/* WEB-23: "Never" (no expiry) is the default option, so this
            control offers an expiry without an instructor having to
            dismiss anything to get today's behaviour by leaving it
            alone. */}
        <div className="w-40">
          <FormField label="Expiry">
            <select
              value={expiryOption}
              onChange={(event) => setExpiryOption(event.target.value)}
              className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900 focus:border-brand-500"
            >
              {EXPIRY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <Button
          variant="secondary"
          icon={<AddIcon aria-hidden="true" className="size-4" />}
          onClick={() => void handleCreate()}
          disabled={creating}
        >
          {creating ? 'Creating…' : 'Create join link'}
        </Button>
      </div>
      {createError && <ErrorMessage error={createError} />}
    </div>
  )
}
