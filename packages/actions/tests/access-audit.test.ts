/**
 * ACT-5's access audit index: every registered action, pinned to its own
 * declared descriptor here — a table a reviewer reads, not just the type
 * system. Weakening a guard (e.g. `access: 'write'` softened to `'read'`)
 * still type-checks; it shows up here as a one-line diff against
 * `EXPECTED_DESCRIPTORS`, and this test fails until that diff is made.
 * Registering a new action without adding its row here fails the first
 * assertion below.
 *
 * No action in this slice authorizes itself by exception — every `resolve`
 * below is a real tenant-scoped lookup — so there is nothing to record for
 * that case yet; the day one exists, its reason belongs in a comment on its
 * row in `EXPECTED_DESCRIPTORS`.
 */

import { describe, expect, it } from 'vitest'

import { createPlatformRegistry } from '../src/actions/index.js'
import type { AccessDescriptor } from '../src/policy.js'

const EXPECTED_DESCRIPTORS: Record<string, AccessDescriptor> = {
  // No existing project to resolve on create — the record it protects is
  // the organization a new project is created inside (`actions/projects.ts`).
  'projects.create': { resource: 'organization', access: 'write' },
  'projects.archive': { resource: 'project', access: 'write' },
  'projects.unarchive': { resource: 'project', access: 'write' },
  // PROJ-6: resolves the project being renamed, the same `resolveOwnProject`
  // shape `projects.archive`/`projects.unarchive` already use above.
  'projects.rename': { resource: 'project', access: 'write' },
  // PROJ-5: no existing project to resolve on a list either — the same
  // "organization" resource `projects.create` resolves, read rather than
  // written.
  'projects.list': { resource: 'organization', access: 'read' },
  // Finding 3 (rework pass): `resolve` resolves the *source* project being
  // copied, but `execute` performs `createProject` — the same write
  // `projects.create` gates behind organization-scoped write, above, not a
  // write into the resolved project. That is not `courses.save`'s asymmetry
  // (D-18, finding 10): `courses.save` writes into the project it resolved;
  // this creates an unrelated new one, so a project-scoped write grant would
  // let its holder create arbitrary new projects once descriptors are
  // enforced. The descriptor names the resource the write actually reaches.
  'projects.duplicate': { resource: 'organization', access: 'write' },
  // Resolves the *project* a course is saved into, whether creating or
  // updating (`actions/courses.ts`'s `CourseSaveEntity`) — an update also
  // resolves the existing course, but the descriptor names the one
  // resource every save requires. Finding 10 (rework pass): on the update
  // path, `execute` actually *writes* a course, not a project — nothing
  // enforces descriptors yet (`policy.ts`), but the day something does, an
  // actor permitted to write projects would be permitted to rewrite courses
  // through this action (see `docs/DECISIONS.md` D-18).
  'courses.save': { resource: 'project', access: 'write' },
  'courses.enable': { resource: 'course', access: 'write' },
  'courses.disable': { resource: 'course', access: 'write' },
  // PROJ-5: resolves the project a course list is scoped to, read.
  'courses.list': { resource: 'project', access: 'read' },
  // PROJ-5: resolves the course itself, read.
  'courses.get': { resource: 'course', access: 'read' },
  // TEN-6: marks a binding inactive; deletes nothing. Installing is not an
  // action at all (`actions/discord-servers.ts`'s own module comment) — it
  // needs the caller's account id, which nothing in this package's dispatch
  // context carries.
  'discordServers.remove': { resource: 'discordServer', access: 'write' },
  // TEN-8: no existing binding to resolve against (a caller may hold none at
  // all) — resolves the organization itself, read, the same shape
  // `projects.list` uses.
  'discordServers.list': { resource: 'organization', access: 'read' },
  // SRV-6: resolves the course this scaffold job runs against, write —
  // `execute` reaches no Discord state at all (it only enqueues), but the
  // course it names is what a write grant against `'course'` already
  // protects everywhere else in this table (`courses.enable`/`.disable`).
  'discordServers.scaffold': { resource: 'course', access: 'write' },
  // Resolves the job itself, read — a job id belonging to another
  // organization resolves to nothing (TEN-5), the same as every other
  // scoped read in this table.
  'jobs.get': { resource: 'job', access: 'read' },
  // JOB-2: no existing job to resolve on a list — the organization itself
  // is the resource, read, the same "no existing record to resolve on a
  // list" shape `projects.list`/`discordServers.list` both use above.
  'jobs.list': { resource: 'organization', access: 'read' },
  // ROST-9: resolves the course a roster is imported into, write — the
  // same shape `discordServers.scaffold` uses above: `execute` reaches no
  // person or Discord state at all (it only enqueues), but the course it
  // names is what a write grant against `'course'` already protects
  // everywhere else in this table.
  'roster.import': { resource: 'course', access: 'write' },
  // FILE-1: resolves the course a file is attached to, write — `execute`
  // writes the bytes to disk and enqueues the provider upload; it never
  // reaches Discord or a person, the same "the course it names is what a
  // write grant already protects" shape `roster.import`/
  // `discordServers.scaffold` both use above.
  'courseAttachments.attach': { resource: 'course', access: 'write' },
  // FILE-2: resolves the course a file list is scoped to, read — the same
  // shape `courses.list`/`discordServers.list` use above.
  'courseAttachments.list': { resource: 'course', access: 'read' },
  // FILE-3/FILE-5: resolves the attachment itself, write — an attachment
  // belonging to another organization resolves to nothing (TEN-5), the
  // same as every other scoped read or write in this table. `execute` only
  // enqueues the provider removal; it never reaches the provider itself.
  'courseAttachments.detach': { resource: 'courseAttachment', access: 'write' },
  // FILE-4: resolves the course whose instructions are being saved, write —
  // `execute` also creates a new `course_instruction_revisions` row, but
  // the course it names is the resource a write grant against `'course'`
  // already protects everywhere else in this table.
  'courseInstructions.save': { resource: 'course', access: 'write' },
  // FILE-4: resolves the course a revision list is scoped to, read.
  'courseInstructions.list': { resource: 'course', access: 'read' },
  // FILE-4: resolves the revision being restored (and the course it
  // belongs to) — write, the same shape `courseInstructions.save` uses:
  // restoring is itself a write to `courses.instructions`, gated the same
  // way an ordinary save already is.
  'courseInstructions.restore': { resource: 'course', access: 'write' },
  // COST-4: no existing record of its own to resolve — the organization
  // itself is the resource, read rather than written, the same shape
  // `discordServers.list`/`projects.list` already use above.
  'costLedger.organizationUsage': { resource: 'organization', access: 'read' },
  // COST-3: no existing record of its own to resolve either — the same
  // "organization itself is the resource" shape `costLedger.organizationUsage`
  // uses immediately above, written rather than read. *Who* may call this
  // (an existing owner, never any membership) is `execute`'s own check, not
  // the policy's — the same split `memberships.grant`'s own row (below)
  // documents for the identical reason: a policy cannot see the caller's
  // account id at all (`policy.ts`'s own module comment).
  'costLedger.setSpendingCap': { resource: 'organization', access: 'write' },
  // ENRL-3/ENRL-4: resolves the course a join link is issued against, write —
  // the same "the course it names is what a write grant already protects"
  // shape `roster.import`/`discordServers.scaffold` both use above.
  'courseJoinLinks.create': { resource: 'course', access: 'write' },
  // WEB-20: resolves the course a join-link list is scoped to, read — the
  // same "the course it names is what a read grant already protects" shape
  // `courseAttachments.list`/`transcripts.listStudents` both use above; this
  // is a read of the course's own links, never a write to any of them.
  'courseJoinLinks.list': { resource: 'course', access: 'read' },
  // ENRL-4: resolves the link itself, write — a link belonging to another
  // organization resolves to nothing (TEN-5), the same as every other
  // scoped write in this table. Redeeming a link is not an action at all
  // (`actions/course-join-links.ts`'s own module comment) — it needs no
  // organization id in advance, which every dispatched action here is
  // given.
  'courseJoinLinks.revoke': { resource: 'courseJoinLink', access: 'write' },
  // ENRL-12: resolves the link itself, write — literally `.revoke`'s own
  // policy object (`actions/course-join-links.ts`'s own doc comment on
  // `createRevealCourseJoinLinkAction`), reused rather than duplicated so
  // the two gates cannot drift apart under a future edit to either alone.
  'courseJoinLinks.reveal': { resource: 'courseJoinLink', access: 'write' },
  // FILE-6/WEB-31: resolves the course itself, write — a course belonging
  // to another organization resolves to nothing (TEN-5), the same as
  // `courseAttachments.attach`'s own identical descriptor above.
  'courseWebSources.add': { resource: 'course', access: 'write' },
  // FILE-6: a read of the course's own websites, never a write to any of
  // them — the same `courseJoinLinks.list` shape above.
  'courseWebSources.list': { resource: 'course', access: 'read' },
  // FILE-6: resolves the website itself, write — a website belonging to
  // another organization resolves to nothing (TEN-5), the same as
  // `courseAttachments.detach`'s own identical shape above.
  'courseWebSources.remove': { resource: 'courseWebSource', access: 'write' },
  // ENRL-2: resolves the person whose enrolments are being listed, read.
  'enrolments.listForPerson': { resource: 'person', access: 'read' },
  // ENRL-2: the policy *is* the check — it resolves the active enrolment
  // itself, so "not enrolled" and "does not exist" already refuse
  // identically (ACT-3) before `execute` runs at all.
  'enrolments.checkAccess': { resource: 'enrolment', access: 'read' },
  // ENRL-6: resolves the enrolment being ended, write.
  'enrolments.end': { resource: 'enrolment', access: 'write' },
  // ENRL-9: resolves the enrolment being reinstated, write — `execute` also
  // requires an authenticated `accountId` (refused without one), but *who*
  // may call this at all is enforced one level up, structurally, not by
  // this descriptor (`actions/enrolments.ts`'s own module comment on
  // `reinstateEnrolmentAction`).
  'enrolments.reinstate': { resource: 'enrolment', access: 'write' },
  // WEB-22: resolves the course an enrolment list is scoped to, read — the
  // same shape `courseAttachments.list`/`courseJoinLinks.list` use above;
  // unlike `enrolments.listForPerson`, this lists both active and ended
  // enrolments.
  'enrolments.listForCourse': { resource: 'course', access: 'read' },
  // ENRL-5: no existing membership to resolve on a first grant — the
  // organization itself is the resource, the same "no existing record to
  // resolve on create" shape `projects.create` uses above. *Who* may call
  // this (an existing owner, never themselves) is `execute`'s own check,
  // not the policy's — `policy.ts`'s own module comment on why a policy
  // cannot see the caller's account id at all.
  'memberships.grant': { resource: 'organization', access: 'write' },
  // ENRL-5: no existing membership to resolve against either — the
  // organization itself is the resource, read rather than written, the same
  // shape `discordServers.list`/`costLedger.organizationUsage` use above.
  // Unlike `memberships.grant`, *who* may call this is not further
  // restricted in `execute` — this file's own module comment on
  // `listMembershipsAction` has why a read needs no owner check.
  'memberships.list': { resource: 'organization', access: 'read' },
  // ENRL-11: resolves the target membership itself, write — a target
  // belonging to another organization, or one already revoked, resolves to
  // nothing (TEN-5), the same as every other scoped write in this table.
  // *Who* may call this (an existing owner, and the peer-owner restriction)
  // is `execute`'s own check, not the policy's, the same reason
  // `memberships.grant`'s own row gives above.
  'memberships.revoke': { resource: 'membership', access: 'write' },
  // ENRL-10: no existing invitation to resolve on create either — the
  // organization itself is the resource, the same "no existing record to
  // resolve on create" shape `memberships.grant`/`projects.create` both use
  // above. *Who* may call this (an existing owner) is `execute`'s own check,
  // not the policy's, the same reason `memberships.grant`'s own row gives.
  'membershipInvitations.create': { resource: 'organization', access: 'write' },
  // ENRL-10: the organization itself again, read rather than written —
  // unlike `memberships.list`, `execute` further restricts this to an
  // existing owner (`membership-invitations.ts`'s own module comment on
  // why an outstanding invitation's own email is not open to any member the
  // way a granted role already is).
  'membershipInvitations.list': { resource: 'organization', access: 'read' },
  // ENRL-10: resolves the invitation itself, write — an invitation
  // belonging to another organization resolves to nothing (TEN-5), the
  // same as every other scoped write in this table. Redeeming an
  // invitation is not an action at all (`actions/membership-invitations.ts`'s
  // own module comment) — it needs no organization id in advance, which
  // every dispatched action here is given.
  'membershipInvitations.revoke': {
    resource: 'membershipInvitation',
    access: 'write',
  },
  // ADMIN-1: resolves the course whose transcript is being read, read —
  // `execute` also writes an ADMIN-2 audit row, but that write happens
  // inside `@bloombot/db`'s own `readCourseTranscript` regardless of who
  // calls it (`transcripts.ts`'s own module comment), not gated by this
  // descriptor.
  'transcripts.read': { resource: 'course', access: 'read' },
  // ADMIN-1: resolves the course a student list is scoped to, read — the
  // same shape `courseAttachments.list`/`courseInstructions.list` use
  // above.
  'transcripts.listStudents': { resource: 'course', access: 'read' },
  // ADMIN-3: resolves the course a transcript export is requested for,
  // write — `execute` only enqueues the job (and, for a student-filtered
  // export, checks PPL-5's own `hasVerifiedAddress` gate); it never
  // produces the file itself, the same "the course it names is what a
  // write grant already protects" shape `roster.import`/
  // `discordServers.scaffold` both use above.
  'transcripts.export': { resource: 'course', access: 'write' },
  // ADMIN-3: resolves the course an export list is scoped to, read.
  'transcripts.listExports': { resource: 'course', access: 'read' },
  // ADMIN-2: resolves the course whose access log is being read, read —
  // `execute` further restricts this to an existing owner
  // (`transcripts.ts`'s own module comment on why this log is not open to
  // every membership the way `.read`/`.listStudents`/`.listExports` above
  // are), the same "restricted in execute, not the policy" split
  // `costLedger.setSpendingCap`/`memberships.grant` both already take.
  'transcripts.listAccessLog': { resource: 'course', access: 'read' },
}

describe('ACT-5 — access audit index', () => {
  const registry = createPlatformRegistry()

  it('registers exactly the actions this table expects — no more, no fewer', () => {
    const registeredNames = registry
      .list()
      .map((action) => action.name)
      .sort()
    expect(registeredNames).toEqual(Object.keys(EXPECTED_DESCRIPTORS).sort())
  })

  for (const [name, descriptor] of Object.entries(EXPECTED_DESCRIPTORS)) {
    it(`${name} is guarded exactly as recorded here`, () => {
      const action = registry.get(name)
      expect(action, `expected an action registered as "${name}"`).toBeDefined()
      expect(action?.policy.descriptor).toEqual(descriptor)
    })
  }
})
