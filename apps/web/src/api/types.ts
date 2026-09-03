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
 * is shown once, at creation (`CreatedCourseJoinLink` below), and never
 * again.
 */
export interface CourseJoinLinkSummary {
  id: string
  courseId: string
  expiresAt: number | null
  revokedAt: number | null
  createdByAccountId: string
  createdAt: number
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
 * WEB-22 — one enrolment in a course's own people screen, active or ended,
 * as `enrolments.listForCourse` returns it. Mirrors
 * `packages/db/src/repos/enrolments.ts`'s own `CourseEnrolmentEntry` by
 * hand, the same "not imported from the workspace" discipline this file's
 * own module comment already explains. `displayName`, not the person's own
 * email — the same "no genuine need to disambiguate by it" reasoning that
 * repo function's own doc comment gives; a `null` `displayName` is told
 * apart from another by `personId` instead (`components/EnrolmentsPanel.tsx`'s
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
 * through the ordinary action route) hands it back. Mirrors
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
