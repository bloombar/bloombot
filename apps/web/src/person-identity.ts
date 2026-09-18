/**
 * WEB-52's own "who is this" rule, *reordered* for a message's own heading
 * (WEB-65) — shared by `components/TranscriptBrowser.tsx` and
 * `components/ChatMessage.tsx` (through `pages/Chat.tsx`), the same
 * "one shared function, not a second copy drifting out of sync" reasoning
 * `surface-label.ts`'s own module comment already gives for COST-7's
 * surface vocabulary.
 *
 * In priority order: a full name (first and last, joined by a space, or
 * whichever of the two exists), a Discord display name, an email address,
 * and — only when none of those is known — the person's own internal id,
 * the same "nothing left to fall back to" case `components/CoursePeople.tsx`'s
 * own `primaryField` already falls back to for a People row.
 *
 * **Deliberately not WEB-52's own literal order** (name, email, Discord
 * name) — `docs/DECISIONS.md` D-125 records the reasoning in full: WEB-52's
 * ordering was written for `CoursePeople.tsx`'s own *labelled* row, where
 * `Email: jane@x.edu` cannot be mistaken for anything else. A heading has
 * no label at all — it *is* the name slot — and a bare address sitting
 * there reads as nobody in particular, exactly the discomfort
 * `CoursePeople.tsx`'s own `Email:` prefix exists to avoid. A Discord
 * display name is a name in exactly the sense a heading wants; an email
 * is not, so it moves to third, ahead of only the bare id.
 *
 * This is also a narrower reuse of the rule than `CoursePeople.tsx`'s own —
 * a heading shows one name, not every known identifier labelled — so this
 * stays its own small function rather than pulling that screen's richer,
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

/** WEB-52's own rule, reordered for a heading (this file's own module comment): the first of a full name, a Discord display name, or an email that is known — the bare person id only once none of the three is. */
export function personIdentity(fields: PersonIdentityFields): string {
  return (
    fullName(fields) ??
    fields.personDiscordName ??
    fields.personEmail ??
    fields.personId
  )
}
