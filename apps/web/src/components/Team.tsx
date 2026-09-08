/**
 * ENRL-5: the screen an owner's own staff roster was missing entirely.
 * `grantMembershipAction` (`@bloombot/actions`) has existed since TEN-1's own
 * slice, and `listMembershipsForOrganization` (`@bloombot/db`) since the
 * schema that first carried `grantedByAccountId`/`grantedAt` — but an audit
 * (`docs/ROADMAP.md`'s "Audit — surfaces that were never built") found
 * neither had a caller anywhere outside a test: an owner had no actual way
 * to add a second instructor or a teaching assistant, or to see who already
 * held a role. `api/client.ts#listMemberships`/`grantMembership` (this same
 * slice's own addition, over the new `memberships.list` action and the
 * existing `memberships.grant`) are what close that; this component is what
 * an owner actually sees.
 *
 * **Granting is owner-only; the list is not.** `isOwner` (a prop, computed
 * once in `pages/Shell.tsx` from the caller's own membership) decides
 * whether the grant form renders at all — the same `isOwner` shape
 * `pages/Usage.tsx` already takes for COST-3's cap form. The server's own
 * check (`memberships.grant`'s `execute`, restricted to an owner) is what
 * actually enforces this; withholding the form here only avoids offering a
 * click every attempt through which would refuse. The list itself has no
 * such gate — any member may read who already holds a role
 * (`memberships.list`'s own description) — so it always renders once loaded,
 * regardless of `isOwner`.
 *
 * **Identifying a holder, and identifying a grant target, pull in opposite
 * directions — and this screen resolves them differently on purpose.** The
 * *list* never shows an email: `displayName` is what identifies a row
 * (`components/CoursePeople.tsx#label`'s own "no genuine need to
 * disambiguate by it" precedent) — unlike a student's own, an account's
 * `displayName` is never `null` (`schema.ts`), so there is not even a
 * fallback case that would need one. But *granting* a role to someone who is
 * not already visible in that list needs a way to name them, and the one
 * thing an owner actually has to hand for somebody they have not yet added
 * is their email address — `grantMembershipAction`'s own input has always
 * been keyed on `email`, not an account id this screen has no way to look
 * up. The email typed into the grant form is never displayed back on this
 * screen once submitted — it is sent once, to identify the target, and
 * dropped from state on success (`handleGrant`, below) — so this screen
 * still never *shows* anybody's email, even though it has to *ask* for one.
 *
 * **The consequence is said at the moment of granting, not only in a help
 * string.** A role here is real authority — an instructor or an assistant
 * can read every course transcript and chat history in the organization,
 * the same access `docs/SPEC.md`'s own ENRL-5 text opens with — so
 * `handleGrant` confirms before sending, stating that plainly, the same
 * "say the consequence before it happens" discipline
 * `components/CoursePeople.tsx#handleEnd`/`components/JoinLinks.tsx#handleRevoke`
 * already hold themselves to for their own destructive acts. Unlike either
 * of those, this is not marked `destructive` in the modal — granting adds
 * authority rather than removing access — but the description still says
 * exactly what that authority is before an owner confirms.
 *
 * **ENRL-10 — the grant form's own limit, closed.** `grantMembershipAction`
 * requires the target account to already hold a membership in this
 * organization (its own doc comment's "rework finding 1"), so this screen
 * could only ever reassign roles among people already present — the "Must
 * already belong to this organization" help text on the email field, above,
 * says so. `components/MembershipInvitations.tsx`, mounted below, owner-
 * gated the identical way, is what actually lets an owner bring a
 * genuinely new colleague onto their staff: an invitation, not a grant.
 *
 * **ENRL-11 — revoking, and why a row's own control depends on whose row it
 * is.** `revokeMembershipAction`'s own decision (`@bloombot/actions`'
 * `actions/memberships.ts`, its own module comment has the reasoning): an
 * owner's own membership is only ever revoked by that owner stepping down
 * themselves, never by a peer — and the organization's last owner can never
 * be revoked at all, enforced in the repo, below any screen. This component
 * mirrors both, rather than offering a control the server would always
 * refuse: a peer owner's row carries no control whatsoever (the server
 * would refuse every attempt identically, so offering one would only ever
 * teach a caller to expect a refusal); the viewer's *own* row, when it is
 * `'owner'`, offers "Step down" — enabled, unless `entries` shows exactly
 * one active owner, in which case it renders disabled with the reason
 * stated, the same "explain, don't just hide" instruction WEB-23's own
 * expiry control already follows for a different reason. A non-owner row
 * (instructor, assistant) carries an ordinary "Revoke" any owner may use,
 * on anyone, including the viewer's own — the peer-owner restriction is
 * specific to the `'owner'` role, not to acting on another row generally.
 * **The count `entries` itself gives is enough** — no separate request:
 * `listMembershipsAction` already returns every *active* membership
 * (`repos/memberships.ts#listMembershipsForOrganization`'s own doc
 * comment), so counting `role === 'owner'` rows in the list this screen
 * already fetched is the same count the repo's own last-owner guard uses.
 * This is what decides what the button *offers*, not what makes revoking
 * safe — `revokeMembership`'s own repo-level guard (`docs/DECISIONS.md`
 * D-70) is the actual enforcement, the same "the screen explains, the write
 * decides" split ENRL-11's own SPEC text requires.
 *
 * Revoking confirms, and says both halves of what it does — the same
 * "say the consequence before it happens" discipline this file's own grant
 * confirmation, and `components/JoinLinks.tsx#handleRevoke`, already hold
 * themselves to: it stops the holder's staff access; it deletes no
 * transcript and ends no enrolment (ENRL-11, mirroring TEN-6/ENRL-6 for the
 * identical reason).
 */

import { useCallback, useEffect, useState } from 'react'

import {
  ApiError,
  grantMembership,
  listMemberships,
  revokeMembership,
} from '../api/client.js'
import type { OrganizationMembership } from '../api/types.js'
import { AddIcon, DisableIcon } from '../icons.js'
import { Button } from './Button.js'
import { ErrorMessage } from './ErrorMessage.js'
import { FormField } from './FormField.js'
import { textInputClasses } from './fieldStyles.js'
import { MembershipInvitations } from './MembershipInvitations.js'
import { useModal } from './modal/ModalProvider.js'

export interface TeamProps {
  organizationId: string
  /** Whether the caller's own membership in this organization is `'owner'` — see this file's own module comment for why the grant form is withheld rather than merely disabled for anyone else. */
  isOwner: boolean
  /** The caller's own account id (ENRL-11) — tells the viewer's own roster row apart from a peer's, which is what decides whether a revoke control is offered at all for an `'owner'` row (this file's own module comment). */
  viewerAccountId: string
}

const ROLE_LABELS: Record<OrganizationMembership['role'], string> = {
  owner: 'Owner',
  instructor: 'Instructor',
  assistant: 'Assistant',
}

const GRANTABLE_ROLES: OrganizationMembership['role'][] = [
  'instructor',
  'assistant',
  'owner',
]

export function Team({ organizationId, isOwner, viewerAccountId }: TeamProps) {
  const [entries, setEntries] = useState<OrganizationMembership[] | undefined>(
    undefined
  )
  const [loadError, setLoadError] = useState<ApiError | undefined>(undefined)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OrganizationMembership['role']>('instructor')
  const [granting, setGranting] = useState(false)
  const [grantError, setGrantError] = useState<ApiError | undefined>(undefined)
  // ENRL-11 — which row's revoke is in flight, and its own error, the same
  // `revokingId`/`revokeError` shape `components/JoinLinks.tsx#handleRevoke`
  // already uses for the identical "one row at a time" async need.
  const [revokingId, setRevokingId] = useState<string | undefined>(undefined)
  const [revokeError, setRevokeError] = useState<ApiError | undefined>(
    undefined
  )
  // A live region for the one thing a screen reader cannot otherwise learn
  // from this screen's own re-render: a new row appearing in the list below
  // once a grant succeeds. Cleared on every new attempt so a stale
  // announcement never lingers alongside a fresh error — the same
  // `statusMessage` shape `pages/Usage.tsx`/`components/CoursePeople.tsx`
  // both already use for this identical async-status need.
  const [statusMessage, setStatusMessage] = useState<string | undefined>(
    undefined
  )
  const { confirm } = useModal()

  const refresh = useCallback(
    () =>
      listMemberships(organizationId).then(
        (list) => {
          setEntries(list)
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

  const handleGrant = async () => {
    const trimmedEmail = email.trim()
    if (!trimmedEmail) return

    setGrantError(undefined)
    setStatusMessage(undefined)
    // ENRL-5: the consequence, stated plainly, before anything happens — see
    // this file's own module comment on why this is not marked destructive.
    const confirmed = await confirm({
      title: `Grant ${trimmedEmail} the ${ROLE_LABELS[role]} role?`,
      description:
        'An instructor or an assistant can read every course transcript and chat history in this organization, and act as staff across it. This takes effect immediately.',
      confirmLabel: 'Grant role',
    })
    if (!confirmed) return

    setGranting(true)
    try {
      await grantMembership(organizationId, trimmedEmail, role)
      setStatusMessage(`Granted ${trimmedEmail} the ${ROLE_LABELS[role]} role.`)
      setEmail('')
      setRole('instructor')
      await refresh()
    } catch (caught) {
      if (caught instanceof ApiError) setGrantError(caught)
      else throw caught
    } finally {
      setGranting(false)
    }
  }

  // ENRL-11 — how many active owners `entries` itself shows right now; this
  // file's own module comment on why counting the list already fetched is
  // enough to decide what the button *offers*, without a separate request.
  const ownerCount =
    entries?.filter((entry) => entry.role === 'owner').length ?? 0

  const handleRevoke = async (entry: OrganizationMembership) => {
    setRevokeError(undefined)
    setStatusMessage(undefined)
    const isSelf = entry.accountId === viewerAccountId
    // ENRL-11: both halves, stated plainly, before anything happens — the
    // same discipline `handleGrant`, above, and `JoinLinks.tsx#handleRevoke`
    // already hold themselves to.
    const confirmed = await confirm({
      title: isSelf
        ? `Step down as ${ROLE_LABELS[entry.role]}?`
        : `Revoke ${entry.displayName}'s ${ROLE_LABELS[entry.role]} role?`,
      description:
        'This stops their staff access to this organization. It deletes no transcript and ends no enrolment.',
      confirmLabel: isSelf ? 'Step down' : 'Revoke',
      destructive: true,
    })
    if (!confirmed) return

    setRevokingId(entry.accountId)
    try {
      await revokeMembership(organizationId, entry.accountId)
      setStatusMessage(
        isSelf
          ? 'You have stepped down.'
          : `Revoked ${entry.displayName}'s role.`
      )
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
      <div className="flex flex-col gap-4">
        <h1 className="text-page-title font-semibold text-neutral-900">Team</h1>
        <ErrorMessage error={loadError} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6" data-testid="team-panel">
      <h1 className="text-page-title font-semibold text-neutral-900">Team</h1>

      <p role="status" className="sr-only">
        {statusMessage}
      </p>

      <section aria-label="Who holds a role" className="flex flex-col gap-2">
        {entries && entries.length === 0 && (
          <p className="text-sm text-neutral-500">
            Nobody holds a role in this organization yet.
          </p>
        )}
        {entries && entries.length > 0 && (
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => {
              const isSelf = entry.accountId === viewerAccountId
              // ENRL-11: an owner's own row is revocable only by that owner,
              // stepping down — never a peer's — and the organization's last
              // owner cannot step down either; a peer's `'owner'` row
              // carries no control at all, this file's own module comment
              // has why. A non-owner row (instructor, assistant) is always
              // revocable by the viewer, whoever it belongs to.
              const showRevoke = isOwner && (entry.role !== 'owner' || isSelf)
              const isLastOwner = entry.role === 'owner' && ownerCount <= 1
              return (
                <li
                  key={entry.accountId}
                  className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 p-3"
                >
                  <div>
                    <p className="text-sm font-medium text-neutral-900">
                      {entry.displayName} — {ROLE_LABELS[entry.role]}
                    </p>
                    <p className="text-sm text-neutral-500">
                      {entry.grantedByDisplayName && entry.grantedAt !== null
                        ? `Granted by ${entry.grantedByDisplayName} — ${new Date(entry.grantedAt).toLocaleString()}`
                        : `Member since ${new Date(entry.createdAt).toLocaleString()}`}
                    </p>
                    {showRevoke && isLastOwner && (
                      <p className="text-sm text-neutral-500">
                        You are this organization&rsquo;s only owner — promote
                        another member before stepping down.
                      </p>
                    )}
                  </div>
                  {showRevoke && (
                    <Button
                      variant="destructive"
                      aria-label={
                        isSelf
                          ? `Step down as ${ROLE_LABELS[entry.role]}`
                          : `Revoke ${entry.displayName}'s ${ROLE_LABELS[entry.role]} role`
                      }
                      icon={
                        <DisableIcon aria-hidden="true" className="size-4" />
                      }
                      onClick={() => void handleRevoke(entry)}
                      disabled={revokingId === entry.accountId || isLastOwner}
                    >
                      {revokingId === entry.accountId
                        ? 'Revoking…'
                        : isSelf
                          ? 'Step down'
                          : 'Revoke'}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {revokeError && <ErrorMessage error={revokeError} />}
      </section>

      {isOwner && (
        <section
          aria-label="Grant a role"
          className="flex flex-col gap-3 border-t border-neutral-200 pt-4"
        >
          <h2 className="text-lg font-semibold text-neutral-900">
            Grant a role
          </h2>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-64">
              <FormField
                label="Email"
                help="Must already belong to this organization — to add someone who is not yet a member, use Invitations below."
              >
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className={textInputClasses}
                />
              </FormField>
            </div>
            <div className="w-40">
              <FormField label="Role">
                <select
                  value={role}
                  onChange={(event) =>
                    setRole(
                      event.target.value as OrganizationMembership['role']
                    )
                  }
                  className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900 focus:border-brand-500"
                >
                  {GRANTABLE_ROLES.map((option) => (
                    <option key={option} value={option}>
                      {ROLE_LABELS[option]}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
            <Button
              variant="primary"
              icon={<AddIcon aria-hidden="true" className="size-4" />}
              onClick={() => void handleGrant()}
              disabled={granting || email.trim() === ''}
            >
              {granting ? 'Granting…' : 'Grant role'}
            </Button>
          </div>
          {grantError && <ErrorMessage error={grantError} />}
        </section>
      )}

      {/* ENRL-10 — the gap the section above cannot close: `memberships.grant`
          only ever changes the role of someone already present
          (`MembershipInvitations.tsx`'s own module comment). Owner-gated
          the same way, and for the identical reason. */}
      {isOwner && (
        <div className="border-t border-neutral-200 pt-4">
          <MembershipInvitations organizationId={organizationId} />
        </div>
      )}
    </div>
  )
}
