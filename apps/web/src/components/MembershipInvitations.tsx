/**
 * ENRL-10: the screen an owner uses to invite a colleague who is not yet in
 * the organization — the gap `components/Team.tsx`'s own module comment
 * names: `memberships.grant` can only ever change the role of someone
 * already present, so an owner had no way to add a genuinely new one.
 * `JoinLinks.tsx` is this component's own precedent, closely followed:
 * issuing, showing what is outstanding, and revoking one, over the same
 * "bearer secret, shown once, stored only as a hash" shape.
 *
 * **The secret is shown once, at creation, and never again** — the same
 * "this panel does not withhold it out of caution, it genuinely cannot
 * recover it" reasoning `JoinLinks.tsx`'s own module comment gives,
 * including the identical clipboard-failure handling (`handleCopy`, below)
 * that component's own rework finding added.
 *
 * **Owner-only, both to read and to write.** `membershipInvitations.list`
 * (unlike `memberships.list`) is itself restricted to an owner
 * (`@bloombot/actions`' `membership-invitations.ts`'s own doc comment on
 * why an outstanding invitation's own email carries a sensitivity a granted
 * role's row does not) — this component is mounted only inside `Team.tsx`'s
 * own `isOwner` block, the same "withholding the form only avoids offering
 * a click that would refuse" division `Team.tsx`'s own module comment
 * already draws for `memberships.grant`.
 */

import { useCallback, useEffect, useState } from 'react'

import {
  ApiError,
  createMembershipInvitation,
  listMembershipInvitations,
  revokeMembershipInvitation,
} from '../api/client.js'
import type {
  CreatedMembershipInvitation,
  MembershipInvitation,
} from '../api/types.js'
import { AddIcon, CopyIcon, DisableIcon, JoinLinkIcon } from '../icons.js'
import { Button } from './Button.js'
import { ErrorMessage } from './ErrorMessage.js'
import { FormField } from './FormField.js'
import { textInputClasses } from './fieldStyles.js'
import { useModal } from './modal/ModalProvider.js'

export interface MembershipInvitationsProps {
  organizationId: string
}

const ROLE_LABELS: Record<MembershipInvitation['role'], string> = {
  owner: 'Owner',
  instructor: 'Instructor',
  assistant: 'Assistant',
}

const INVITABLE_ROLES: MembershipInvitation['role'][] = [
  'instructor',
  'assistant',
  'owner',
]

/** The full address an invitee actually follows — `App.tsx`'s own `/invitations/:secret` route, joined with this browser's own origin, the same `joinUrl` shape `JoinLinks.tsx` already gives ENRL-3/4's own links. */
function invitationUrl(secret: string): string {
  return `${window.location.origin}/invitations/${secret}`
}

// WEB-23's own precedent, reused verbatim: a small set of relative
// durations rather than a raw datetime field — an owner inviting a
// colleague is thinking in weeks, not timestamps, and a picker invites the
// same past-value refusal `createInputSchema` (`membership-invitations.ts`)
// exists to catch.
const EXPIRY_OPTIONS: {
  value: string
  label: string
  durationMs: number | null
}[] = [
  { value: 'none', label: 'Never', durationMs: null },
  { value: '1d', label: '1 day', durationMs: 24 * 60 * 60 * 1000 },
  { value: '1w', label: '1 week', durationMs: 7 * 24 * 60 * 60 * 1000 },
  { value: '1mo', label: '1 month', durationMs: 30 * 24 * 60 * 60 * 1000 },
]

/**
 * One invitation's own status, in the order this screen checks it —
 * `redeemedAt` first: a redeemed invitation is single-use (ENRL-10), so it
 * has nothing left for `revokedAt`/`expiresAt` to say regardless of what
 * either column holds.
 */
function formatStatus(invitation: MembershipInvitation): string {
  if (invitation.redeemedAt) {
    return `Redeemed ${new Date(invitation.redeemedAt).toLocaleString()}`
  }
  if (invitation.revokedAt) {
    return `Revoked ${new Date(invitation.revokedAt).toLocaleString()}`
  }
  if (invitation.expiresAt === null) return 'No expiry'
  if (invitation.expiresAt <= Date.now()) {
    return `Expired ${new Date(invitation.expiresAt).toLocaleString()}`
  }
  return `Expires ${new Date(invitation.expiresAt).toLocaleString()}`
}

export function MembershipInvitations({
  organizationId,
}: MembershipInvitationsProps) {
  const [invitations, setInvitations] = useState<
    MembershipInvitation[] | undefined
  >(undefined)
  const [loadError, setLoadError] = useState<ApiError | undefined>(undefined)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<MembershipInvitation['role']>('instructor')
  const [expiryOption, setExpiryOption] = useState('none')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<ApiError | undefined>(
    undefined
  )
  // WEB-20's own precedent: the one invitation this screen has ever seen the
  // plaintext secret for, and only until the next reload — nothing here
  // persists it, and nothing could read it back even if something tried
  // (this file's own module comment).
  const [created, setCreated] = useState<
    CreatedMembershipInvitation | undefined
  >(undefined)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<ApiError | undefined>(undefined)
  const [revokingId, setRevokingId] = useState<string | undefined>(undefined)
  const [revokeError, setRevokeError] = useState<ApiError | undefined>(
    undefined
  )
  const { confirm } = useModal()

  const refresh = useCallback(
    () =>
      listMembershipInvitations(organizationId).then(
        (list) => {
          setInvitations(list)
          setLoadError(undefined)
        },
        (caught: unknown) => {
          if (caught instanceof ApiError) setLoadError(caught)
          else throw caught
        }
      ),
    [organizationId]
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleInvite = async () => {
    const trimmedEmail = email.trim()
    if (!trimmedEmail) return

    setInviteError(undefined)
    setCopied(false)
    // ENRL-10: the same consequence, stated before it happens, `Team.tsx`'s
    // own `handleGrant` already holds itself to for a granted role — an
    // invitation extends the identical authority once redeemed.
    const confirmed = await confirm({
      title: `Invite ${trimmedEmail} to the ${ROLE_LABELS[role]} role?`,
      description:
        'An instructor or an assistant can read every course transcript and chat history in this organization, and act as staff across it, once they redeem this invitation. The invitation itself grants nothing until then.',
      confirmLabel: 'Send invitation',
    })
    if (!confirmed) return

    setInviting(true)
    try {
      const durationMs = EXPIRY_OPTIONS.find(
        (option) => option.value === expiryOption
      )?.durationMs
      const result =
        durationMs == null
          ? await createMembershipInvitation(organizationId, trimmedEmail, role)
          : await createMembershipInvitation(
              organizationId,
              trimmedEmail,
              role,
              Date.now() + durationMs
            )
      setCreated(result)
      setEmail('')
      setRole('instructor')
      setExpiryOption('none')
      await refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setInviteError(caught)
      else throw caught
    } finally {
      setInviting(false)
    }
  }

  // `JoinLinks.tsx#handleCopy`'s own comment has the full mechanics —
  // `navigator.clipboard` is `undefined` on a non-secure origin, which
  // would otherwise throw before any promise exists to await.
  const handleCopy = async (secret: string) => {
    setCopyError(undefined)
    try {
      await navigator.clipboard.writeText(invitationUrl(secret))
      setCopied(true)
    } catch {
      setCopyError(new ApiError(0, { error: 'clipboard_unavailable' }))
    }
  }

  const handleRevoke = async (invitation: MembershipInvitation) => {
    setRevokeError(undefined)
    const confirmed = await confirm({
      title: 'Revoke this invitation?',
      description:
        'This stops it admitting anyone, ever again. It has no effect on any role already granted.',
      confirmLabel: 'Revoke',
      destructive: true,
    })
    if (!confirmed) return

    setRevokingId(invitation.id)
    try {
      await revokeMembershipInvitation(organizationId, invitation.id)
      await refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setRevokeError(caught)
      else throw caught
    } finally {
      setRevokingId(undefined)
    }
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-neutral-900">Invitations</h2>
        <ErrorMessage error={loadError} />
      </div>
    )
  }

  return (
    <section
      aria-label="Invite a colleague"
      className="flex flex-col gap-3"
      data-testid="membership-invitations"
    >
      <h2 className="text-lg font-semibold text-neutral-900">Invitations</h2>

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
              data-testid="created-invitation-url"
              className="break-all rounded bg-white px-2 py-1 text-neutral-900"
            >
              {invitationUrl(created.secret)}
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

      {invitations && invitations.length === 0 && !created && (
        <p className="text-sm text-neutral-500">No invitations issued yet.</p>
      )}

      {invitations && invitations.length > 0 && (
        <ul className="flex flex-col gap-2">
          {invitations.map((invitation) => {
            const stillLive =
              !invitation.revokedAt &&
              !invitation.redeemedAt &&
              (invitation.expiresAt === null ||
                invitation.expiresAt > Date.now())
            return (
              <li
                key={invitation.id}
                className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 p-3"
              >
                <div className="flex items-center gap-2">
                  <JoinLinkIcon
                    aria-hidden="true"
                    className="size-4 text-neutral-500"
                  />
                  <div>
                    <p className="text-sm font-medium text-neutral-900">
                      {invitation.email} — {ROLE_LABELS[invitation.role]}
                    </p>
                    <p className="text-sm text-neutral-500">
                      {formatStatus(invitation)}
                    </p>
                  </div>
                </div>
                {stillLive && (
                  <Button
                    variant="destructive"
                    aria-label={`Revoke invitation to ${invitation.email}`}
                    icon={<DisableIcon aria-hidden="true" className="size-4" />}
                    onClick={() => void handleRevoke(invitation)}
                    disabled={revokingId === invitation.id}
                  >
                    {revokingId === invitation.id ? 'Revoking…' : 'Revoke'}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {revokeError && <ErrorMessage error={revokeError} />}

      <div className="flex flex-wrap items-end gap-2">
        <div className="w-64">
          {/* "Invite email"/"Invite role", not "Email"/"Role" — `Team.tsx`'s
              own grant form (mounted in the same tree, above) already uses
              those exact labels, and this screen needs the two forms'
              controls to stay individually addressable, both for a screen
              reader and for `getByLabelText` in this component's own
              tests. */}
          <FormField label="Invite email">
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={textInputClasses}
            />
          </FormField>
        </div>
        <div className="w-40">
          <FormField label="Invite role">
            <select
              value={role}
              onChange={(event) =>
                setRole(event.target.value as MembershipInvitation['role'])
              }
              className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900 focus:border-brand-500"
            >
              {INVITABLE_ROLES.map((option) => (
                <option key={option} value={option}>
                  {ROLE_LABELS[option]}
                </option>
              ))}
            </select>
          </FormField>
        </div>
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
          variant="primary"
          icon={<AddIcon aria-hidden="true" className="size-4" />}
          onClick={() => void handleInvite()}
          disabled={inviting || email.trim() === ''}
        >
          {inviting ? 'Inviting…' : 'Invite'}
        </Button>
      </div>
      {inviteError && <ErrorMessage error={inviteError} />}
    </section>
  )
}
