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
// that already works today. Later phases are work not yet built; a requirement
// lands in one by being claimed on that phase's "**In scope:**" line in
// docs/ROADMAP.md. Adding a phase to the roadmap means adding it here too, so
// sync.mjs creates its milestone.
export const PHASES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
export const MILESTONE_TITLE = {
  0: 'Phase 0 — Shipped baseline',
  // Corrected: this read 'Future work', which never matched the ROADMAP heading.
  1: 'Phase 1 — Defect fixes & test coverage',
  2: 'Phase 2 — Continuous deployment',
  3: 'Phase 3 — Monorepo & data layer',
  4: 'Phase 4 — Conversation core & Discord surface',
  5: 'Phase 5 — API, action layer & authentication',
  6: 'Phase 6 — Web shell & server registration',
  7: 'Phase 7 — Projects & course configuration',
  8: 'Phase 8 — Job runner, throttling & server scaffolding',
  9: 'Phase 9 — Roster import & student channels',
  10: 'Phase 10 — Knowledge files & instructions',
  11: 'Phase 11 — Cost ledger, usage caps & monitoring',
  12: 'Phase 12 — Web student chat surface',
  13: 'Phase 13 — MCP server & agent access',
  14: 'Phase 14 — Admin console, transcripts, audit & export',
  15: 'Phase 15 — Production hardening',
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
  // Families added by the JavaScript migration (docs/ROADMAP.md phases 3-15).
  PLAT: {
    name: 'area:platform',
    color: '0052cc',
    description: 'Monorepo, packages & shared contracts',
  },
  ACT: {
    name: 'area:actions',
    color: '5319e7',
    description: 'Action registry & declared authorization',
  },
  AUTH: {
    name: 'area:auth',
    color: '6f42c1',
    description: 'Accounts, sessions & OAuth',
  },
  TEN: {
    name: 'area:tenancy',
    color: '116329',
    description: 'Organizations & Discord server registration',
  },
  PROJ: {
    name: 'area:projects',
    color: '1a7f37',
    description: 'Projects: the per-term grouping of courses',
  },
  PPL: {
    name: 'area:people',
    color: 'c2e0c6',
    description: 'People, identities & roster fields',
  },
  CONV: {
    name: 'area:conversations',
    color: '0075ca',
    description: 'Conversations, transcripts & daily usage counters',
  },
  CORE: {
    name: 'area:conversation-core',
    color: '0e8a16',
    description: 'The surface-agnostic answering pipeline',
  },
  MIG: {
    name: 'area:legacy-import',
    color: '8250df',
    description: 'One-shot import of the legacy config and database',
  },
  SURF: {
    name: 'area:surfaces',
    color: 'd93f0b',
    description: 'Conversation surfaces: Discord, web chat, MCP',
  },
  WEB: {
    name: 'area:web',
    color: '0aa2c0',
    description: 'React control panel',
  },
  API: {
    name: 'area:api',
    color: 'a2eeef',
    description: 'Express control-plane API',
  },
  JOB: {
    name: 'area:jobs',
    color: 'e4b429',
    description: 'Background jobs, queueing & throttling',
  },
  FILE: {
    name: 'area:files',
    color: '7057ff',
    description: 'Vector stores & course knowledge files',
  },
  COST: {
    name: 'area:cost',
    color: 'b60205',
    description: 'Usage metering, plan caps & the cost ledger',
  },
  MCP: {
    name: 'area:mcp',
    color: '004b6b',
    description: 'MCP server & agent access',
  },
  ADMIN: {
    name: 'area:admin',
    color: '8b0000',
    description: 'Platform administration, audit & export',
  },
  QA: {
    name: 'area:quality',
    color: '2ea043',
    description: 'Tests, types & developer tooling',
  },
}
export const familyLabel = (family) =>
  FAMILY_LABEL[family] || {
    name: `area:${family.toLowerCase()}`,
    color: 'ededed',
    description: '',
  }

// Hidden marker that keys an issue to a requirement id — the idempotency
// anchor. Kept as `sm-req` (the marker string documented in PROJECT_BOARD.md);
// the literal is opaque, and changing it would orphan every synced issue.
export const marker = (id) => `<!-- sm-req: ${id} -->`
export const MARKER_RE = /<!--\s*sm-req:\s*([A-Za-z0-9.-]+)\s*-->/

/** GitHub heading-anchor slug (matches GitHub's own algorithm closely enough). */
export const anchorSlug = (text) =>
  text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')

/** Deep link to a requirement's section in the SPEC on the given branch. */
export const specLink = (id, title, branch) =>
  `https://github.com/${REPO}/blob/${branch}/docs/SPEC.md#${anchorSlug(`${id} ${title}`)}`
