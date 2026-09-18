/**
 * WEB-52's own "who is this" rule, applied to a message's own heading
 * (WEB-65) — shared by `components/TranscriptBrowser.tsx` and
 * `components/ChatMessage.tsx` (through `pages/Chat.tsx`), the same
 * "one shared function, not a second copy drifting out of sync" reasoning
 * `surface-label.ts`'s own module comment already gives for COST-7's
 * surface vocabulary.
 *
 * In priority order: a full name (first and last, joined by a space, or
 * whichever of the two exists), an email address, a Discord display name,
 * and — only when none of those is known — the person's own internal id,
 * the same "nothing left to fall back to" case `components/CoursePeople.tsx`'s
 * own `primaryField` already falls back to for a People row. This is a
 * narrower reuse of that rule than `CoursePeople.tsx`'s own — a heading
 * shows one name, not every known identifier labelled — so this stays its
 * own small function rather than pulling that screen's richer,
 * multi-field `PersonField` machinery in for a single string.
 */

export interface PersonIdentityFields {
  personId: string
  personFirstName: string | null
  personLastName: string | null
  personEmail: string | null
  /** The person's own Discord display name — `TranscriptEntry.personDisplayName`'s own doc comment has why this is named plainly here rather than reusing that ambiguous field name. */
  personDiscordName: string | null
}

/** `firstName`/`lastName` joined, whichever exists — `undefined` when neither is known, the same "no name" signal `CoursePeople.tsx#fullName` already gives. */
function fullName(fields: PersonIdentityFields): string | undefined {
  const parts = [fields.personFirstName, fields.personLastName].filter(
    (part): part is string => part !== null && part !== ''
  )
  return parts.length > 0 ? parts.join(' ') : undefined
}

/** WEB-52's own rule, applied: the first of a full name, an email, or a Discord display name that is known — the bare person id only once none of the three is. */
export function personIdentity(fields: PersonIdentityFields): string {
  return (
    fullName(fields) ??
    fields.personEmail ??
    fields.personDiscordName ??
    fields.personId
  )
}
