/**
 * MCP-9: the tool that answers "which courses does this account administer,
 * and where" — the administrative counterpart to MCP-8's `chat.listCourses`
 * (`chat-tools.ts`). That tool answers "what may this account *ask*",
 * scoped to a connected person and an admission predicate; this one answers
 * "what may this account *configure*", scoped to a membership. The two are
 * deliberately separate concepts (MCP-9's own SPEC text: "being enrolled in
 * a course is not authority to configure it"), so an account reachable only
 * through a connected identity and an enrolment can appear in
 * `chat.listCourses`'s own output while never appearing in this one's.
 *
 * **Why this file, and not another `tool-surface.ts` entry dispatched
 * through `call-tool.ts#callTool`.** The same reasoning `chat-tools.ts`'s
 * own module comment gives for `chat.listCourses` applies here verbatim:
 * every entry on `MCP_TOOL_SURFACE` dispatches one `organizationId`-scoped
 * action through `@bloombot/actions#dispatch`, whose own `DispatchContext`
 * is scoped to exactly one organization per call — the same shape
 * `call-tool.ts`'s own `organizationIdSchema` requires before anything else
 * runs. This tool is explicitly cross-organization by design: every other
 * tool on the surface takes an `organizationId` named by the caller (MCP-3),
 * and this is the one place an assistant can learn what those ids even are,
 * so it cannot itself already require one as an input. Bending `dispatch`'s
 * single-organization contract to fit that shape would cost more than it
 * saves — the identical judgement call `chat-tools.ts` and `server.ts`'s own
 * `registerPersonLinkTool` (LINK-8) already made for tools whose own shape
 * does not fit the allowlist either.
 *
 * **Authority is membership, per organization, checked at call time — the
 * same rule the panel enforces, never a weaker one** (MCP-9's own SPEC
 * text). `call-tool.ts`'s own membership gate (`memberships.getMembership`)
 * already refuses an account with no active membership outright before
 * dispatching any tool on `MCP_TOOL_SURFACE`; this file holds every course
 * it lists to the identical standard (`memberships.listMembershipsForAccount`,
 * which excludes a revoked membership the same way `getMembership` does —
 * see that repo's own module comment), just gathered across every
 * organization at once instead of the one `call-tool.ts` already has in
 * hand by the time it checks.
 *
 * **Which roles count as "administers".** Every `MembershipRole` — `owner`,
 * `instructor` and `assistant` alike. Nothing this platform actually gates
 * course configuration on today distinguishes a role beyond "does an active
 * membership exist": `call-tool.ts`'s own gate does not look at `.role` at
 * all before letting any tool on `MCP_TOOL_SURFACE` through (an `assistant`
 * can already dispatch `courses.save` or `courseChannels.removeCategory`
 * through this same MCP server), and `apps/web/src/api/types.ts`'s own
 * `MembershipSummary` doc comment describes any of the three roles as "the
 * administrative authority a membership role names" — in contrast with a
 * merely-connected person, who holds none. Narrowing this listing to a
 * subset of roles would invent a stricter notion of "administers" than this
 * platform holds anywhere else it actually checks; see `docs/DECISIONS.md`
 * D-110 for the fuller record of this call.
 *
 * An account with no active membership anywhere gets an empty list here —
 * never an error, and never a hint that a foreign organization exists (the
 * same TEN-5 "not-found rather than a different refusal" shape, applied to
 * an entire organization rather than one record inside it).
 */

import {
  courses,
  memberships,
  organizations,
  projects,
  type Database,
} from '@bloombot/db'

/** One course this account administers, named the way an assistant needs to act on it elsewhere on the tool surface — every other tool on `MCP_TOOL_SURFACE` takes an `organizationId` (MCP-3), so this is the one place that id (and the project id beside it) is discoverable at all. */
export interface AdministeredCourseSummary {
  organizationId: string
  organizationName: string
  projectId: string
  projectName: string
  courseId: string
  courseTitle: string
}

/**
 * `courses.listAdministered`: every course, in every unarchived project, of
 * every organization `accountId` holds an active membership in — this
 * file's own module comment has the full authority rule. Archived projects
 * are excluded, matching `projects.listProjects`'s own default (the same one
 * `projects.list`'s action already uses): a course this account can no
 * longer reach through the panel either should not be handed to an
 * assistant as something to configure.
 */
export function listAdministeredCourses(
  accountId: string,
  db: Database
): AdministeredCourseSummary[] {
  const summaries: AdministeredCourseSummary[] = []
  // Every `MembershipRole` counts (this file's own module comment on why) —
  // no filter on `.role` here at all.
  for (const membership of memberships.listMembershipsForAccount(
    accountId,
    db
  )) {
    const organization = organizations.getOrganizationById(
      membership.organizationId,
      db
    )
    // Guarded rather than assumed: a membership row naming an organization
    // that somehow no longer resolves would otherwise throw for one bad row
    // rather than simply being omitted from this list — the same defensive
    // read `chat-tools.ts#listAskableCourses` already gives its own lookups.
    if (!organization) continue
    for (const project of projects.listProjects(
      membership.organizationId,
      db
    )) {
      for (const course of courses.listCourses(membership.organizationId, db, {
        projectId: project.id,
      })) {
        summaries.push({
          organizationId: membership.organizationId,
          organizationName: organization.name,
          projectId: project.id,
          projectName: project.name,
          courseId: course.id,
          courseTitle: course.title,
        })
      }
    }
  }
  return summaries
}
