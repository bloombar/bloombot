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
  ApiErrorBody,
  ChatAnswerResult,
  ChatCourse,
  ChatMessageEntry,
  Course,
  CourseSummary,
  DuplicateProjectResult,
  InstallBeginResponse,
  InstallCallbackResponse,
  JobStatus,
  MeResponse,
  Project,
  SignedInResponse,
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

/** AUTH-1: request a sign-in link. Always resolves — the API answers the same way whether or not the address has an account. */
export function requestSignInLink(email: string): Promise<void> {
  return request<void>('/auth/request-link', {
    method: 'POST',
    body: { email },
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
 * WEB-7: the project actions — `projects.list/create/archive/unarchive/duplicate`
 * (PROJ-1, PROJ-2, PROJ-4, PROJ-5) — each a thin, typed wrapper over
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
 * (`promptId`, `instructions`, `model`, `vectorStoreId`,
 * `maxRequestsPerDay`) follows the same omitted-preserves/explicit-null-
 * clears rule the action itself documents — see `docs/DECISIONS.md` for how
 * `pages/CourseEditor.tsx` maps its form onto this.
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
  instructions?: string | null
  model?: string | null
  vectorStoreId?: string | null
  maxRequestsPerDay?: number | null
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

/** SRV-6: request that a course's declared categories and channels be created in its organization's bound Discord server — enqueues a background job and returns immediately; the job itself only runs once `apps/worker` claims it (`docs/RUNNING_LOCALLY.md`'s own "the worker is the one that is easy to forget"). */
export function scaffoldCourseDiscord(
  organizationId: string,
  courseId: string
): Promise<{ jobId: string }> {
  return dispatchAction(organizationId, 'discordServers.scaffold', {
    courseId,
  })
}

/** JOB-1..5: a job's current status and outcome — what a caller polls after dispatching a job-backed action such as `discordServers.scaffold`. */
export function getJobStatus(
  organizationId: string,
  jobId: string
): Promise<JobStatus> {
  return dispatchAction<JobStatus>(organizationId, 'jobs.get', { jobId })
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
