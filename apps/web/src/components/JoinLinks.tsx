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
 */

import { useCallback, useEffect, useState } from 'react'

import {
  ApiError,
  createCourseJoinLink,
  listCourseJoinLinks,
  revokeCourseJoinLink,
} from '../api/client.js'
import type {
  CourseJoinLinkSummary,
  CreatedCourseJoinLink,
} from '../api/types.js'
import { AddIcon, CopyIcon, DisableIcon, JoinLinkIcon } from '../icons.js'
import { Button } from './Button.js'
import { ErrorMessage } from './ErrorMessage.js'
import { useModal } from './modal/ModalProvider.js'

export interface JoinLinksProps {
  organizationId: string
  courseId: string
}

/** The full address a student actually follows — `App.tsx`'s own `/join/:secret` route, joined with this browser's own origin so the copied text is a real, absolute URL rather than a path an instructor would have to know to prefix. */
function joinUrl(secret: string): string {
  return `${window.location.origin}/join/${secret}`
}

function formatExpiry(link: CourseJoinLinkSummary): string {
  if (link.revokedAt)
    return `Revoked ${new Date(link.revokedAt).toLocaleString()}`
  if (link.expiresAt === null) return 'No expiry'
  return `Expires ${new Date(link.expiresAt).toLocaleString()}`
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
  const [revokingId, setRevokingId] = useState<string | undefined>(undefined)
  const [revokeError, setRevokeError] = useState<ApiError | undefined>(
    undefined
  )
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
      const result = await createCourseJoinLink(organizationId, courseId)
      setCreated(result)
      await refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setCreateError(caught)
      else throw caught
    } finally {
      setCreating(false)
    }
  }

  const handleCopy = async (secret: string) => {
    await navigator.clipboard.writeText(joinUrl(secret))
    setCopied(true)
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
      await refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setRevokeError(caught)
      else throw caught
    } finally {
      setRevokingId(undefined)
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
        </div>
      )}

      {links && links.length === 0 && !created && (
        <p className="text-sm text-neutral-500">No join links issued yet.</p>
      )}

      {links && links.length > 0 && (
        <ul className="flex flex-col gap-2">
          {links.map((link) => (
            <li
              key={link.id}
              className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 p-3"
            >
              <div className="flex items-center gap-2">
                <JoinLinkIcon
                  aria-hidden="true"
                  className="size-4 text-neutral-500"
                />
                <div>
                  <p className="text-sm font-medium text-neutral-900">
                    Created {new Date(link.createdAt).toLocaleString()}
                  </p>
                  <p className="text-sm text-neutral-500">
                    {formatExpiry(link)}
                  </p>
                </div>
              </div>
              {!link.revokedAt && (
                <Button
                  variant="destructive"
                  aria-label={`Revoke join link created ${new Date(link.createdAt).toLocaleString()}`}
                  icon={<DisableIcon aria-hidden="true" className="size-4" />}
                  onClick={() => void handleRevoke(link)}
                  disabled={revokingId === link.id}
                >
                  {revokingId === link.id ? 'Revoking…' : 'Revoke'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {revokeError && <ErrorMessage error={revokeError} />}

      <div>
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
