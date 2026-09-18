/**
 * ADMIN-6/ADMIN-9's own `'admin-course'` screen — one course's settings,
 * read-only, reached by clicking a row on `CoursesView` or a course link
 * from `OrganizationDetail`/`ProjectDetail`/`AccountDetail`. Grouped
 * General/AI/Knowledge the way `pages/CourseEditor.tsx` groups them for the
 * course's own owner (`docs/SPEC.md` §41's own words), rendered directly
 * rather than through that component — `CourseEditor` is a large form wired
 * to organization-scoped actions (`dispatchAction`) this console
 * deliberately never calls; reusing it here would mean either contorting it
 * to take a second, read-only data source, or leaving dead editable
 * affordances behind a `readOnly` flag nobody asked for. See
 * `docs/DECISIONS.md` D-118.
 *
 * ADMIN-9 widens ADMIN-6's settings-only read into a full course overview:
 * the organization and project as links, the approval history, the usage
 * totals, and the enrolled people — each linking to `admin-account` when
 * they carry an `accountId`. Transcripts stay out of reach — ADMIN-4's own
 * boundary, unchanged: this screen names who is in a course, never what
 * they said.
 *
 * Approve/Unapprove are rendered here too (this is where the decision gets
 * made), reusing `Admin`'s own two handlers — a decision made from this
 * screen refreshes this screen (`refreshCurrentCourseScreen`), not only the
 * list an operator would otherwise have to navigate back to to see it take
 * effect.
 */

import type { AdminCourseDetail } from '../../api/types.js'
import { AppLink } from '../../components/AppLink.js'
import { Button } from '../../components/Button.js'
import {
  LoadingStatus,
  Skeleton,
  SkeletonLine,
  SkeletonRow,
} from '../../components/Skeleton.js'
import type { Route } from '../../routing/route.js'
import { NotFound } from '../NotFound.js'
import { formatBySurface, formatMicros, ReadOnlyField } from './shared.js'

export function CourseDetailView({
  courseId,
  course,
  notFound,
  failed,
  decidingCourseId,
  navigate,
  onApprove,
  onUnapprove,
  onBack,
}: {
  courseId: string
  course: AdminCourseDetail | undefined
  /** ADMIN-6 — this course id 404'd, distinct from `failed` (a refusal, e.g. 403) below: this renders `NotFound`, `failed` renders nothing further (the top-level `ErrorMessage` already has it). */
  notFound: boolean
  failed: boolean
  decidingCourseId: string | undefined
  navigate: (route: Route, options?: { replace?: boolean }) => void
  // ADMIN-13 — the whole course, not only its id, the same shape
  // `CoursesView`'s own `onApprove` takes.
  onApprove: (course: { courseId: string; courseTitle: string }) => void
  onUnapprove: (course: { courseId: string; courseTitle: string }) => void
  onBack: () => void
}) {
  if (notFound) {
    return <NotFound onHome={onBack} />
  }

  // `course.courseId !== courseId` — a stale read from the *previous*
  // address, still in `course` because the fetch has not resolved yet,
  // would otherwise flash under the new one for one render.
  if (course === undefined || course.courseId !== courseId) {
    if (failed) {
      return (
        <Button variant="secondary" onClick={onBack}>
          ← Courses
        </Button>
      )
    }
    // WEB-45: shaped like the settled screen below, once the read resolves.
    return (
      <div className="flex flex-col gap-3">
        <SkeletonLine className="h-4 w-24" />
        <Skeleton className="h-8 w-64" />
        <SkeletonRow />
        <SkeletonRow />
        <LoadingStatus />
      </div>
    )
  }

  const deciding = decidingCourseId === course.courseId

  return (
    <div
      className="flex flex-col gap-6"
      data-testid={`admin-course-detail-${course.courseId}`}
    >
      <Button variant="secondary" onClick={onBack}>
        ← Courses
      </Button>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-medium text-neutral-500">Course</p>
          <h2 className="text-page-title font-semibold text-neutral-900">
            {course.courseTitle}
          </h2>
          <p className="text-xs text-neutral-400">
            {course.aiApprovedAt === null
              ? 'Pending approval'
              : `Approved ${new Date(course.aiApprovedAt).toLocaleString()}${
                  course.aiApprovedByEmail
                    ? ` by ${course.aiApprovedByEmail}`
                    : ''
                }`}
          </p>
        </div>
        {course.aiApprovedAt === null ? (
          <Button
            variant="primary"
            onClick={() => onApprove(course)}
            disabled={deciding}
          >
            {deciding ? 'Approving…' : 'Approve'}
          </Button>
        ) : (
          <Button
            variant="destructive"
            onClick={() => onUnapprove(course)}
            disabled={deciding}
          >
            {deciding ? 'Unapproving…' : 'Unapprove'}
          </Button>
        )}
      </div>

      {/* ADMIN-9 — the organization and project this course belongs to,
          each a link into that entity's own console screen. */}
      <dl className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
          <dt className="w-48 shrink-0 text-xs font-medium text-neutral-500">
            Organization
          </dt>
          <dd className="text-sm text-neutral-900">
            <AppLink
              to={{
                kind: 'admin-organization',
                organizationId: course.organizationId,
              }}
              navigate={navigate}
              className="font-medium text-brand-700 underline-offset-2 hover:underline"
            >
              {course.organizationName}
            </AppLink>
          </dd>
        </div>
        <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
          <dt className="w-48 shrink-0 text-xs font-medium text-neutral-500">
            Project
          </dt>
          <dd className="text-sm text-neutral-900">
            <AppLink
              to={{ kind: 'admin-project', projectId: course.projectId }}
              navigate={navigate}
              className="font-medium text-brand-700 underline-offset-2 hover:underline"
            >
              {course.projectName}
            </AppLink>
          </dd>
        </div>
      </dl>

      {/* WEB-35's own three of five groups — Discord, Roster and People stay
          out of this screen entirely: the first has no place in a
          three-group read (D-118), and enrolled people are named further
          down, on ADMIN-9's own terms, never a roster to edit. */}
      <section
        aria-label="General"
        className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
      >
        <h3 className="text-section-title font-semibold text-neutral-900">
          General
        </h3>
        <dl className="flex flex-col gap-2">
          <ReadOnlyField
            label="Enabled"
            value={course.enabled ? 'Yes' : 'No'}
          />
          <ReadOnlyField label="Admins role" value={course.adminsRole ?? '—'} />
          <ReadOnlyField
            label="Students role"
            value={course.studentsRole ?? '—'}
          />
          <ReadOnlyField
            label="Categories"
            value={
              course.categories.length === 0
                ? '—'
                : course.categories
                    .map(
                      (category) =>
                        `${category.name} (${category.channels
                          .map((channel) => channel.name)
                          .join(', ')})`
                    )
                    .join('; ')
            }
          />
          <ReadOnlyField
            label="Self-enrolment from Discord"
            value={course.selfEnrolFromDiscord ? 'On' : 'Off'}
          />
          <ReadOnlyField
            label="Answers an unenrolled student"
            value={course.answerUnenrolled ? 'Yes' : 'No'}
          />
          <ReadOnlyField
            label="Conversation scope"
            value={course.conversationScope}
          />
        </dl>
      </section>

      <section
        aria-label="AI"
        className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
      >
        <h3 className="text-section-title font-semibold text-neutral-900">
          AI
        </h3>
        <dl className="flex flex-col gap-2">
          <ReadOnlyField label="Model" value={course.model ?? '—'} />
          {course.promptId && (
            <ReadOnlyField label="Prompt id" value={course.promptId} />
          )}
          <ReadOnlyField
            label="Max requests per day"
            value={course.maxRequestsPerDay?.toString() ?? '—'}
          />
          <ReadOnlyField
            label="Instructions"
            value={course.instructions ?? '—'}
            multiline
          />
        </dl>
      </section>

      <section
        aria-label="Knowledge"
        className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
      >
        <h3 className="text-section-title font-semibold text-neutral-900">
          Knowledge
        </h3>
        {course.attachments.length === 0 ? (
          <p className="text-sm text-neutral-500">No knowledge files.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {course.attachments.map((attachment, index) => (
              // No stable id in `AdminCourseAttachment` (metadata only) —
              // index is safe here: this list is read-only and never
              // reorders itself.
              <li key={index} className="text-sm text-neutral-700">
                {attachment.filename} ·{' '}
                {(attachment.sizeBytes / 1024).toFixed(1)} KB ·{' '}
                {attachment.status}
              </li>
            ))}
          </ul>
        )}
        {course.webSources.length === 0 ? (
          <p className="text-sm text-neutral-500">No websites.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {course.webSources.map((webSource) => (
              <li key={webSource.domain} className="text-sm text-neutral-700">
                {webSource.domain}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ADMIN-9 — the course's own approval history, one entry per decision. */}
      <section
        aria-label="Approval history"
        className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
      >
        <h3 className="text-section-title font-semibold text-neutral-900">
          Approval history
        </h3>
        {course.approvalEvents.length === 0 ? (
          <p className="text-sm text-neutral-500">No decisions recorded.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {course.approvalEvents.map((event) => (
              <li key={event.id} className="text-sm text-neutral-700">
                {event.action === 'approve'
                  ? 'Approved'
                  : event.action === 'revoke'
                    ? 'Unapproved'
                    : 'Auto-approved'}{' '}
                {new Date(event.createdAt).toLocaleString()}
                {event.accountEmail ? ` by ${event.accountEmail}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ADMIN-9 — this course's own usage. */}
      <section
        aria-label="Usage"
        className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
      >
        <h3 className="text-section-title font-semibold text-neutral-900">
          Usage
        </h3>
        <p className="text-sm text-neutral-900">
          {formatMicros(course.usage.totalCostMicros)} spent ·{' '}
          {course.usage.callCount} call(s)
        </p>
        {course.usage.bySurface.length > 0 && (
          <p className="text-xs text-neutral-500">
            By surface: {formatBySurface(course.usage.bySurface)}
          </p>
        )}
      </section>

      {/* ADMIN-9 — the people enrolled in this course, never a transcript
          (ADMIN-4's own boundary). */}
      <section
        aria-label="People"
        className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
      >
        <h3 className="text-section-title font-semibold text-neutral-900">
          People
        </h3>
        {course.people.length === 0 ? (
          <p className="text-sm text-neutral-500">No one enrolled yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs font-medium text-neutral-500">
                  <th className="py-1 pr-4">Name</th>
                  <th className="py-1 pr-4">Enrolled</th>
                  <th className="py-1">Cost</th>
                </tr>
              </thead>
              <tbody>
                {course.people.map((person) => (
                  <tr
                    key={person.personId}
                    className="border-t border-neutral-100"
                  >
                    <td className="py-1 pr-4">
                      {person.accountId ? (
                        <AppLink
                          to={{
                            kind: 'admin-account',
                            accountId: person.accountId,
                          }}
                          navigate={navigate}
                          className="font-medium text-brand-700 underline-offset-2 hover:underline"
                        >
                          {person.displayName ??
                            person.email ??
                            person.personId}
                        </AppLink>
                      ) : (
                        (person.displayName ?? person.email ?? person.personId)
                      )}
                    </td>
                    <td className="py-1 pr-4 text-neutral-700">
                      {new Date(person.enroledAt).toLocaleDateString()}
                    </td>
                    <td className="py-1 text-neutral-700">
                      {formatMicros(person.totalCostMicros)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
