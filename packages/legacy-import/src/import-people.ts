/**
 * MIG-3's first half: each legacy `users` row becomes a person plus a
 * `discord` identity, carrying `email`, `first_name`, `last_name` and
 * `github_username` (`models/user.py`'s roster fields) — everything but
 * `discord_username`, which the brief's own field list for this file omits;
 * PPL-1's `displayName` is left unset here the same way a brand-new person
 * created by `resolvePersonByIdentity` leaves it unset (PPL-3), rather than
 * this importer inventing a value for a field it was not asked to carry.
 *
 * A legacy user with no `discord_id` cannot be given a `discord` identity —
 * `person_identities.externalId` has nothing to key on — so that row is
 * reported skipped rather than silently dropped, matching MIG-4's "reported,
 * not dropped" for a message that cannot be placed.
 *
 * **Merge, not overwrite (finding 4 of the MIG-1 rework — see
 * `docs/DECISIONS.md` D-14).** MIG-4 makes re-running the importer the
 * normal thing to do, and the legacy snapshot is the *oldest* source of
 * roster data in the system, not the newest: an instructor correcting a
 * blank email by hand, or a later roster import, is information the legacy
 * snapshot cannot know about and must not clobber. `people.overwriteRosterFields`
 * would write the legacy row's fields — including its `null`s — verbatim on
 * every run, silently resetting any correction made since the last import.
 * `people.mergeRosterFields` only ever fills a field that is currently
 * `null`, so a re-run still repairs a person's roster fields the first time
 * they are seen, but never re-clobbers a field something else has since
 * filled in. This is the opposite of `import-config.ts`'s course settings,
 * where the YAML *is* authoritative on every re-run — see that file's module
 * comment and D-14 for the asymmetry and why it is deliberate.
 */

import { people as peopleRepo, type Database } from '@bloombot/db'

import type { LegacyUser } from './read-legacy.js'

/** What happened to one legacy user on import. */
export type PersonImportOutcome =
  | { legacyUserId: number; ok: true; created: boolean; personId: string }
  | { legacyUserId: number; ok: false; reason: string }

/**
 * Import every `legacyUsers` row into `organizationId`, through
 * `people.resolvePersonByIdentity` (create-or-match on the Discord
 * snowflake, PPL-2's natural key) and `people.mergeRosterFields` (fill in
 * whatever roster fields the person does not already have — see this file's
 * module comment for why merge, not overwrite, is correct here). Idempotent
 * (MIG-4): re-running against the same snapshot resolves the same identity
 * to the same person every time, and a person whose fields are already
 * filled in (by this importer or anything else) is left as-is, so a second
 * run reports every row `matched`, not `created`, and nothing changes on
 * disk.
 */
export function importPeople(
  organizationId: string,
  legacyUsers: LegacyUser[],
  db: Database
): PersonImportOutcome[] {
  return legacyUsers.map((legacyUser) => {
    if (!legacyUser.discordId) {
      return {
        legacyUserId: legacyUser.id,
        ok: false,
        reason: `Legacy user ${legacyUser.id} has no discord_id; a person cannot be created without an identity to key it on.`,
      }
    }

    const identity: peopleRepo.PersonIdentityInput = {
      surface: 'discord',
      externalId: legacyUser.discordId,
    }
    const existing = peopleRepo.resolveIdentity(organizationId, identity, db)
    const person = peopleRepo.resolvePersonByIdentity(
      organizationId,
      identity,
      db
    )
    peopleRepo.mergeRosterFields(
      organizationId,
      person.id,
      {
        email: legacyUser.email,
        firstName: legacyUser.firstName,
        lastName: legacyUser.lastName,
        githubHandle: legacyUser.githubUsername,
      },
      db
    )

    return {
      legacyUserId: legacyUser.id,
      ok: true,
      created: !existing,
      personId: person.id,
    }
  })
}
