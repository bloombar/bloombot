/**
 * COST-7's own human label for one ledger surface, shared by
 * `pages/Usage.tsx#formatBySurface` and `pages/Admin.tsx#formatBySurface` —
 * both screens' own per-surface breakdown lines name the same three real
 * surfaces plus `'unknown'`, and a second copy of this mapping drifting out
 * of sync with the first (one screen adding a future surface, the other
 * left rendering the bare enum value) is exactly the risk one shared
 * function avoids, the same reasoning `person-link-outcome.ts`'s own module
 * comment gives for the identical shape.
 *
 * The formatters around this label differ legitimately between the two
 * screens (`3 calls` vs `3 call(s)`, `(includes an estimate)` vs
 * `· partly estimated`) and stay local to each — only the label itself is
 * shared.
 */

import type { CostBySurface, TranscriptEntry } from './api/types.js'

export function surfaceLabel(surface: CostBySurface['surface']): string {
  switch (surface) {
    case 'discord':
      return 'Discord'
    case 'web':
      return 'Web'
    case 'mcp':
      return 'MCP'
    case 'unknown':
      return 'recorded before surfaces were tracked'
  }
}

/**
 * WEB-66 — the surfaces a message can actually arrive on, for the
 * Transcripts screen's own surface filter (`components/TranscriptBrowser.tsx`)
 * to list — narrower than `CostBySurface['surface']` above, which also
 * carries `'unknown'` for a cost-ledger row recorded before surfaces were
 * tracked; a filter offers only the three real surfaces `TranscriptEntry.surface`
 * can actually hold, plus this screen's own "any" default (rendered
 * separately, not a fourth entry here).
 */
export const TRANSCRIPT_SURFACES: NonNullable<TranscriptEntry['surface']>[] = [
  'discord',
  'web',
  'mcp',
]
