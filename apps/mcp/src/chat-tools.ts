/**
 * MCP-8: the two tools that let a connected MCP client ask a course's
 * assistant a question — the same `answerQuestion` pipeline (`@bloombot/core`)
 * `apps/api/src/routes/chat.ts` (WEB-10) and `@bloombot/discord`'s own
 * `handle-mention.ts` already call, under **exactly** the same admission
 * rules (ENRL-15/16's `resolveChatAdmission`/`listChatAdmittedCourses` —
 * called here, not reimplemented, for the identical reason `routes/chat.ts`'s
 * own module comment gives: three surfaces disagreeing about who may ask is
 * the class of bug ENRL-16 existed to fix).
 *
 * **Why this file, and not another `tool-surface.ts` entry dispatched through
 * `call-tool.ts#callTool`.** Every existing tool on `MCP_TOOL_SURFACE` names
 * one `organizationId` and dispatches through `@bloombot/actions#dispatch`,
 * whose own `DispatchContext` is scoped to exactly one organization per call
 * — the same shape `call-tool.ts`'s own `organizationIdSchema` requires
 * before anything else runs. Neither tool here fits that shape at all:
 * listing (below) is explicitly cross-organization by design (MCP-7's own
 * "account-wide" link is the point of it — a course in an organization this
 * account was never even told about by name), and asking takes an *optional*
 * `courseId` with no `organizationId` alongside it — the organization a
 * course belongs to is resolved from the course itself, not named by the
 * caller, so a wrong guess never leaks which organization a refused or
 * hallucinated id would have belonged to (see `resolveAdmittedCourse`,
 * below). Bending `dispatch`'s single-organization contract to fit either
 * shape would cost more than it saves. This is the same judgement call
 * `server.ts`'s own `registerPersonLinkTool` (LINK-8) already made for a
 * tool whose own shape does not fit the allowlist either — a tool that
 * genuinely does not have "an organization named by the caller" as an input
 * is not shaped like the rest of the surface, and pretending otherwise is
 * the wrong fix.
 *
 * **Authorization — the one rule this file exists to hold to.**
 * `call-tool.ts`'s own membership gate (`memberships.getMembership` —
 * MCP-3's tenancy boundary for the *action* catalog) refuses an account with
 * no membership outright, which is correct for that catalog — entirely
 * instructor-side course administration — and would be wrong here: a
 * student reachable only through a connected identity and an enrolment has
 * no membership at all. This file never calls that gate, and never
 * reimplements it either: every function below authorizes through
 * `enrolments.resolveChatAdmission`/`listChatAdmittedCourses` alone, called
 * fresh, per course, at call time — nothing here trusts a `courseId` or an
 * admission decision cached from a moment earlier the way `MCP_TOOL_SURFACE`
 * entries never have to re-derive a stale membership either (`authenticate.ts`'s
 * own module comment on the identical discipline for that catalog).
 */

import {
  courses,
  enrolments,
  organizations,
  people,
  projects,
  type Database,
} from '@bloombot/db'
import {
  answerQuestion,
  type AnswerResult,
  type ModelClient,
  type PricingTable,
} from '@bloombot/core'
import type { AdmissionGate } from '@bloombot/jobs'
import type { Logger } from '@bloombot/logger'

/** Everything the two tools below need beyond the database and the calling account — the same three answering seams `routes/chat.ts`'s own `ChatRouterDependencies` threads through to `answerQuestion`, plus the one this file adds (`db`). */
export interface ChatToolDependencies {
  db: Database
  model: ModelClient
  logger: Logger
  admission?: AdmissionGate
  pricing?: PricingTable
}

/** `YYYY-MM-DD`, in this process's own local time zone — duplicated from `routes/chat.ts`'s own identical helper rather than imported across the app/app boundary this repo does not cross for a five-line helper neither app owns (that file's own module comment gives the same reasoning `apps/worker`'s `roster-import.ts` already follows). */
function today(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** CORE-7/CORE-8, duplicated from `routes/chat.ts`'s own `addressPersonForWeb` for the same reason `today` above is: an MCP conversation is one account's own conversation with a course's assistant, the same one-to-one shape the web chat has and Discord's own room-full-of-people mention token does not — so the identical fallback order applies verbatim. */
function addressPersonForMcp(person: people.Person): string | null {
  return person.firstName ?? person.displayName ?? null
}

/**
 * One organization this account has a **connected person** in — the base
 * reachability set for both tools below, and deliberately *not* widened to
 * "every organization this account holds a membership in" even though
 * `resolveChatAdmission`/`listChatAdmittedCourses` both also consult
 * membership (for the `owner`/settings-based paths): `routes/chat.ts`'s own
 * `resolveConnectedCallerPerson` refuses an organization outright when this
 * account has no connected person there, *before* admission is ever
 * consulted — including for its own organization's `owner`
 * (`chat.test.ts`'s own "ENRL-15: this organization's owner … " scenario
 * connects a fresh person for exactly this reason). Every admission path
 * `resolveChatAdmission` can grant still needs a `personId` to resolve an
 * enrolment against or to record a message against
 * (`answerQuestion`'s own `personId`), and the only `personId` this file
 * ever has *proof* of — proof being exactly what LINK-3/LINK-1 ask of every
 * surface — is one `people.listConnectedOrganizationsForAccount` already
 * reports; a membership with no connected person in that organization is
 * not reachable here for the identical "not-connected" reason `routes/chat.ts`
 * already refuses it for, not a narrower rule invented for this surface.
 */
function reachableOrganizations(
  accountId: string,
  db: Database
): people.ConnectedOrganization[] {
  return people.listConnectedOrganizationsForAccount(accountId, db)
}

/** One course a caller may ask in — enough to disambiguate by (this file's own module comment on why never the organization: "a person picking a course thinks in projects and courses"). */
export interface CourseChoice {
  courseId: string
  courseTitle: string
  projectName: string
}

/** One course a caller may ask in, across every organization it is reachable in — `chat.listCourses`'s own output, which *does* name the organization (unlike `CourseChoice` above): "for each: the organization, the project, the course" is this slice's own brief. */
export interface AdmittedCourseSummary extends CourseChoice {
  organizationId: string
  organizationName: string
  projectId: string
}

/** Where `courseId`/`organizationId`/`personId` line up for one admitted course — the shape both `listAskableCourses` and `resolveAdmittedCourse` build internally, before either reduces it to what its own caller actually needs. */
interface ResolvedAdmission {
  organizationId: string
  personId: string
  courseId: string
  course: courses.Course
}

/** Every course `accountId` may currently chat in, across every organization it is reachable in (this file's own module comment on `reachableOrganizations`) — the one place both tools below build that list, so `chat.listCourses`'s own output and `chat.ask`'s own disambiguation can never drift apart (mirroring `routes/chat.ts`'s own single `resolveChatAdmission`/`listChatAdmittedCourses` call sites for the identical reason). */
function listAdmittedCourses(
  accountId: string,
  db: Database
): ResolvedAdmission[] {
  const resolved: ResolvedAdmission[] = []
  for (const { organizationId, personId } of reachableOrganizations(
    accountId,
    db
  )) {
    const admitted = enrolments.listChatAdmittedCourses(
      organizationId,
      { personId, accountId },
      db
    )
    for (const course of admitted) {
      resolved.push({ organizationId, personId, courseId: course.id, course })
    }
  }
  return resolved
}

function toCourseChoice(
  resolved: ResolvedAdmission,
  db: Database
): CourseChoice {
  const project = projects.getProject(
    resolved.organizationId,
    resolved.course.projectId,
    db
  )
  return {
    courseId: resolved.courseId,
    courseTitle: resolved.course.title,
    projectName: project?.name ?? '(unknown project)',
  }
}

/** `chat.listCourses` — every course this account may currently ask in, across every organization (MCP-7's account-wide link is what makes "across every organization" the point of this tool, not a scoping bug), naming the organization, the project and the course for each, and only what `listChatAdmittedCourses` actually admits (this file's own module comment: never a directory of everything). */
export function listAskableCourses(
  accountId: string,
  db: Database
): AdmittedCourseSummary[] {
  const resolved = listAdmittedCourses(accountId, db)
  // One `getOrganizationById`/`getProject` per distinct organization/project,
  // not per admitted course — a rework finding: an earlier version called
  // `getOrganizationById` once per course, which for one organization with
  // several admitted courses repeated the identical lookup once per course
  // rather than once for the organization.
  const organizationNames = new Map<string, string>()
  const projectNames = new Map<string, string>()
  return resolved.map((entry) => {
    let organizationName = organizationNames.get(entry.organizationId)
    if (organizationName === undefined) {
      organizationName =
        organizations.getOrganizationById(entry.organizationId, db)?.name ??
        '(unknown organization)'
      organizationNames.set(entry.organizationId, organizationName)
    }
    const projectKey = `${entry.organizationId}:${entry.course.projectId}`
    let projectName = projectNames.get(projectKey)
    if (projectName === undefined) {
      projectName =
        projects.getProject(entry.organizationId, entry.course.projectId, db)
          ?.name ?? '(unknown project)'
      projectNames.set(projectKey, projectName)
    }
    return {
      courseId: entry.courseId,
      courseTitle: entry.course.title,
      projectName,
      organizationId: entry.organizationId,
      organizationName,
      projectId: entry.course.projectId,
    }
  })
}

/** Whether `accountId` has a connected person in *any* organization — both tools refuse the identical way when this is `false` (`askChatQuestion`'s own `unlinked` kind; `server.ts#registerChatTools`' own list handler calls this directly, since `listAskableCourses` alone cannot distinguish "linked, but admitted to nothing" from "never linked at all"). */
export function isAccountLinked(accountId: string, db: Database): boolean {
  return reachableOrganizations(accountId, db).length > 0
}

/** `chat.ask`'s own input — `courseId` is optional (this slice's own brief: "omitting the id is fine when the person has one course"); `text` is bounded the identical way `routes/chat.ts`'s own `postMessageInputSchema` bounds it (WEB-10 rework, finding 7 — bounded, not just non-empty), duplicated here rather than imported for the same app/app-boundary reason `today`/`addressPersonForMcp` above are. */
export const ASK_TEXT_MAX_LENGTH = 4000

export interface AskChatQuestionInput {
  courseId?: string
  text: string
}

/**
 * Resolves which reachable course `input.courseId` names, calling
 * `resolveChatAdmission` **fresh, per course** (never trusting
 * `listAdmittedCourses`'s own snapshot for the actual admission decision —
 * this file's own module comment on why) for every organization this
 * account is reachable in, stopping at the first one that does not refuse.
 * Course ids are `crypto.randomUUID()`-generated per `createCourse`
 * (`packages/db/src/repos/courses.ts`) and scoped to one organization each,
 * so at most one reachable organization can ever resolve a genuine match;
 * `undefined` when none does — a refused course and a nonexistent one are
 * deliberately indistinguishable here, both to this function's own caller
 * and (below) to whatever an MCP client is shown, matching the identical
 * "does not leak whether a foreign record exists" guarantee `call-tool.ts`'s
 * own module comment already holds the action catalog to (TEN-5).
 */
function resolveAdmittedCourse(
  accountId: string,
  courseId: string,
  db: Database
): ResolvedAdmission | undefined {
  for (const { organizationId, personId } of reachableOrganizations(
    accountId,
    db
  )) {
    const admission = enrolments.resolveChatAdmission(
      organizationId,
      courseId,
      { personId, accountId },
      db
    )
    if (admission.kind === 'refused') continue
    const course = courses.getCourse(organizationId, courseId, db)
    // `resolveChatAdmission` already re-read the course itself to decide
    // `admission.kind`, so a non-refusal here means it exists and is
    // enabled in this organization — guarded rather than assumed regardless
    // (this file's own module comment's own discipline), since this
    // function's own caller needs the row itself, not only the verdict.
    if (!course) continue
    return { organizationId, personId, courseId, course }
  }
  return undefined
}

/**
 * The record a self-enrolment write commits, threaded through so the caller
 * (`askChatQuestion`, below) can tell a genuine decline (refuse the
 * question) apart from a transient write failure that must not block the
 * reply — `routes/chat.ts`'s own identical split, for the identical reason
 * (its own module comment on `enrolViaSelfEnrolment`'s return value).
 */
function admitSelfEnrolmentOrDecline(
  resolved: ResolvedAdmission,
  accountId: string,
  db: Database,
  logger: Logger
): 'admitted' | 'declined' {
  try {
    const enrolment = enrolments.enrolViaSelfEnrolment(
      resolved.organizationId,
      { courseId: resolved.courseId, personId: resolved.personId },
      db
    )
    return enrolment ? 'admitted' : 'declined'
  } catch (error) {
    // A *thrown* error — an unexpected database failure, not the ordinary
    // decline just above — is logged and does not block the reply, the
    // identical treatment `routes/chat.ts`'s own module comment describes
    // for the same write.
    logger.error(
      {
        err: error,
        organizationId: resolved.organizationId,
        courseId: resolved.courseId,
        personId: resolved.personId,
        accountId,
      },
      'apps/mcp: failed to record a self-enrolment admission'
    )
    return 'admitted'
  }
}

/** `chat.ask`'s own result — every `AnswerResult` kind `@bloombot/core#answerQuestion` can produce (this slice's own brief: "do not silently drop parts of it"), plus the two refusals specific to this surface: no connected identity anywhere, or no single course to answer in without more from the caller. Every kind that names a real, resolved course carries `course` (this slice's own brief: "every answer must name the course it came from" — the project too, never the organization, for the identical "noise they did not ask for" reason `needsCourseSelection`'s own `choices` omit it). */
export type AskChatResult =
  | { kind: 'unlinked' }
  | {
      kind: 'needs-course-selection'
      reason: 'no-course-id' | 'not-admitted' | 'none-admitted'
      choices: CourseChoice[]
    }
  | ({ course: CourseChoice } & AnswerResult)

/**
 * `chat.ask`: resolve which course is meant (this slice's own brief has the
 * full decision tree — one admitted course and no id answers it directly;
 * several and no id, or an id that does not resolve, both refuse with the
 * same disambiguating listing rather than guessing or leaking which course
 * exists), enrol on self-enrolment admission exactly as `routes/chat.ts`
 * does (honouring the write's own return value), then answer through
 * `answerQuestion` — the same pipeline, the same metering (MCP-5), attributed
 * to this account.
 */
export async function askChatQuestion(
  accountId: string,
  input: AskChatQuestionInput,
  deps: ChatToolDependencies
): Promise<AskChatResult> {
  const reachable = reachableOrganizations(accountId, deps.db)
  if (reachable.length === 0) {
    // MCP-7's connect tool (`bloombot_connectAssistant`, `server.ts`) is
    // named in the text this result's own caller (`server.ts`'s own tool
    // registration) surfaces to the model — this file only reports the
    // refusal kind, not the wording, the same split every other refusal
    // kind below already leaves to its own caller.
    return { kind: 'unlinked' }
  }

  let resolved: ResolvedAdmission | undefined
  let reason: 'no-course-id' | 'not-admitted' | undefined
  // Computed here, not unconditionally: the "omitted courseId" branch needs
  // the full list regardless (to tell "exactly one" from "several" apart),
  // but the "given courseId" branch resolves it directly, at the cost of one
  // targeted `resolveChatAdmission` per reachable organization
  // (`resolveAdmittedCourse`, below) rather than every admitted course in
  // every one of them. Kept around (rather than discarded once `resolved`
  // is known) so the refusal just below reuses it instead of a second,
  // identical query — a rework finding: an earlier version called
  // `listAdmittedCourses` again here even when this branch had just built
  // it, doubling the cost of the single most common refusal (no id, more
  // than one course admitted).
  let admitted: ResolvedAdmission[] | undefined
  if (input.courseId === undefined) {
    admitted = listAdmittedCourses(accountId, deps.db)
    if (admitted.length === 1) {
      resolved = admitted[0]
    } else {
      reason = 'no-course-id'
    }
  } else {
    resolved = resolveAdmittedCourse(accountId, input.courseId, deps.db)
    if (!resolved) reason = 'not-admitted'
  }

  if (!resolved) {
    const choices = (admitted ?? listAdmittedCourses(accountId, deps.db)).map(
      (r) => toCourseChoice(r, deps.db)
    )
    return {
      kind: 'needs-course-selection',
      reason:
        choices.length === 0 ? 'none-admitted' : (reason ?? 'no-course-id'),
      choices,
    }
  }

  // Fresh, per-course, at call time — never the admission `listAdmittedCourses`
  // or `resolveAdmittedCourse` already happened to observe a moment earlier
  // (this file's own module comment on why).
  const admission = enrolments.resolveChatAdmission(
    resolved.organizationId,
    resolved.courseId,
    { personId: resolved.personId, accountId },
    deps.db
  )
  if (admission.kind === 'refused') {
    const choices = listAdmittedCourses(accountId, deps.db).map((r) =>
      toCourseChoice(r, deps.db)
    )
    return { kind: 'needs-course-selection', reason: 'not-admitted', choices }
  }

  if (admission.kind === 'self-enrol') {
    const outcome = admitSelfEnrolmentOrDecline(
      resolved,
      accountId,
      deps.db,
      deps.logger
    )
    if (outcome === 'declined') {
      const choices = listAdmittedCourses(accountId, deps.db).map((r) =>
        toCourseChoice(r, deps.db)
      )
      return { kind: 'needs-course-selection', reason: 'not-admitted', choices }
    }
  }

  const result = await answerQuestion(
    {
      organizationId: resolved.organizationId,
      courseId: resolved.courseId,
      personId: resolved.personId,
      surface: 'mcp',
      text: input.text,
      day: today(),
    },
    {
      db: deps.db,
      model: deps.model,
      logger: deps.logger,
      addressPerson: addressPersonForMcp,
      ...(deps.admission ? { admission: deps.admission } : {}),
      ...(deps.pricing ? { pricing: deps.pricing } : {}),
    }
  )

  return { course: toCourseChoice(resolved, deps.db), ...result }
}
