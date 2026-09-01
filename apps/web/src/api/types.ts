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

/** `GET /auth/me`'s `account` field — `null` for an anonymous or dead session. */
export interface AccountSummary {
  id: string
  memberships: MembershipSummary[]
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
