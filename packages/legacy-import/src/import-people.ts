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
 * snowflake, PPL-2's natural key) and `people.overwriteRosterFields` (write
 * the roster fields exactly as the legacy row carries them, every run — see
 * `import.ts`'s module comment on why `overwrite`, not `merge`, is correct
 * for this one caller). Idempotent (MIG-4): re-running against the same
 * snapshot resolves the same identity to the same person every time, and
 * overwrites it with the same values, so a second run reports every row
 * `matched`, not `created`, and nothing changes on disk.
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
    peopleRepo.overwriteRosterFields(
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
