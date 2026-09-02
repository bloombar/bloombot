/**
 * LINK-6's own wording, shared by `pages/Connect.tsx`'s assistant form and
 * `pages/DiscordCallback.tsx`'s own preview screen — both name the same
 * `PersonLinkPreview.outcome` shape before asking anyone to confirm, and a
 * second copy of this wording drifting out of sync with the first is
 * exactly the risk one shared function avoids.
 */

import type { PersonLinkOutcome } from './api/types.js'

export function describePersonLinkOutcome(outcome: PersonLinkOutcome): string {
  switch (outcome.kind) {
    case 'attach':
      return 'This identity has not been connected to anyone yet — connecting will attach it to your account.'
    case 'already-connected':
      return 'This identity is already connected to your account. Nothing will change.'
    case 'merge':
      return 'This identity already belongs to a record with its own conversation history and course access — connecting will merge that record into your account. Nothing is lost.'
  }
}
