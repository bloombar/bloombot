/**
 * Shared configuration for the project-board scripts (derive.mjs, sync.mjs).
 * Field/option IDs are intentionally NOT hard-coded here — sync.mjs discovers
 * them from the live project at runtime so option-id changes don't break it.
 *
 * The board is the USER-level GitHub Project
 * https://github.com/users/bloombar/projects/2 — `gh project …` accepts a user
 * login for --owner, so no owner-type special-casing is needed here.
 */

// The GitHub Project and the repo its issues live in.
export const OWNER = 'bloombar'
export const PROJECT_NUMBER = 2
export const REPO = 'bloombar/bloombot'

// Phases are carried by repo Milestones; the project's built-in Milestone
// field is what each phase tab filters on. Titles must match the milestones.
// Phase 0 is the shipped baseline — the functionality documented in docs/SPEC.md
// that already works today. Phase 1 is anything not yet built; a requirement
// lands there by being claimed on an "**In scope:**" line in docs/ROADMAP.md.
export const PHASES = [0, 1]
export const MILESTONE_TITLE = {
  0: 'Phase 0 — Shipped baseline',
  1: 'Phase 1 — Future work',
}
// Optional due dates (none set yet — add as the schedule firms up).
export const MILESTONE_DUE = {}

// The Status single-select drives the board columns. These names must match
// the existing option names on the project's Status field exactly.
export const STATUSES = ['Backlog', 'In progress', 'In review', 'Done']

// Per-family labels so the different types of task are distinguishable in the
// repo and on the board. Keyed by requirement family (BOT, AI, DSC, …) — the
// families used by the `#### <FAMILY>-<N>` headings in docs/SPEC.md.
export const FAMILY_LABEL = {
  CFG: {
    name: 'area:config',
    color: '1d76db',
    description: 'Course config, environment & secrets',
  },
  DSC: {
    name: 'area:discord-client',
    color: '5865f2',
    description: 'DiscordManager client library',
  },
  SRV: {
    name: 'area:server-setup',
    color: '0e8a16',
    description: 'Server scaffolding: categories, channels, permissions',
  },
  ROST: {
    name: 'area:rosters',
    color: 'c5def5',
    description: 'Roster ingestion & per-student channels',
  },
  BOT: {
    name: 'area:chatbot',
    color: '5319e7',
    description: 'Discord chatbot behavior',
  },
  AI: {
    name: 'area:ai',
    color: 'b60205',
    description: 'OpenAI integration',
  },
  DATA: {
    name: 'area:data',
    color: 'fbca04',
    description: 'Database, models & migrations',
  },
  CLI: {
    name: 'area:cli',
    color: '555555',
    description: 'Command-line administration',
  },
  ANLY: {
    name: 'area:analytics',
    color: '006b75',
    description: 'Conversation analytics notebook',
  },
  OPS: {
    name: 'area:ops',
    color: 'd93f0b',
    description: 'Deployment, logging & environment',
  },
  BOARD: {
    name: 'area:tooling',
    color: 'ededed',
    description: 'Spec & project-board tooling',
  },
}
export const familyLabel = family =>
  FAMILY_LABEL[family] || {
    name: `area:${family.toLowerCase()}`,
    color: 'ededed',
    description: '',
  }

// Hidden marker that keys an issue to a requirement id — the idempotency
// anchor. Kept as `sm-req` (the marker string documented in PROJECT_BOARD.md);
// the literal is opaque, and changing it would orphan every synced issue.
export const marker = id => `<!-- sm-req: ${id} -->`
export const MARKER_RE = /<!--\s*sm-req:\s*([A-Za-z0-9.-]+)\s*-->/

/** GitHub heading-anchor slug (matches GitHub's own algorithm closely enough). */
export const anchorSlug = text =>
  text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')

/** Deep link to a requirement's section in the SPEC on the given branch. */
export const specLink = (id, title, branch) =>
  `https://github.com/${REPO}/blob/${branch}/docs/SPEC.md#${anchorSlug(`${id} ${title}`)}`
