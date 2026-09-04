/**
 * The one module that talks to `apps/api` (WEB-2, WEB-5). Every call:
 *
 *  - sends `credentials: 'include'` so the session cookie travels, and sets
 *    no `Authorization` header — there is no token in this bundle to send
 *    one with (WEB-2: "nothing in the bundle stores a token").
 *  - reads the response body and, on a non-2xx status, throws an `ApiError`
 *    carrying that body exactly as the API sent it. Nothing here
 *    reinterprets a status code or invents a message — `describeApiError`
 *    (`components/ErrorMessage.tsx`) is the one place that turns an
 *    `ApiError` into words a person reads, kept separate so this module's
 *    only job is "what did the server actually say" (WEB-5).
 *  - turns a `fetch` that never got a response at all — a proxy or network
 *    failure between this browser and `apps/api` — into the same `ApiError`
 *    every caller already narrows on (`error: 'network_error'`), rather than
 *    letting a rejected `fetch` reach app code un-narrowed.
 *
 * Every request path here is relative (`/auth/...`, `/organizations/...`)
 * — `vite.config.ts`'s `server.proxy`/`preview.proxy` puts this app and
 * `apps/api` on the same origin in development and in the Playwright
 * harness, matching WEB-1's "talking to the API over the same origin" in
 * production (nginx, not this file).
 */

import type {
  AdminOrganizationsResponse,
  ApiErrorBody,
  ChatAnswerResult,
  ChatCourse,
  ChatMessageEntry,
  Course,
  CourseAttachmentSummary,
  CourseEnrolment,
  CourseInstructionRevisionSummary,
  CourseJoinLinkSummary,
  CourseSummary,
  CourseWebSourceSummary,
  CreatedCourseJoinLink,
  DiscordPersonLinkPreviewResponse,
  DiscordServerBindingSummary,
  DuplicateProjectResult,
  InstallBeginResponse,
  InstallCallbackResponse,
  JobStatus,
  CreatedMembershipInvitation,
  GrantMembershipResult,
  McpPersonLinkPreviewResponse,
  MeResponse,
  MembershipInvitation,
  OrganizationDeletionPreview,
  OrganizationMembership,
  OrganizationUsageReport,
  PersonLinkBeginResponse,
  Project,
  RevealedCourseJoinLink,
  SetSpendingCapResult,
  SignedInResponse,
  TenantDeletion,
  TranscriptAccessLogEntry,
  TranscriptExport,
  TranscriptReadResult,
  TranscriptStudent,
} from './types.js'

/**
 * Thrown for any non-2xx response. Carries the response's own `status` and
 * parsed JSON body — unchanged, per WEB-5 — plus a fallback shape for the
 * rare response that is not JSON at all (a proxy error, a body-parser
 * failure before `middleware/errors.ts` ever ran), which `describeApiError`
 * still has to render honestly rather than crash on.
 */
export class ApiError extends Error {
  readonly status: number
  readonly body: ApiErrorBody

  constructor(status: number, body: ApiErrorBody) {
    super(body.error)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

async function request<T>(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  // `exactOptionalPropertyTypes` (tsconfig.base.json) forbids passing
  // `body: undefined` explicitly — `RequestInit#body` may be omitted, but
  // not present-and-undefined — so a GET/body-less call spreads in nothing
  // rather than an explicit `undefined`.
  let response: Response
  try {
    response = await fetch(path, {
      method: init?.method ?? 'GET',
      credentials: 'include',
      headers: init?.body ? { 'Content-Type': 'application/json' } : {},
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    })
  } catch {
    // `fetch` itself rejected — no response ever arrived: a DNS failure, a
    // refused connection, a proxy or nginx that dropped the request before
    // `apps/api` saw it (finding 3 of the WEB-1..6 rework). Distinct from
    // `unreadable_response` below, which is a response that *did* arrive
    // and failed to parse — this is no response at all. Turning it into an
    // `ApiError` here, in the one module every screen calls through, means
    // every caller's existing `caught instanceof ApiError` narrowing
    // already handles it — nobody has to add its own fetch-level try/catch.
    throw new ApiError(0, { error: 'network_error' })
  }

  if (response.status === 204) {
    return undefined as T
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    // A response arrived but this app cannot even parse it as JSON — a body
    // truncated in transit, a proxy's own HTML error page standing in for
    // apps/api's, not anything apps/api itself reported. (A response that
    // never arrived at all is `network_error`, thrown above this function's
    // own `fetch` call — this branch only runs once a `Response` exists.)
    // `describeApiError` still needs something to render (WEB-5: no stack
    // trace, no raw exception).
    parsed = { error: 'unreadable_response' }
  }

  if (!response.ok) {
    throw new ApiError(response.status, parsed as ApiErrorBody)
  }
  return parsed as T
}

/**
 * AUTH-1: request a sign-in link. Always resolves — the API answers the
 * same way whether or not the address has an account.
 *
 * `destination` (AUTH-6): the same-origin path this sign-in should return to
 * once redeemed, whichever tab redeems it — `pages/JoinLink.tsx`/
 * `pages/Connect.tsx` pass their own page's own path through
 * `pages/SignIn.tsx`'s own prop of the same name. `undefined` for the
 * ordinary "email me a link" screen, which has nowhere in particular to
 * return to.
 */
export function requestSignInLink(
  email: string,
  destination?: string
): Promise<void> {
  return request<void>('/auth/request-link', {
    method: 'POST',
    body: { email, destination },
  })
}

/** AUTH-1: redeem a sign-in link. Throws `ApiError` (401) for an unknown, expired or already-redeemed token. */
export function redeemSignInLink(token: string): Promise<SignedInResponse> {
  return request<SignedInResponse>('/auth/redeem', {
    method: 'POST',
    body: { token },
  })
}

/** AUTH-2: sign in with a Google ID token. Throws `ApiError` (401) when the token does not verify. */
export function signInWithGoogle(idToken: string): Promise<SignedInResponse> {
  return request<SignedInResponse>('/auth/google', {
    method: 'POST',
    body: { idToken },
  })
}

/** AUTH-3: sign out — ends the session server-side, not merely in this tab. */
export function signOut(): Promise<void> {
  return request<void>('/auth/sign-out', { method: 'POST' })
}

/**
 * ENRL-8: redeem a course join link, bound to the caller's own signed-in
 * session — `apps/api`'s own `routes/join-links.ts` never accepts anything
 * beyond the secret itself in the request body. Throws `ApiError` (404,
 * `join_link_not_found`) identically for a secret that was never issued,
 * one that is revoked, and one that has expired (ENRL-4) — never a
 * different status or message across the three.
 *
 * WEB-25: `organizationId` and `alreadyEnrolled` travel alongside `courseId`
 * — the server already resolved all three, and discarding the extra two was
 * exactly what left `pages/JoinLink.tsx` unable to say which course a
 * redeemer just joined, or open the panel there directly.
 */
export function redeemCourseJoinLink(secret: string): Promise<{
  courseId: string
  organizationId: string
  alreadyEnrolled: boolean
}> {
  return request<{
    courseId: string
    organizationId: string
    alreadyEnrolled: boolean
  }>('/join-links/redeem', {
    method: 'POST',
    body: { secret },
  })
}

/** "Who am I" — the account and its memberships (WEB-3), or `{ account: null }` when signed out. */
export function fetchMe(): Promise<MeResponse> {
  return request<MeResponse>('/auth/me')
}

/** TEN-4: begin installing the bot into a Discord server, acting as `organizationId`. */
export function beginDiscordInstall(
  organizationId: string
): Promise<InstallBeginResponse> {
  return request<InstallBeginResponse>(
    `/organizations/${organizationId}/discord-servers/install/begin`,
    { method: 'POST', body: {} }
  )
}

/** TEN-4: complete an installation with the `code`/`state`/`guildId` Discord's own redirect carried back. */
export function completeDiscordInstall(
  organizationId: string,
  input: { code: string; state: string; guildId: string }
): Promise<InstallCallbackResponse> {
  return request<InstallCallbackResponse>(
    `/organizations/${organizationId}/discord-servers/install/callback`,
    { method: 'POST', body: input }
  )
}

/**
 * TEN-8: every Discord server binding `organizationId` has ever held,
 * active or removed — `discordServers.list`'s own action
 * (`packages/actions`), reached through `dispatchAction` the same way
 * `discordServers.remove` already is. What `pages/Shell.tsx` reads on
 * mount (and after an organization switch) so the panel's install state
 * reflects what is actually bound server-side, not only what this browser
 * session happened to install (`beginDiscordInstall`/`completeDiscordInstall`
 * above only ever learn about *this* session's own callback).
 */
export function listDiscordServers(
  organizationId: string
): Promise<DiscordServerBindingSummary[]> {
  return dispatchAction<DiscordServerBindingSummary[]>(
    organizationId,
    'discordServers.list',
    {}
  )
}

/** LINK-7: begin connecting Discord (signing in with Discord) for `organizationId` — returns the authorization URL to send the browser to. */
export function beginDiscordPersonLink(
  organizationId: string
): Promise<PersonLinkBeginResponse> {
  return request<PersonLinkBeginResponse>(
    `/organizations/${organizationId}/person-link/discord/begin`,
    { method: 'POST', body: {} }
  )
}

/** LINK-6/7: spend the OAuth `code` (once) and preview what confirming would do — `state` is not redeemed by this call. */
export function previewDiscordPersonLink(
  organizationId: string,
  input: { code: string; state: string }
): Promise<DiscordPersonLinkPreviewResponse> {
  return request<DiscordPersonLinkPreviewResponse>(
    `/organizations/${organizationId}/person-link/discord/preview`,
    { method: 'POST', body: input }
  )
}

/** LINK-7: redeem `state` — attaches or merges (LINK-4) the identity `previewDiscordPersonLink` already proved. */
export function confirmDiscordPersonLink(
  organizationId: string,
  state: string
): Promise<{ connected: true }> {
  return request<{ connected: true }>(
    `/organizations/${organizationId}/person-link/discord/confirm`,
    { method: 'POST', body: { state } }
  )
}

/** LINK-6/8: preview what redeeming an assistant's own token would do — non-consuming. */
export function previewMcpPersonLink(
  organizationId: string,
  token: string
): Promise<McpPersonLinkPreviewResponse> {
  return request<McpPersonLinkPreviewResponse>(
    `/organizations/${organizationId}/person-link/mcp/preview`,
    { method: 'POST', body: { token } }
  )
}

/** LINK-8: redeem an assistant's own token — attaches or merges (LINK-4) its identity onto this account's own person in `organizationId`. */
export function confirmMcpPersonLink(
  organizationId: string,
  token: string
): Promise<{ connected: true }> {
  return request<{ connected: true }>(
    `/organizations/${organizationId}/person-link/mcp/confirm`,
    { method: 'POST', body: { token } }
  )
}

/**
 * TEN-6: dispatch a registered action — used here for
 * `discordServers.remove`, the same generic
 * `POST /organizations/:organizationId/actions/:name` route every action in
 * `@bloombot/actions` is reachable through (API-1). Not imported from
 * `@bloombot/actions` itself — that package is off-limits to this bundle
 * (PLAT-2) — so the action's name and input are passed as plain strings and
 * an object, the same way any other HTTP client would call this route.
 */
export function dispatchAction<TResult = unknown>(
  organizationId: string,
  actionName: string,
  input: Record<string, unknown>
): Promise<TResult> {
  return request<{ result: TResult }>(
    `/organizations/${organizationId}/actions/${actionName}`,
    { method: 'POST', body: input }
  ).then((response) => response.result)
}

/**
 * WEB-7: the project actions — `projects.list/create/archive/unarchive/rename/duplicate`
 * (PROJ-1, PROJ-2, PROJ-4, PROJ-5, PROJ-6) — each a thin, typed wrapper over
 * `dispatchAction`, the same route every other action goes through. No new
 * route and no new action: these exist only so a caller in `pages/` writes
 * `listProjects(organizationId)` rather than repeating the action's name and
 * input shape at every call site.
 */
export function listProjects(
  organizationId: string,
  includeArchived?: boolean
): Promise<Project[]> {
  return dispatchAction<Project[]>(
    organizationId,
    'projects.list',
    // `exactOptionalPropertyTypes` — only pass `includeArchived` through
    // when the caller actually supplied it, the same discipline
    // `listProjectsAction`'s own execute (`packages/actions`) is written
    // against on the other side of this same call.
    includeArchived !== undefined ? { includeArchived } : {}
  )
}

export function createProject(
  organizationId: string,
  name: string
): Promise<Project> {
  return dispatchAction<Project>(organizationId, 'projects.create', { name })
}

export function archiveProject(
  organizationId: string,
  projectId: string
): Promise<{ archived: boolean }> {
  return dispatchAction(organizationId, 'projects.archive', { projectId })
}

export function unarchiveProject(
  organizationId: string,
  projectId: string
): Promise<Project> {
  return dispatchAction<Project>(organizationId, 'projects.unarchive', {
    projectId,
  })
}

/** PROJ-6/WEB-26: rename a project — the same thin wrapper shape as `archiveProject`/`duplicateProject` above, over `projects.rename`. */
export function renameProject(
  organizationId: string,
  projectId: string,
  name: string
): Promise<Project> {
  return dispatchAction<Project>(organizationId, 'projects.rename', {
    projectId,
    name,
  })
}

/** PROJ-4/D-23: every course the duplicate copies arrives disabled — `DuplicateProjectResult.coursesDisabled` is always `true`, which is what `pages/Projects.tsx` reads to say so. */
export function duplicateProject(
  organizationId: string,
  projectId: string,
  name: string
): Promise<DuplicateProjectResult> {
  return dispatchAction<DuplicateProjectResult>(
    organizationId,
    'projects.duplicate',
    { projectId, name }
  )
}

/** WEB-8: a course's categories and channels as `courses.save` takes them — no `id`, since a save always replaces a course's whole category/channel list rather than diffing it (`repos/courses.ts`'s own comment on `updateCourse`). */
export interface SaveCourseCategoryInput {
  name: string
  channels: { name: string; adminsOnly: boolean }[]
}

/**
 * `courses.save`'s own input (`packages/actions/src/actions/courses.ts`).
 * `id` present means update; absent means create. Every nullable field
 * (`promptId`, `model`, `vectorStoreId`, `maxRequestsPerDay`) follows the
 * same omitted-preserves/explicit-null-clears rule the action itself
 * documents — see `docs/DECISIONS.md` for how `pages/CourseEditor.tsx` maps
 * its form onto this. `instructions` is not a field here at all (WEB-19,
 * D-54) — `courses.save` no longer accepts it, on create or on update, and
 * `saveCourseInstructions` below (`courseInstructions.save`) is the only way
 * to change one, since that is the action that also records who changed it
 * and when (FILE-4).
 */
export interface SaveCourseInput {
  id?: string
  projectId: string
  title: string
  filePrefix: string
  enabled: boolean
  adminsRole: string
  studentsRole: string
  promptId?: string | null
  model?: string | null
  vectorStoreId?: string | null
  maxRequestsPerDay?: number | null
  // TEN-9 — same omitted-preserves/explicit-null-clears rule as the other
  // nullable fields above; validated server-side as an active binding of
  // the caller's own organization (`courses.save`'s own policy).
  discordServerId?: string | null
  categories: SaveCourseCategoryInput[]
}

export function saveCourse(
  organizationId: string,
  input: SaveCourseInput
): Promise<Course> {
  return dispatchAction<Course>(
    organizationId,
    'courses.save',
    // `SaveCourseInput` is already exactly the JSON body `courses.save`
    // expects (its own zod schema accepts nothing else) — this cast is only
    // to satisfy `dispatchAction`'s generic `Record<string, unknown>`
    // parameter, which no interface literal narrower than that structurally
    // satisfies without one.
    input as unknown as Record<string, unknown>
  )
}

export function listCourses(
  organizationId: string,
  projectId: string
): Promise<CourseSummary[]> {
  return dispatchAction<CourseSummary[]>(organizationId, 'courses.list', {
    projectId,
  })
}

export function getCourse(
  organizationId: string,
  courseId: string
): Promise<Course> {
  return dispatchAction<Course>(organizationId, 'courses.get', { courseId })
}

export function enableCourse(
  organizationId: string,
  courseId: string
): Promise<{ enabled: boolean }> {
  return dispatchAction(organizationId, 'courses.enable', { courseId })
}

export function disableCourse(
  organizationId: string,
  courseId: string
): Promise<{ disabled: boolean }> {
  return dispatchAction(organizationId, 'courses.disable', { courseId })
}

/**
 * WEB-19/FILE-4 — a course's instructions, edited as their own versioned
 * record rather than a plain field on `courses.save`: `courseInstructions.save`,
 * `.list` and `.restore`, each a thin wrapper over `dispatchAction` like
 * every other action this file already reaches through. What
 * `components/CourseInstructions.tsx` calls.
 */

/** Save a new revision of a course's instructions, replacing the live text. Returns the course's own bare row (`courses.Course` — no categories or channels, matching `courseInstructions.save`'s own return shape), not the full `Course` a form manages. */
export function saveCourseInstructions(
  organizationId: string,
  courseId: string,
  instructions: string
): Promise<CourseSummary> {
  return dispatchAction<CourseSummary>(
    organizationId,
    'courseInstructions.save',
    {
      courseId,
      instructions,
    }
  )
}

/** Every revision a course has, newest first (FILE-4) — what the history list reads. */
export function listCourseInstructionRevisions(
  organizationId: string,
  courseId: string
): Promise<CourseInstructionRevisionSummary[]> {
  return dispatchAction<CourseInstructionRevisionSummary[]>(
    organizationId,
    'courseInstructions.list',
    { courseId }
  )
}

/** Restore an earlier revision — itself recorded as a new revision (FILE-4): history that can be rewritten is not history. */
export function restoreCourseInstructionRevision(
  organizationId: string,
  revisionId: string
): Promise<CourseSummary> {
  return dispatchAction<CourseSummary>(
    organizationId,
    'courseInstructions.restore',
    { revisionId }
  )
}

/**
 * WEB-18/FILE-1..3 — a course's knowledge files: what it is grounded in
 * (FILE-1), each one's own pending/ready/failed lifecycle (FILE-2), an
 * upload, and a detach. Each a thin wrapper over `dispatchAction`, the same
 * generic action route every other screen in this app already reaches
 * through (`pages/Projects.tsx`'s own module comment already states this
 * convention).
 */

/** FILE-1/FILE-2: a course's own attachments, each with its own status — what `components/CourseAttachments.tsx` reads and polls. */
export function listCourseAttachments(
  organizationId: string,
  courseId: string
): Promise<CourseAttachmentSummary[]> {
  return dispatchAction<CourseAttachmentSummary[]>(
    organizationId,
    'courseAttachments.list',
    { courseId }
  )
}

/**
 * FILE-1: attach a file to a course. The bytes are written and a `pending`
 * row created synchronously by `courseAttachments.attach`'s own action
 * (`packages/actions`'s own module comment) — the provider upload itself
 * runs afterward, as a background job, so this resolves once the upload is
 * *queued*, not once the file is actually grounding answers.
 */
export function attachCourseFile(
  organizationId: string,
  courseId: string,
  input: { filename: string; contentType: string; contentBase64: string }
): Promise<{ attachmentId: string; jobId: string }> {
  return dispatchAction(organizationId, 'courseAttachments.attach', {
    courseId,
    ...input,
  })
}

/**
 * FILE-3: detach a file — reaching the provider and removing the local
 * record both happen in a background job (`courseAttachments.detach`'s own
 * action), so the attachment named here may still appear in
 * `listCourseAttachments` for a moment after this resolves, until that job
 * actually removes it.
 */
export function detachCourseAttachment(
  organizationId: string,
  attachmentId: string
): Promise<{ jobId: string }> {
  return dispatchAction(organizationId, 'courseAttachments.detach', {
    attachmentId,
  })
}

/** SRV-6: request that a course's declared categories and channels be created in its organization's bound Discord server — enqueues a background job and returns immediately; the job itself only runs once `apps/worker` claims it (`docs/RUNNING_LOCALLY.md`'s own "the worker is the one that is easy to forget"). */
export function scaffoldCourseDiscord(
  organizationId: string,
  courseId: string
): Promise<{ jobId: string }> {
  return dispatchAction(organizationId, 'discordServers.scaffold', {
    courseId,
  })
}

/**
 * WEB-20 — a course's join links: issuing one (the secret is the response's
 * own, one-time payload — nothing about it is ever fetched again), the
 * current list (never a secret among them), and revoking one. Each a thin
 * wrapper over `dispatchAction`, the same generic action route every other
 * screen in this app already reaches through.
 */

/** `exactOptionalPropertyTypes` — only sent when the caller actually supplied one, matching `courseJoinLinks.create`'s own optional `expiresAt` (omitted or `null` both mean "no expiry"). */
export function createCourseJoinLink(
  organizationId: string,
  courseId: string,
  expiresAt?: number | null
): Promise<CreatedCourseJoinLink> {
  return dispatchAction<CreatedCourseJoinLink>(
    organizationId,
    'courseJoinLinks.create',
    {
      courseId,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    }
  )
}

/** WEB-20: a course's own join links, newest first — never carries a secret (`courseJoinLinks.list`'s own projection, `@bloombot/actions`). */
export function listCourseJoinLinks(
  organizationId: string,
  courseId: string
): Promise<CourseJoinLinkSummary[]> {
  return dispatchAction<CourseJoinLinkSummary[]>(
    organizationId,
    'courseJoinLinks.list',
    { courseId }
  )
}

/** ENRL-4: revoke a join link — stops it admitting anyone new; never un-enrols anyone it already admitted. */
export function revokeCourseJoinLink(
  organizationId: string,
  linkId: string
): Promise<{ revoked: boolean }> {
  return dispatchAction(organizationId, 'courseJoinLinks.revoke', { linkId })
}

/**
 * ENRL-12: show a live join link's secret again. Refuses — the same
 * `action_refused` `ApiError` every other refusal in this app already
 * throws — for a revoked or expired link, one with nothing encrypted to
 * show, or when this deployment has no encryption key configured at all;
 * `CourseJoinLinkSummary.revealable` is what `components/JoinLinks.tsx`
 * reads to avoid calling this for a link certain to refuse.
 */
export function revealCourseJoinLink(
  organizationId: string,
  linkId: string
): Promise<RevealedCourseJoinLink> {
  return dispatchAction<RevealedCourseJoinLink>(
    organizationId,
    'courseJoinLinks.reveal',
    { linkId }
  )
}

/**
 * FILE-6/MDL-9 — a course's own websites: listing them, adding one (a full
 * URL or a bare domain — `courseWebSources.add`'s own reduction, WEB-31),
 * and removing one. Each a thin wrapper over `dispatchAction`, the same
 * generic action route every other screen in this app already reaches
 * through.
 */

/** FILE-6: a course's own websites — what `components/CourseWebSources.tsx` reads. */
export function listCourseWebSources(
  organizationId: string,
  courseId: string
): Promise<CourseWebSourceSummary[]> {
  return dispatchAction<CourseWebSourceSummary[]>(
    organizationId,
    'courseWebSources.list',
    { courseId }
  )
}

/** FILE-6/WEB-31: add a website to a course — `domain` may be a full URL or a bare domain; `courseWebSources.add` reduces it to the bare form this stores. */
export function addCourseWebSource(
  organizationId: string,
  courseId: string,
  domain: string
): Promise<CourseWebSourceSummary> {
  return dispatchAction<CourseWebSourceSummary>(
    organizationId,
    'courseWebSources.add',
    { courseId, domain }
  )
}

/** FILE-6: remove a website from a course — the course's answers are no longer grounded by it. */
export function removeCourseWebSource(
  organizationId: string,
  webSourceId: string
): Promise<{ removed: boolean }> {
  return dispatchAction(organizationId, 'courseWebSources.remove', {
    webSourceId,
  })
}

/**
 * WEB-22 — a course's own people, active and ended alike, and the two acts
 * an instructor may take on one: end an active enrolment (ENRL-6) or
 * reinstate an ended one (ENRL-9). Thin wrappers over `dispatchAction`, the
 * same shape `createCourseJoinLink`/`listCourseJoinLinks`/
 * `revokeCourseJoinLink` above already use.
 */

/** WEB-22: every enrolment a course has ever had, active and ended alike — `enrolments.listForCourse`'s own projection, `@bloombot/actions`. */
export function listCourseEnrolments(
  organizationId: string,
  courseId: string
): Promise<CourseEnrolment[]> {
  return dispatchAction<CourseEnrolment[]>(
    organizationId,
    'enrolments.listForCourse',
    { courseId }
  )
}

/** ENRL-6: end an enrolment — stops that person asking this course; deletes neither their transcript nor the course's record of what was asked. */
export function endCourseEnrolment(
  organizationId: string,
  enrolmentId: string
): Promise<{ ended: boolean }> {
  return dispatchAction(organizationId, 'enrolments.end', { enrolmentId })
}

/** ENRL-9: reinstate an enrolment an instructor previously ended — restores the access `endCourseEnrolment` removed. A no-op, not an error, on an enrolment that is not currently ended. */
export function reinstateCourseEnrolment(
  organizationId: string,
  enrolmentId: string
): Promise<{ reinstated: boolean }> {
  return dispatchAction(organizationId, 'enrolments.reinstate', {
    enrolmentId,
  })
}

/**
 * WEB-21/ROST-9..12: import a roster CSV into a course — enqueues a
 * background job and returns immediately; the report itself is read back
 * through `getJobStatus`'s own `result`, the same "poll a job id" shape
 * `scaffoldCourseDiscord`/`attachCourseFile` already use.
 */
export function importRoster(
  organizationId: string,
  courseId: string,
  csvText: string
): Promise<{ jobId: string }> {
  return dispatchAction(organizationId, 'roster.import', {
    courseId,
    csvText,
  })
}

/** JOB-1..5: a job's current status and outcome — what a caller polls after dispatching a job-backed action such as `discordServers.scaffold`. */
export function getJobStatus(
  organizationId: string,
  jobId: string
): Promise<JobStatus> {
  return dispatchAction<JobStatus>(organizationId, 'jobs.get', { jobId })
}

/** JOB-2: every job the caller's organization has run, newest activity first — including one that failed permanently in a session this browser never held the id for. `pages/Jobs.tsx` is what calls this. */
export function listJobs(organizationId: string): Promise<JobStatus[]> {
  return dispatchAction<JobStatus[]>(organizationId, 'jobs.list', {})
}

/**
 * COST-3/COST-4 — an instructor's own usage read and their organization's
 * spending cap, each a thin wrapper over `dispatchAction`, the same generic
 * action route every other screen in this app already reaches through.
 * What `pages/Usage.tsx` calls.
 */

/** COST-4: usage cost per course in the caller's own organization, plus which students are approaching a course's own daily limit, for `day` (`YYYY-MM-DD`). */
export function fetchOrganizationUsage(
  organizationId: string,
  day: string
): Promise<OrganizationUsageReport> {
  return dispatchAction<OrganizationUsageReport>(
    organizationId,
    'costLedger.organizationUsage',
    { day }
  )
}

/** COST-3: set the organization's spending cap to `capAmount` (a currency amount, e.g. `12.5` for $12.50 — never micros; `costLedger.setSpendingCap`'s own input schema converts), or clear it entirely with `null`. Only an existing owner may call this — refused (404, `action_refused`) for anyone else. */
export function setSpendingCap(
  organizationId: string,
  capAmount: number | null
): Promise<SetSpendingCapResult> {
  return dispatchAction<SetSpendingCapResult>(
    organizationId,
    'costLedger.setSpendingCap',
    { capAmount }
  )
}

/**
 * ENRL-5 — an owner's own team screen: who already holds a membership role
 * in the caller's organization, and granting one to a second instructor or a
 * teaching assistant. Thin wrappers over `dispatchAction`, the same shape
 * every other pair above already uses. `components/Team.tsx` is what calls
 * these.
 */

/** ENRL-5: every membership role held in the caller's organization — the role, who granted it, and when. Open to any member, not only an owner (`memberships.list`'s own description). */
export function listMemberships(
  organizationId: string
): Promise<OrganizationMembership[]> {
  return dispatchAction<OrganizationMembership[]>(
    organizationId,
    'memberships.list',
    {}
  )
}

/** ENRL-5: grant `role` to the account already in this organization under `email` — never on the caller's own account, and only an existing owner may call this (refused, 404, `action_refused`, for anyone else — the same not-found shape every other refusal in this app takes). */
export function grantMembership(
  organizationId: string,
  email: string,
  role: 'owner' | 'instructor' | 'assistant'
): Promise<GrantMembershipResult> {
  return dispatchAction<GrantMembershipResult>(
    organizationId,
    'memberships.grant',
    { email, role }
  )
}

/**
 * ENRL-11: revoke the membership held by `accountId` — only an existing
 * owner may call this; an owner's own membership may only ever be revoked
 * by that owner stepping down, never by a peer; and the organization's
 * last owner can never be revoked (refused, 404, `action_refused`,
 * identically to every other refusal this action can give — see
 * `memberships.revoke`'s own description).
 */
export function revokeMembership(
  organizationId: string,
  accountId: string
): Promise<{ revoked: boolean }> {
  return dispatchAction(organizationId, 'memberships.revoke', { accountId })
}

/**
 * ENRL-10 — inviting a colleague who is not yet in the organization: issuing
 * an invitation (the secret is the response's own, one-time payload —
 * nothing about it is ever fetched again), the outstanding list (never a
 * secret among them), and revoking one. Each a thin wrapper over
 * `dispatchAction`, the same route every other action in this app already
 * reaches through — only an existing owner may call any of the three
 * (`membership-invitations.ts`'s own module comment on why `.list` is
 * owner-only here, unlike `memberships.list` above).
 */

/** `exactOptionalPropertyTypes` — only sent when the caller actually supplied one, matching `createCourseJoinLink`'s own optional `expiresAt`. */
export function createMembershipInvitation(
  organizationId: string,
  email: string,
  role: 'owner' | 'instructor' | 'assistant',
  expiresAt?: number | null
): Promise<CreatedMembershipInvitation> {
  return dispatchAction<CreatedMembershipInvitation>(
    organizationId,
    'membershipInvitations.create',
    {
      email,
      role,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    }
  )
}

/** ENRL-10: every invitation the caller's organization has ever issued, newest first — never a secret among them. */
export function listMembershipInvitations(
  organizationId: string
): Promise<MembershipInvitation[]> {
  return dispatchAction<MembershipInvitation[]>(
    organizationId,
    'membershipInvitations.list',
    {}
  )
}

/** ENRL-10: revoke an invitation — stops it admitting anyone, ever again. */
export function revokeMembershipInvitation(
  organizationId: string,
  invitationId: string
): Promise<{ revoked: boolean }> {
  return dispatchAction(organizationId, 'membershipInvitations.revoke', {
    invitationId,
  })
}

/**
 * ENRL-10: redeem an invitation, bound to the caller's own signed-in
 * session — `apps/api`'s own `routes/membership-invitations.ts` never
 * accepts anything beyond the secret itself in the request body. Throws
 * `ApiError` (404, `membership_invitation_not_found`) identically for a
 * secret that was never issued, one that is revoked, one that has expired,
 * one that was already redeemed, one whose account email does not match the
 * invited address, and one for an account that already holds a membership
 * in that organization — never a different status or message across any of
 * the six.
 */
export function redeemMembershipInvitation(
  secret: string
): Promise<{ organizationId: string; role: string }> {
  return request<{ organizationId: string; role: string }>(
    '/membership-invitations/redeem',
    { method: 'POST', body: { secret } }
  )
}

/**
 * WEB-10: the web chat surface — `routes/chat.ts` in `apps/api`, mounted
 * under `/organizations/:organizationId/chat`, not the generic action
 * dispatcher (that route's own module comment says why: ENRL-2's
 * enrolment, not a membership, is what authorizes each of these).
 */

/** The courses this signed-in account may currently ask, in `organizationId` — its own active enrolments (ENRL-1, ENRL-2), and no others. */
export function listChatCourses(organizationId: string): Promise<ChatCourse[]> {
  return request<{ courses: ChatCourse[] }>(
    `/organizations/${organizationId}/chat/courses`
  ).then((response) => response.courses)
}

/** This account's own transcript with one course. Throws `ApiError` (404, `chat_course_not_found`) exactly like any other unauthorized read when it is not enrolled (ENRL-2, TEN-5). */
export function getChatMessages(
  organizationId: string,
  courseId: string
): Promise<ChatMessageEntry[]> {
  return request<{ messages: ChatMessageEntry[] }>(
    `/organizations/${organizationId}/chat/courses/${courseId}/messages`
  ).then((response) => response.messages)
}

/** Ask a question, through the exact same `answerQuestion` pipeline the Discord surface calls. */
export function postChatMessage(
  organizationId: string,
  courseId: string,
  text: string
): Promise<ChatAnswerResult> {
  return request<{ result: ChatAnswerResult }>(
    `/organizations/${organizationId}/chat/courses/${courseId}/messages`,
    { method: 'POST', body: { text } }
  ).then((response) => response.result)
}

/**
 * ADMIN-1..3 — the transcript screen's own reads and writes, each a thin
 * wrapper over `dispatchAction`, the same generic action route every
 * other screen in this app already reaches through (no new route, no new
 * action, `pages/Projects.tsx`'s own module comment already states this
 * convention).
 */

export interface TranscriptFilters {
  personId?: string
  /** Inclusive bounds, epoch milliseconds — a date-only picker in `pages/Transcripts.tsx` converts a calendar day into these before calling through here. */
  startAt?: number
  endAt?: number
}

function filtersToInput(filters: TranscriptFilters): Record<string, unknown> {
  return {
    ...(filters.personId !== undefined ? { personId: filters.personId } : {}),
    ...(filters.startAt !== undefined ? { startAt: filters.startAt } : {}),
    ...(filters.endAt !== undefined ? { endAt: filters.endAt } : {}),
  }
}

/** ADMIN-1: read a course's transcript, optionally filtered by student and by date. */
export function readTranscript(
  organizationId: string,
  courseId: string,
  filters: TranscriptFilters = {}
): Promise<TranscriptReadResult> {
  return dispatchAction<TranscriptReadResult>(
    organizationId,
    'transcripts.read',
    {
      courseId,
      ...filtersToInput(filters),
    }
  )
}

/** ADMIN-1's own student filter. */
export function listTranscriptStudents(
  organizationId: string,
  courseId: string
): Promise<TranscriptStudent[]> {
  return dispatchAction<TranscriptStudent[]>(
    organizationId,
    'transcripts.listStudents',
    { courseId }
  )
}

/** ADMIN-3: request an export, produced by a background job (JOB-1). */
export function exportTranscript(
  organizationId: string,
  courseId: string,
  filters: TranscriptFilters = {}
): Promise<{ exportId: string; jobId: string }> {
  return dispatchAction(organizationId, 'transcripts.export', {
    courseId,
    ...filtersToInput(filters),
  })
}

/** ADMIN-3's own "collect the file when it is ready": every export a course has requested, with its current status. */
export function listTranscriptExports(
  organizationId: string,
  courseId: string
): Promise<TranscriptExport[]> {
  return dispatchAction<TranscriptExport[]>(
    organizationId,
    'transcripts.listExports',
    { courseId }
  )
}

/** ADMIN-2: a course's transcript-access audit trail, most recent first — who read or exported whose conversation, and when. Only an existing owner may call this (refused, 404, `action_refused`, for anyone else — the same not-found shape every other refusal in this app takes). */
export function listTranscriptAccessLog(
  organizationId: string,
  courseId: string
): Promise<TranscriptAccessLogEntry[]> {
  return dispatchAction<TranscriptAccessLogEntry[]>(
    organizationId,
    'transcripts.listAccessLog',
    { courseId }
  )
}

/** ADMIN-3 — the URL a "Download" link points at once an export's own status is `ready` (`routes/transcript-exports.ts`, not the generic action route: a download is a binary response, not a JSON envelope). */
export function transcriptExportDownloadUrl(
  organizationId: string,
  exportId: string
): string {
  return `/organizations/${organizationId}/transcript-exports/${exportId}/download`
}

/**
 * ADMIN-4/ADMIN-5 — the platform-administrator console's own reads and
 * writes. Mounted at `/admin`, not under `/organizations/:organizationId/...`
 * (`apps/api`'s own `routes/admin.ts` module comment has why) — these call
 * `request` directly rather than `dispatchAction`, the same way
 * `fetchMe`/`requestSignInLink` do for the same reason: neither is an
 * action reached through one organization's own dispatch.
 */

/** ADMIN-4: every organization, its usage, and the platform's own health. Throws `ApiError` (403, `not_platform_administrator`) for a signed-in caller who is not one (AUTH-4) — this app shows that refusal plainly rather than hiding the screen, since hiding it would be the panel deciding on AUTH-4's behalf who may even attempt this. */
export function fetchAdminOrganizations(): Promise<AdminOrganizationsResponse> {
  return request<AdminOrganizationsResponse>('/admin/organizations')
}

/** ADMIN-5's own "names exactly what will be deleted before it happens". */
export function fetchDeletionPreview(
  organizationId: string
): Promise<OrganizationDeletionPreview> {
  return request<OrganizationDeletionPreview>(
    `/admin/organizations/${organizationId}/deletion-preview`
  )
}

/** ADMIN-5: delete a tenant's data — `confirmName` must equal the organization's own name exactly (checked server-side, `routes/admin.ts`'s own module comment on why this app must not be the only place that checks it). Throws `ApiError` (409, `confirmation_name_mismatch`) on a mismatch. */
export function deleteTenant(
  organizationId: string,
  confirmName: string
): Promise<{ deleted: true }> {
  return request(`/admin/organizations/${organizationId}/delete`, {
    method: 'POST',
    body: { confirmName },
  })
}

/** ADMIN-5's own audit trail, read back. */
export function fetchTenantDeletions(): Promise<TenantDeletion[]> {
  return request<{ deletions: TenantDeletion[] }>(
    '/admin/tenant-deletions'
  ).then((response) => response.deletions)
}
