/**
 * The shapes `apps/api` actually returns, as this app reads them.
 *
 * Not `@bloombot/schemas` — the boundary rule (PLAT-2, WEB-6) is "this app
 * may import `@bloombot/schemas` and nothing else from the workspace," it
 * does not require every type to come from there, and nothing in
 * `packages/schemas` describes an account, a membership or an action
 * result today (it holds only the legacy `bot_config.yml` contract). These
 * interfaces mirror `apps/api`'s own route handlers
 * (`apps/api/src/routes/*.ts`) by hand; if the two drift, the mismatch
 * surfaces as a runtime shape this app cannot make sense of, the same risk
 * any HTTP client carries against a server it does not share types with.
 */

/**
 * One organization a signed-in account belongs to, and the account's role in
 * it — `GET /auth/me`.
 *
 * `organizationName` (TEN-7, finding 4 of the rework pass): `apps/api`'s own
 * `/auth/me` (`routes/auth.ts`) has carried this alongside `organizationId`
 * since the slice that added this read surface — nothing here read it back,
 * so `OrganizationSwitcher.tsx` could only ever show a raw id. Required, not
 * optional: the route always sends it (falling back to the id itself only
 * for the account/organization race its own comment documents), so there is
 * no real case this app needs to render around a missing name.
 */
export interface MembershipSummary {
  organizationId: string
  organizationName: string
  role: string
}

/**
 * One organization a signed-in account has a *connected person* in, but no
 * membership (LINK-10) — a student reaching the institution's course they
 * connected to, not an administrator. No `role`, unlike `MembershipSummary`:
 * connecting proves an identity (LINK-3), it does not grant any of the
 * administrative authority a membership role names, so there is no role
 * here to show. `GET /auth/me` never lists the same organization in both
 * `memberships` and `connectedOrganizations` — `apps/api`'s own
 * `routes/auth.ts` excludes anything already present in `memberships`.
 */
export interface ConnectedOrganizationSummary {
  organizationId: string
  organizationName: string
}

/** `GET /auth/me`'s `account` field — `null` for an anonymous or dead session. `email` (LINK-6): `pages/Connect.tsx` names the account signed in, not merely which organizations it belongs to. */
export interface AccountSummary {
  id: string
  email: string
  memberships: MembershipSummary[]
  connectedOrganizations: ConnectedOrganizationSummary[]
}

export interface MeResponse {
  account: AccountSummary | null
}

/** `POST /auth/redeem`, `POST /auth/google`. */
export interface SignedInResponse {
  accountId: string
  /** AUTH-6 — set only by `/auth/redeem`, and only when the token that produced this session was issued with one (`pages/SignIn.tsx`'s own `destination` prop): the same-origin path this sign-in should return to, regardless of which tab redeemed the link. `/auth/google` never sets this — see `pages/RedeemLink.tsx`'s own module comment for why only the emailed-link path needs one at all. */
  destination?: string
}

/** `POST /organizations/:organizationId/discord-servers/install/begin`. */
export interface InstallBeginResponse {
  authorizationUrl: string
  expiresAt: number
}

/** `POST /organizations/:organizationId/discord-servers/install/callback`. */
export interface InstallCallbackResponse {
  serverId: string
}

/** `POST /organizations/:organizationId/person-link/discord/begin` (LINK-7). */
export interface PersonLinkBeginResponse {
  authorizationUrl: string
  expiresAt: number
}

/**
 * `@bloombot/auth`'s own `PersonLinkPreview` (`person-link.ts`), as
 * `routes/person-link.ts` passes it through — mirrored by hand, the same
 * "this app does not import `@bloombot/auth`" boundary (PLAT-2) this
 * file's own module comment already explains for every other shape here.
 * LINK-6: this is what a connect screen names before asking anyone to
 * confirm.
 */
export type PersonLinkOutcome =
  | { kind: 'attach' }
  | { kind: 'already-connected' }
  | { kind: 'merge'; existingPersonId: string }

export interface PersonLinkPreview {
  organizationId: string
  survivorPersonId: string
  identity: { surface: 'discord' | 'mcp'; externalId: string }
  outcome: PersonLinkOutcome
}

/** `POST /organizations/:organizationId/person-link/discord/preview` (LINK-6/7). */
export interface DiscordPersonLinkPreviewResponse {
  preview: PersonLinkPreview
  discordUsername?: string
}

/** `POST /organizations/:organizationId/person-link/mcp/preview` (LINK-6/8). */
export interface McpPersonLinkPreviewResponse {
  preview: PersonLinkPreview
}

/**
 * The one shape every action dispatched through
 * `POST /organizations/:organizationId/actions/:name` returns on success
 * (`routes/actions.ts`) — `result` is whatever that particular action's own
 * `execute` returned, which this app never inspects beyond passing it
 * through, so it is typed no more precisely than `unknown`.
 */
export interface ActionResponse {
  result: unknown
}

/**
 * A field-level issue on a validation failure — the shape zod's own
 * `issues` array takes (`middleware/errors.ts`, `routes/auth.ts`), read
 * only for its `path` and `message` (WEB-5: naming the field that was
 * wrong, nothing more).
 */
export interface ApiIssue {
  path: (string | number)[]
  message: string
}

/**
 * Every error body this API is known to send — one `error` code
 * (`middleware/errors.ts`'s `HTTP_STATUS_BY_ACTION_ERROR` table, plus the
 * handful of route-level codes: `not_signed_in`, `invalid_token`,
 * `invalid_request`, `origin_refused`, `internal_error`), an optional
 * `issues` array (`ActionInputError`/AUTH-1's malformed-address case) and
 * an optional `conflict` (`ActionConflictError` — the one refusal ACT-4
 * allows to name what it collided with).
 */
export interface ApiErrorBody {
  error: string
  issues?: ApiIssue[]
  conflict?: unknown
}

/**
 * PROJ-1/PROJ-2 (WEB-7): one project (a term or cohort), the shape
 * `projects.list`/`projects.create`/`projects.unarchive` all return —
 * mirrors `packages/db`'s `projects` row by hand, the same "not imported
 * from the workspace" discipline this whole file's module comment already
 * explains.
 */
export interface Project {
  id: string
  organizationId: string
  name: string
  archivedAt: number | null
  createdAt: number
}

/** `projects.duplicate`'s own result — PROJ-4/D-23: every copied course arrives disabled, unconditionally, so the panel can say so without a second read. */
export interface DuplicateProjectResult {
  project: Project
  coursesCopied: number
  coursesDisabled: true
}

/**
 * `discordServers.list`'s own return shape (`packages/actions`, TEN-8) —
 * mirrors `packages/db`'s `discord_server_bindings` row by hand, the same
 * "not imported from the workspace" discipline this file's own module
 * comment already explains. Every binding an organization has ever held,
 * active or removed, comes back this way — `removedAt` set is what lets
 * `pages/Shell.tsx` tell "never installed" from "installed, then removed"
 * (the action's own doc comment), rather than the list narrowing to
 * active-only and throwing that distinction away.
 */
export interface DiscordServerBindingSummary {
  serverId: string
  organizationId: string
  installedByAccountId: string
  installedAt: number
  removedAt: number | null
}

/** CFG-4: a channel inside one of a course's categories. */
export interface CourseChannel {
  id: string
  name: string
  adminsOnly: boolean
}

/** CFG-4: a Discord category belonging to a course, with its channels in declared order. */
export interface CourseCategory {
  id: string
  name: string
  channels: CourseChannel[]
}

/**
 * PROJ-1/CFG-2/CFG-3 (WEB-8): one course's base fields — what `courses.list`
 * returns, before its categories and channels (`courses.get` adds those,
 * see `Course` below) — matching `courses.list`'s own "base rows only" split
 * (`packages/actions/src/actions/courses.ts`).
 */
export interface CourseSummary {
  id: string
  organizationId: string
  projectId: string
  title: string
  filePrefix: string
  enabled: boolean
  adminsRole: string
  studentsRole: string
  promptId: string | null
  instructions: string | null
  model: string | null
  vectorStoreId: string | null
  maxRequestsPerDay: number | null
  conversationScope: 'course' | 'course_surface'
  // TEN-9 — which of the organization's (possibly several) Discord servers
  // this course routes in. `null` resolves through the organization's own
  // single active binding when it has exactly one (`repos/discord-servers.ts#resolveCourseDiscordServer`);
  // `pages/CourseEditor.tsx`'s own server selector only offers a choice at
  // all once the organization holds more than one active binding.
  discordServerId: string | null
  createdAt: number
}

/** `courses.get`'s own shape: a course with its categories and channels attached (CFG-4). */
export interface Course extends CourseSummary {
  categories: CourseCategory[]
}

/**
 * FILE-4/WEB-19 — one revision of a course's instructions, as
 * `courseInstructions.list` returns it, newest first: what
 * `components/CourseInstructions.tsx`'s own history list reads, and what a
 * restore reads back from. `savedByAccountId` is the account id only — this
 * app has no directory read that turns one into a display name or email
 * (`docs/DECISIONS.md` D-54), so the history shows the id itself.
 */
export interface CourseInstructionRevisionSummary {
  id: string
  instructions: string
  savedByAccountId: string
  createdAt: number
}

/**
 * FILE-1..3 (WEB-18) — one of a course's knowledge-file attachments, as
 * `courseAttachments.list` returns it. Deliberately narrower than
 * `packages/db`'s own `CourseAttachment` row: `providerFileId` and the
 * course's `vectorStoreId` are never mirrored here at all — an instructor
 * never needs the provider's own bookkeeping (FILE-1's own "replacing a
 * vector store id typed in from a vendor dashboard"), only what a file is
 * called, its size, and whether it is grounding answers yet (FILE-2).
 */
export interface CourseAttachmentSummary {
  id: string
  filename: string
  contentType: string
  sizeBytes: number
  status: 'pending' | 'ready' | 'failed'
  /** The provider's own rejection message — set only when `status: 'failed'` (FILE-2). */
  failureReason: string | null
  createdAt: number
}

/**
 * WEB-20 — one of a course's join links, as `courseJoinLinks.list` returns
 * it. Mirrors `packages/actions/src/actions/course-join-links.ts`'s own
 * `CourseJoinLinkSummary` by hand, the same "not imported from the
 * workspace" discipline this file's own module comment already explains —
 * and, just as deliberately, narrower than the database row it is drawn
 * from: there is no `secretHash` field here for the same reason
 * `CourseAttachmentSummary` above carries no `providerFileId` — the secret
 * is shown once, at creation (`CreatedCourseJoinLink` below), or again later
 * (ENRL-12, `RevealedCourseJoinLink` below), never on this listing itself.
 *
 * `revealable` (ENRL-12) says whether `courseJoinLinks.reveal` can plausibly
 * succeed for this link — `false` for a link created before ENRL-12
 * shipped, or created while no encryption key was configured — so
 * `components/JoinLinks.tsx` can withhold the reveal control rather than
 * offer one certain to fail; it carries no secret material itself
 * (`CourseJoinLinkSummary`'s own doc comment, `packages/actions`).
 */
export interface CourseJoinLinkSummary {
  id: string
  courseId: string
  expiresAt: number | null
  revokedAt: number | null
  createdByAccountId: string
  createdAt: number
  revealable: boolean
}

/**
 * WEB-20 — what `courseJoinLinks.create` hands back once, and only once: the
 * plaintext secret itself. Mirrors `packages/actions`' own
 * `CreatedCourseJoinLink`. Never stored by this app past the component that
 * renders it — a reload has nothing left to show, because the database
 * itself does not either (`repos/course-join-links.ts`'s own module
 * comment).
 */
export interface CreatedCourseJoinLink {
  linkId: string
  secret: string
  expiresAt: number | null
}

/**
 * ENRL-12 — what `courseJoinLinks.reveal` hands back: the plaintext secret
 * again, for a live link an instructor already asked to see once, at
 * creation. Mirrors `packages/actions`' own `RevealedCourseJoinLink`. The
 * same "never stored past the component that renders it" discipline
 * `CreatedCourseJoinLink` above already holds itself to —
 * `components/JoinLinks.tsx` keeps at most one of these in memory at a
 * time, cleared explicitly or replaced by the next reveal, never folded
 * into `CourseJoinLinkSummary`'s own list state.
 */
export interface RevealedCourseJoinLink {
  secret: string
}

/**
 * WEB-22 — one enrolment in a course's own people screen, active or ended,
 * as `enrolments.listForCourse` returns it. Mirrors
 * `packages/db/src/repos/enrolments.ts`'s own `CourseEnrolmentEntry` by
 * hand, the same "not imported from the workspace" discipline this file's
 * own module comment already explains. `displayName`, not the person's own
 * email — the same "no genuine need to disambiguate by it" reasoning that
 * repo function's own doc comment gives; a `null` `displayName` is told
 * apart from another by `personId` instead (`components/CoursePeople.tsx`'s
 * own fallback, the same one `Transcripts.tsx` already uses for the
 * identical case). `endedAt`/`reinstatedByAccountId`/`reinstatedAt` are all
 * `null` for an enrolment that has never been ended (ENRL-6) or, having
 * been ended, never reinstated (ENRL-9).
 */
export interface CourseEnrolment {
  id: string
  personId: string
  displayName: string | null
  source: 'join_link' | 'discord_role' | 'roster'
  createdAt: number
  endedAt: number | null
  reinstatedByAccountId: string | null
  reinstatedAt: number | null
}

/** WEB-10 — `GET /organizations/:organizationId/chat/courses`'s own entries: just enough to pick one, not `CourseSummary`'s full instructor-facing shape. */
export interface ChatCourse {
  id: string
  title: string
}

/**
 * SRV-6/JOB-1..5 — a job's status and outcome, as `jobs.get` (dispatched
 * through the ordinary action route) hands it back, and as each entry in
 * `jobs.list`'s own array (JOB-2) is shaped too — both actions share the
 * same `toJobStatus` mapping server-side (`packages/actions/src/actions/jobs.ts`'s
 * own module comment), so one interface here mirrors both. Mirrors
 * `packages/actions/src/actions/jobs.ts`'s own `JobStatus` by hand, the
 * same "this app does not import `@bloombot/actions`" boundary this
 * file's own module comment already explains for every other shape here.
 */
export interface JobStatus {
  id: string
  kind: string
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  attempts: number
  maxAttempts: number
  lastError: string | null
  result: unknown
  createdAt: number
  updatedAt: number
}

/**
 * WEB-21/ROST-9..12 — a `roster.import` job's own report, once
 * `JobStatus.result` carries one (`status: 'succeeded'`). Mirrors
 * `apps/worker/src/handlers/roster-import.ts`'s own `RosterImportReport` by
 * hand — this app cannot import an app it does not build with (the same
 * "not imported from the workspace" boundary this file's own module
 * comment states for every other shape here, one level stricter: apps do
 * not import each other's source at all, workspace package or not). Every
 * field here narrows to what the panel's own import screen actually shows
 * an instructor — `line`/`discord`/`email` on each row-shaped entry so a
 * spreadsheet can be corrected and re-uploaded (ROST-9), never the raw
 * Discord ids or category bookkeeping the worker's own report also carries
 * for its own diagnostic purposes.
 */
export interface RosterImportReport {
  parseErrors: { line: number; message: string }[]
  peopleCreated: { line: number; discord: string; personId: string }[]
  peopleMerged: { line: number; discord: string; personId: string }[]
  unresolvedHandles: { line: number; discord: string; email: string }[]
  ambiguousHandles: {
    line: number
    discord: string
    email: string
    matchedDisplayNames: string[]
  }[]
  channelsCreated: {
    line: number
    email: string
    channelName: string
    category: string
  }[]
  channelsAlreadyPresent: {
    line: number
    email: string
    channelName: string
    category: string
  }[]
  channelsNotCreated: { line: number; email: string; reason: string }[]
  channelsFailed: {
    line: number
    email: string
    channelName: string
    category: string
    reason: string
  }[]
  channelNameCollisions: {
    line: number
    email: string
    channelName: string
    collidesWithLine: number
    collidesWithEmail: string
  }[]
  unresolvedRoles: string[]
  /** ROST-6's own welcome message, and any other structural gap this run wants named plainly — see `RosterImportReport.limitations`'s own doc comment in `apps/worker`. */
  limitations: string[]
}

/** WEB-10 — one message on a chat transcript (`GET .../chat/courses/:courseId/messages`), and the shape `POST .../messages` appends locally once its own `ChatAnswerResult` confirms the reply. */
export interface ChatMessageEntry {
  id: string
  role: 'student' | 'assistant'
  text: string
  createdAt: number
}

/**
 * `@bloombot/core`'s own `AnswerResult` (`packages/core/src/answer.ts`),
 * exactly as `routes/chat.ts` passes it through — mirrored by hand rather
 * than imported, the same "this app does not import `@bloombot/core`"
 * boundary (PLAT-2) this whole file's own module comment already explains
 * for every other shape here.
 */
export type ChatAnswerResult =
  | { kind: 'answered'; conversationId: string; text: string }
  | { kind: 'answered-last-request'; conversationId: string; text: string }
  | { kind: 'declined-over-limit' }
  | { kind: 'declined-over-cap' }
  | { kind: 'declined-busy' }
  | {
      kind: 'failed-with-apology'
      conversationId: string
      text: string
      lastRequestOfDay: boolean
    }
  | { kind: 'course-disabled' }
  | { kind: 'not-configured' }
  | { kind: 'not-connected' }

/** ADMIN-1: one message in a read-back transcript — mirrors `@bloombot/db`'s own `transcriptAccess.TranscriptEntry` by hand, the same "this app does not import `@bloombot/db`" boundary this whole file's own module comment already explains for every other shape here. */
export interface TranscriptEntry {
  personId: string
  personDisplayName: string | null
  direction: 'from_person' | 'to_person'
  content: string
  createdAt: number
}

/** `transcripts.read`'s own result — a course's transcript, already filtered by whatever the request asked for. */
export interface TranscriptReadResult {
  courseId: string
  courseTitle: string
  entries: TranscriptEntry[]
}

/** `transcripts.listStudents`'s own entries — ADMIN-1's student filter, every person the transcript covers. */
export interface TranscriptStudent {
  personId: string
  personDisplayName: string | null
}

/** ADMIN-3 — one requested export, mirroring `@bloombot/db`'s own `transcriptExports.TranscriptExport` by hand. */
export interface TranscriptExport {
  id: string
  courseId: string
  personId: string | null
  status: 'pending' | 'ready' | 'failed'
  filename: string | null
  contentType: string | null
  sizeBytes: number | null
  failureReason: string | null
  createdAt: number
  updatedAt: number
}

/** ADMIN-2 — one row of a course's transcript-access audit trail, mirroring `@bloombot/actions`'s own `TranscriptAccessLogRow` by hand — a display name for both the reading account and, when the read was filtered, the student it named, never an email (`packages/actions/src/actions/transcripts.ts`'s own module comment on why). */
export interface TranscriptAccessLogEntry {
  id: string
  actorAccountId: string
  actorDisplayName: string
  personId: string | null
  personDisplayName: string | null
  kind: 'read' | 'export'
  startAt: number | null
  endAt: number | null
  createdAt: number
}

/** ADMIN-4 — `GET /admin/organizations`'s own per-organization row: usage only, never a course, a person or a message. */
export interface AdminOrganizationSummary {
  organizationId: string
  organizationName: string
  totalCostMicros: number
  estimatedCostMicros: number
  callCount: number
}

/** COST-5's own aggregate, as `checkPlatformHealth` (`@bloombot/actions`) reports it — mirrored by hand, the same boundary this file's own module comment already explains. */
export interface AdminProcessHealth {
  reachable: boolean
  status?: unknown
}
export interface AdminPlatformHealth {
  bot: AdminProcessHealth
  worker: AdminProcessHealth
  api: AdminProcessHealth
}

export interface AdminOrganizationsResponse {
  organizations: AdminOrganizationSummary[]
  platformHealth: AdminPlatformHealth
}

/** ADMIN-5's own "names exactly what will be deleted before it happens". */
export interface OrganizationDeletionPreview {
  organizationId: string
  organizationName: string
  courses: number
  people: number
  conversations: number
  messages: number
  enrolments: number
  discordServerBindings: number
  courseAttachments: number
  queuedJobs: number
}

/** ADMIN-5's own audit trail, read back. */
export interface TenantDeletion {
  id: string
  organizationId: string
  organizationName: string
  deletedByAccountId: string
  summary: string
  deletedAt: number
}

/** COST-4 — one course's own usage, as `costLedger.organizationUsage` reports it. Mirrors `@bloombot/db`'s own `CourseUsageSummary` by hand, the same boundary this file's own module comment already explains. */
export interface CourseUsageSummary {
  courseId: string
  courseTitle: string
  costMicros: number
  /** The portion of `costMicros` that came from an estimate rather than a measurement (COST-6) — see `pages/Usage.tsx`'s own module comment for what this changes about how a total is shown. */
  estimatedCostMicros: number
  callCount: number
}

/**
 * COST-4 — one (course, person) pair whose count for a given day has
 * reached a course's own near-limit threshold. Mirrors `@bloombot/db`'s own
 * `usage.UsageNearLimit` by hand. `personDisplayName`, not the student's own
 * email — the same "no genuine need to disambiguate by it" reasoning
 * `api/types.ts#CourseEnrolment`'s own doc comment already gives for the
 * identical case; `components/CoursePeople.tsx`'s own `label` fallback
 * (`displayName ?? personId`) is what `pages/Usage.tsx` uses for this too.
 */
export interface UsageNearLimit {
  courseId: string
  courseTitle: string
  personId: string
  personDisplayName: string | null
  count: number
  maxRequestsPerDay: number
}

/** COST-4 — `costLedger.organizationUsage`'s own report: every course's usage in the caller's organization, its cap (if any), and which students are approaching a course's own daily limit. Mirrors `@bloombot/actions`' own `OrganizationUsageReport` by hand. */
export interface OrganizationUsageReport {
  organizationId: string
  spendingCapMicros: number | null
  totalCostMicros: number
  totalEstimatedCostMicros: number
  courses: CourseUsageSummary[]
  studentsNearLimit: UsageNearLimit[]
}

/** COST-3 — `costLedger.setSpendingCap`'s own return: what is now stored, after the call. Mirrors `@bloombot/actions`' own `SetSpendingCapResult` by hand. */
export interface SetSpendingCapResult {
  organizationId: string
  spendingCapMicros: number | null
}

/**
 * ENRL-5 — one membership in the caller's organization, as `memberships.list`
 * returns it. Mirrors `@bloombot/actions`' own `MembershipEntry` by hand, the
 * same boundary this file's own module comment already explains.
 * `displayName`/`grantedByDisplayName`, never an email — an account's
 * `displayName` is never `null` (unlike a student's own, `CourseEnrolment`'s
 * own doc comment), so there is no id fallback to render here the way
 * `components/CoursePeople.tsx#label` needs one. `grantedByAccountId`/
 * `grantedByDisplayName`/`grantedAt` are all `null` for the one membership
 * nobody grants — the founding owner row `accounts.createAccount` writes
 * inline at sign-up (`@bloombot/db`'s own `schema.ts`).
 */
export interface OrganizationMembership {
  accountId: string
  displayName: string
  role: 'owner' | 'instructor' | 'assistant'
  grantedByAccountId: string | null
  grantedByDisplayName: string | null
  grantedAt: number | null
  createdAt: number
}

/**
 * ENRL-5 — `memberships.grant`'s own return: `@bloombot/db`'s raw
 * `memberships` row (`packages/db/src/repos/memberships.ts`'s own
 * `Membership`), not `OrganizationMembership` above — the grant action
 * hands back exactly what it wrote, with no display name attached (that
 * enrichment is `memberships.list`'s own job, above). `components/Team.tsx`
 * re-fetches the list after a grant rather than reading a display name off
 * this, the same "refresh after a write" shape `pages/Usage.tsx`'s own
 * `handleSave` already takes after `setSpendingCap`.
 */
export interface GrantMembershipResult {
  organizationId: string
  accountId: string
  role: 'owner' | 'instructor' | 'assistant'
  grantedByAccountId: string | null
  grantedAt: number | null
  createdAt: number
}

/**
 * ENRL-10 — one invitation an organization has issued, as
 * `membershipInvitations.list` returns it. Mirrors `@bloombot/actions`' own
 * `MembershipInvitationSummary` by hand, the same boundary this file's own
 * module comment already explains. Unlike `OrganizationMembership` above,
 * `email` is present — an outstanding invitation has no account yet to
 * attach a `displayName` to, and the address an owner typed is the only
 * thing that identifies it (`membership-invitations.ts`'s own doc comment
 * on why that omission is load-bearing for a granted role but not here).
 * Never `secretHash` — that redeems the invitation, and only ever existed,
 * in plaintext, at creation (`CreatedMembershipInvitation`, below).
 */
export interface MembershipInvitation {
  id: string
  email: string
  role: 'owner' | 'instructor' | 'assistant'
  expiresAt: number | null
  revokedAt: number | null
  redeemedAt: number | null
  createdByAccountId: string
  createdAt: number
}

/**
 * ENRL-10 — what `membershipInvitations.create` hands back once, and only
 * once: the plaintext secret itself. Mirrors `@bloombot/actions`' own
 * `CreatedMembershipInvitation`. Never stored by this app past the
 * component that renders it — a reload has nothing left to show, because
 * the database itself does not either (`repos/membership-invitations.ts`'s
 * own module comment), the same "shown once" shape
 * `CreatedCourseJoinLink` already gives WEB-20's own join links.
 */
export interface CreatedMembershipInvitation {
  invitationId: string
  secret: string
  expiresAt: number | null
}
