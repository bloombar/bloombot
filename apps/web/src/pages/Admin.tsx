/**
 * ADMIN-4/ADMIN-5: the platform-administrator console — organizations,
 * their usage and their health, and the one operation that deletes a
 * tenant's data entirely.
 *
 * Reached under `/platform-admin` (`App.tsx`'s own module comment — not
 * `/admin`, which is `apps/api`'s own mount for this screen's reads and
 * writes), never inside
 * `pages/Shell.tsx`'s organization-scoped tabs — this screen is not
 * "acting within" any one organization, the same boundary
 * `apps/api`'s own `routes/admin.ts` draws. Every read here goes through
 * that router (`api/client.ts`'s own `fetchAdminOrganizations`/
 * `fetchDeletionPreview`/`fetchTenantDeletions`), not `dispatchAction` —
 * there is no organization id to dispatch within.
 *
 * **ADMIN-4's own boundary, on this page too:** nothing rendered here ever
 * shows a course, a student or a message — only an organization's name,
 * its usage totals and the platform's own process health. This app does
 * not hide that boundary by omission alone; `apps/api`'s own response
 * shape has nothing in it to show even if this page tried.
 *
 * ADMIN-5's confirmation is the prompt variant of this panel's one modal
 * (`components/modal/`) — an administrator types the organization's own
 * name to proceed, the same "severe enough to warrant the prompt variant"
 * treatment this slice's own brief calls for, never a plain confirm a
 * stray click could pass.
 *
 * **WEB-33 — every screen this console renders is its own address**, under
 * `routing/route.ts#AdminRoute`:
 *  - `'platform-admin'` — the console's one entry point from outside the
 *    app; resolved to `'admin-organizations'` and replaced, the identical
 *    "one-time landing address" treatment `App.tsx`'s own `'home'` gets for
 *    `/`, never somewhere back should return into.
 *  - `'admin-organizations'` — the organizations list, with usage and the
 *    per-organization Delete action inline (unchanged from before this
 *    slice — an operator does not have to drill into an organization just
 *    to delete it).
 *  - `'admin-organization'` — one organization's own card, reached by
 *    clicking its name in the list, so an operator can link a colleague to
 *    the exact organization they are looking at (this slice's own brief,
 *    quoting WEB-33). Resolved against the same `fetchAdminOrganizations`
 *    read the list already holds — there is no `admin.organizations.get`
 *    action, mirroring `pages/ProjectsPanel.tsx`'s own `useResolvedProject`
 *    reading the whole list rather than adding a single-item fetch a
 *    console this small does not otherwise need.
 *  - `'admin-deletions'` — ADMIN-5's own audit trail, broken out of the
 *    list's own page into its own address.
 *  - `'admin-courses'` — WEB-53's Courses screen: every pending course with
 *    an Approve button, and every approved course with an Unapprove one
 *    (`api/client.ts`'s own `fetchAdminCourses`/`approveAdminCourse`/
 *    `unapproveAdminCourse`). Unapprove is the destructive direction and
 *    confirms through this same modal, the same plain `confirm()` (no typed
 *    name) `components/CourseRows.tsx`'s own disable-a-course confirmation
 *    already uses — revoking is reversible (an administrator can re-approve),
 *    unlike ADMIN-5's own delete, which is why this stops at `confirm`
 *    rather than `prompt`.
 *  - `'admin-course'` — ADMIN-6's own read-only settings screen, reached by
 *    clicking a row on `'admin-courses'` (`api/client.ts`'s own
 *    `fetchAdminCourse`). General, AI and Knowledge, grouped the way
 *    `pages/CourseEditor.tsx` groups them for the course's own owner, with
 *    nothing editable — no inputs a person can type into, no Save. Approve/
 *    Unapprove are available here too (the same two handlers `'admin-courses'`
 *    already has), since this is where the decision actually gets made.
 * Every navigation between these pushes (`navigate`, no `{ replace: true }`)
 * — WEB-34's ordinary rule, the same the rest of the panel already follows.
 *
 * **WEB-54** adds two things every one of the five screens above now carries,
 * rendered by `Admin` itself rather than by any one screen:
 *  - `AdminNav`, above whichever screen is current — real links
 *    (`components/AppLink.tsx`, the same push-and-`href`-both pattern the
 *    rest of the panel already uses) to the console's three top-level
 *    destinations, Organizations/Courses/Deletion history. The two detail
 *    screens (`'admin-organization'`, `'admin-course'`) mark their own
 *    parent list current (`aria-current="page"`) rather than showing no
 *    current item at all — an operator who drilled into one organization is
 *    still, in every sense that matters to this nav, on the Organizations
 *    screen.
 *  - The health footer (`ProcessBadge`, unchanged) — moved out of
 *    `'admin-organizations'`'s own screen, where it used to render inline,
 *    into a `<footer>` fixed to the console's own viewport bottom, on every
 *    screen. Still reads off the one `fetchAdminOrganizations` result
 *    (`data`) `Admin` already holds for the organizations list itself — no
 *    second read, even on a screen (Courses, a course's own detail,
 *    deletion history) that has no other use for that response at all.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ApiError,
  approveAdminCourse,
  deleteTenant,
  fetchAdminCourse,
  fetchAdminCourses,
  fetchAdminOrganizations,
  fetchDeletionPreview,
  fetchTenantDeletions,
  unapproveAdminCourse,
} from '../api/client.js'
import type {
  AdminCourseDetail,
  AdminCourseSummary,
  AdminOrganizationsResponse,
  AdminOrganizationSummary,
  CostBySurface,
  OrganizationDeletionPreview,
  TenantDeletion,
} from '../api/types.js'
import { AppLink } from '../components/AppLink.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { useModal } from '../components/modal/ModalProvider.js'
import {
  LoadingStatus,
  Skeleton,
  SkeletonLine,
  SkeletonRow,
} from '../components/Skeleton.js'
import { DeleteIcon, FailureIcon, SuccessIcon } from '../icons.js'
import type { AdminRoute, Route } from '../routing/route.js'
import { surfaceLabel } from '../surface-label.js'
import { NotFound } from './NotFound.js'

export interface AdminScreenProps {
  /** WEB-33 — which of the console's own screens is current. */
  route: AdminRoute
  navigate: (route: Route, options?: { replace?: boolean }) => void
  onBack: () => void
}

/** Integer micros (COST-1) to a plain dollar figure — the same unit `costLedger`'s own summaries use platform-wide; this app has no other place that formats one yet, so the conversion lives here rather than a shared module one caller does not justify. */
function formatMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`
}

/** COST-7 — the same terse, inline register this screen's own per-organization total already uses ("$1.00 spent · 3 call(s) · partly estimated"), applied per surface. */
function formatBySurface(bySurface: CostBySurface[]): string {
  return bySurface
    .map((entry) => {
      const estimateNote =
        entry.estimatedCostMicros > 0 ? ' · partly estimated' : ''
      return `${surfaceLabel(entry.surface)}: ${formatMicros(entry.costMicros)} · ${entry.callCount} call(s)${estimateNote}`
    })
    .join(' · ')
}

function ProcessBadge({
  label,
  reachable,
}: {
  label: string
  reachable: boolean
}) {
  return (
    <span className="flex items-center gap-1 text-xs text-neutral-600">
      {reachable ? (
        <SuccessIcon aria-hidden="true" className="size-3 text-success-600" />
      ) : (
        <FailureIcon aria-hidden="true" className="size-3 text-danger-600" />
      )}
      {label}
    </span>
  )
}

/**
 * WEB-54 — the console's own secondary navigation, rendered by `Admin`
 * above whichever of the five screens (`Admin.tsx`'s own module comment)
 * is current, so every one of them carries it. Real links (`AppLink`),
 * not buttons — the same "a real `href`, but an ordinary click still does
 * client-side navigation" treatment `AppLink`'s own module comment gives
 * every other in-panel destination, so a middle-click or cmd-click opens a
 * destination in a new tab exactly the way the rest of the panel's own
 * links already do. Navigation pushes (`AppLink` calls `navigate` with no
 * `{ replace: true }`), WEB-34's ordinary rule.
 */
function AdminNav({
  route,
  navigate,
}: {
  route: AdminRoute
  navigate: (route: Route, options?: { replace?: boolean }) => void
}) {
  // The two detail screens mark their own parent list current — an
  // operator who has drilled into one organization or one course is still,
  // for the purpose of this nav, on the Organizations/Courses screen
  // (this file's own module comment).
  const items: {
    key: string
    label: string
    to: AdminRoute
    current: boolean
  }[] = [
    {
      key: 'organizations',
      label: 'Organizations',
      to: { kind: 'admin-organizations' },
      current:
        route.kind === 'admin-organizations' ||
        route.kind === 'admin-organization',
    },
    {
      key: 'courses',
      label: 'Courses',
      to: { kind: 'admin-courses' },
      current: route.kind === 'admin-courses' || route.kind === 'admin-course',
    },
    {
      key: 'deletions',
      label: 'Deletion history',
      to: { kind: 'admin-deletions' },
      current: route.kind === 'admin-deletions',
    },
  ]

  return (
    <nav
      aria-label="Console"
      className="flex flex-wrap gap-4 border-b border-neutral-200 pb-4"
    >
      {items.map((item) => (
        <AppLink
          key={item.key}
          to={item.to}
          navigate={navigate}
          aria-current={item.current ? 'page' : undefined}
          className={
            item.current
              ? 'text-sm font-medium text-brand-700'
              : 'text-sm font-medium text-neutral-600 hover:text-neutral-900'
          }
        >
          {item.label}
        </AppLink>
      ))}
    </nav>
  )
}

/**
 * WEB-54 — the platform-health badges (`ProcessBadge`, unchanged), fixed to
 * the console's own viewport bottom on every screen — moved out of
 * `'admin-organizations'`'s own inline rendering, where this used to be the
 * only place they showed at all. `<footer>` (a `contentinfo` landmark),
 * matching the accessibility habit `components/AppShell.tsx`'s own
 * `Footer` already holds the rest of the panel to. Reads `data`, the same
 * `fetchAdminOrganizations` result every screen here already gets from
 * `Admin`'s own `refresh` — no second read for a screen (Courses, a
 * course's own detail, deletion history) that has no other use for the
 * organizations list itself.
 */
function AdminHealthFooter({
  data,
}: {
  data: AdminOrganizationsResponse | undefined
}) {
  if (!data) return null
  return (
    <footer className="fixed inset-x-0 bottom-0 z-10 flex h-footer items-center gap-3 border-t border-neutral-200 bg-white px-6">
      <ProcessBadge label="Bot" reachable={data.platformHealth.bot.reachable} />
      <ProcessBadge
        label="Worker"
        reachable={data.platformHealth.worker.reachable}
      />
      <ProcessBadge label="API" reachable={data.platformHealth.api.reachable} />
    </footer>
  )
}

export function Admin({ route, navigate, onBack }: AdminScreenProps) {
  const [data, setData] = useState<AdminOrganizationsResponse | undefined>(
    undefined
  )
  const [deletions, setDeletions] = useState<TenantDeletion[] | undefined>(
    undefined
  )
  const [courses, setCourses] = useState<AdminCourseSummary[] | undefined>(
    undefined
  )
  // ADMIN-6 — `'admin-course'`'s own read, one course at a time. `undefined`
  // covers both "still loading" and "the id last fetched is not this one"
  // (below), so a stale course never flashes under a freshly-navigated
  // address; `courseNotFound` is set apart from the shared `error` state —
  // a 404 here means this course id, not a refusal the top-level
  // `ErrorMessage` banner should also claim.
  const [courseDetail, setCourseDetail] = useState<
    AdminCourseDetail | undefined
  >(undefined)
  const [courseNotFound, setCourseNotFound] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [deletingId, setDeletingId] = useState<string | undefined>(undefined)
  // WEB-53 — the one course currently mid-approve/unapprove, the same
  // "disable this row's own button while its own request is in flight"
  // shape `deletingId` above already gives Delete.
  const [decidingCourseId, setDecidingCourseId] = useState<string | undefined>(
    undefined
  )
  const { confirm, prompt } = useModal()

  const refresh = useCallback(() => {
    fetchAdminOrganizations().then(
      (result) => setData(result),
      (caught: unknown) => {
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [])

  // ADMIN-5's own audit trail, read back — a rework finding: this screen's
  // own module comment already claimed every read went through
  // `fetchTenantDeletions`, but nothing here had ever actually called it.
  const refreshDeletions = useCallback(() => {
    fetchTenantDeletions().then(
      (result) => setDeletions(result),
      (caught: unknown) => {
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [])

  // WEB-53 — read only for the Courses screen itself, unlike
  // `refresh`/`refreshDeletions` above (every other admin screen resolves
  // against those two regardless of which one is current): no other screen
  // here needs a course's own approval state, so there is no reason to pay
  // for this read on every visit to `/platform-admin`.
  const refreshCourses = useCallback(() => {
    fetchAdminCourses().then(
      (result) => setCourses(result.courses),
      (caught: unknown) => {
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [])

  // ADMIN-6 — one course's own settings, fetched only for `'admin-course'`,
  // the same "no other screen needs this read" reasoning `refreshCourses`'s
  // own comment already gives its sibling. A `course_not_found` (404) is
  // this course id's own state, not a console-wide refusal — kept apart
  // from `error` so it renders `NotFound` rather than the top-level banner.
  //
  // **Must-fix, first review round**: `currentCourseIdRef` guards against
  // an out-of-order response — course A's read is slow, an operator goes
  // back and opens course B (fast), and A's response then lands *after*
  // B's already has. Without this, A's late `.then` would overwrite B's
  // already-rendered detail (or, worse, mark B `courseNotFound` off the
  // back of a stale 404 for A), and — since nothing re-fires the effect
  // once B's own address is already current — the `course.courseId !==
  // courseId` guard in `CourseDetailView` would then render the skeleton
  // forever, with no fetch left in flight to ever resolve it. A plain
  // boolean "ignore late responses" ref would not do: the *next* read for
  // the *same* course (a retry, or Approve's own refresh) has to still be
  // honoured, so this stores which course id is actually current rather
  // than merely whether one read has already landed.
  const currentCourseIdRef = useRef<string | undefined>(undefined)

  const refreshCourseDetail = useCallback((courseId: string) => {
    currentCourseIdRef.current = courseId
    setCourseNotFound(false)
    fetchAdminCourse(courseId).then(
      (result) => {
        if (currentCourseIdRef.current !== courseId) return
        setCourseDetail(result)
      },
      (caught: unknown) => {
        if (currentCourseIdRef.current !== courseId) return
        if (caught instanceof ApiError) {
          if (caught.status === 404) setCourseNotFound(true)
          else setError(caught)
        } else throw caught
      }
    )
  }, [])

  useEffect(() => {
    refresh()
    refreshDeletions()
  }, [refresh, refreshDeletions])

  // Code review (WEB-54): an error belongs to the screen — and the read —
  // that produced it. `refresh`/`refreshDeletions` above fire once, on
  // mount, not on every navigation, so a refusal from either of them (say,
  // `fetchTenantDeletions` failing) would otherwise still be on screen long
  // after an operator has moved on through the new nav to a screen that
  // never re-ran either read: Organizations, an organization's own detail,
  // or Deletion history. Keying on `route.kind` (not the full `route`, the
  // same narrowing `refreshCourseDetail`'s own effect below already uses)
  // clears it the moment the console moves to a different screen, before
  // that screen's own read — if it fires one — has a chance to set a fresh
  // one of its own.
  //
  // Deliberately *not* also cleared from inside each read's own success
  // handler (a first version of this fix did exactly that, and a review
  // round caught what it broke): `refresh` and `refreshDeletions` both fire
  // unconditionally on every mount, concurrently, and a success handler
  // that clears `error` cannot tell whether the error on screen was its own
  // read's failure or the *other* concurrent read's — `fetchAdminOrganizations`
  // rejecting and `fetchTenantDeletions` resolving (`admin.test.tsx`'s own
  // "a non-administrator sees the refusal" case) would otherwise wipe the
  // refusal the moment the unrelated deletions read happened to land after
  // it. Clearing once, on navigation, sidesteps that race entirely: it runs
  // before either of the new screen's own reads has had a chance to settle,
  // so there is nothing left for a same-tick "other read succeeded" to
  // accidentally undo.
  //
  // **`not_platform_administrator` is exempted — it stays on screen.**
  // Second review round: a plain read failure (a 500, a network error) is
  // that screen's own problem, and moving on genuinely leaves it behind.
  // `not_platform_administrator` is not that — it is ADMIN-4's own gate
  // (`routes/admin.ts`), the same check every route behind `/platform-admin`
  // makes, so it describes this *account*, not this *screen*: it would only
  // ever be replaced by the identical refusal from whatever screen an
  // operator navigated to next, not by success. Worse, clearing it outright
  // can strand a screen that fires no read of its own on navigation
  // (`'admin-organization'`, `'admin-deletions'` both resolve against data
  // `refresh`/`refreshDeletions` already fetched, once, at mount) — with
  // `error` cleared but `data`/`deletions` still `undefined` from that same
  // original refusal, `failed` would read `false` and the screen would show
  // its own loading skeleton forever, with no fetch left in flight to ever
  // resolve it. Left in place, this reads exactly as it should: the console
  // says once, clearly, and keeps saying, "this requires
  // platform-administrator access" — never a silent, permanent spinner.
  useEffect(() => {
    setError((current) =>
      current?.body.error === 'not_platform_administrator' ? current : undefined
    )
  }, [route.kind])

  useEffect(() => {
    if (route.kind !== 'admin-courses') return
    refreshCourses()
  }, [route.kind, refreshCourses])

  useEffect(() => {
    if (route.kind !== 'admin-course') {
      // Leaving the detail screen entirely (not merely to another course):
      // a still-in-flight response for the course last viewed here is now
      // for nobody's own current address, so `currentCourseIdRef` above
      // must not still call it current the next time this screen is
      // reached — `refreshCourseDetail`, below, always overwrites it again
      // before that happens regardless, this only prevents a leftover
      // stale value from lingering unobserved in between.
      currentCourseIdRef.current = undefined
      return
    }
    // A fresh navigation between two courses must not render the previous
    // one under the new address while the new read is still in flight.
    setCourseDetail(undefined)
    refreshCourseDetail(route.courseId)
    // `route.kind === 'admin-course' ? route.courseId : undefined` (rather
    // than `route` itself) is the dependency, the same narrowing
    // `pages/ProjectsPanel.tsx`'s own equivalent effect already uses — a
    // new `Route` object on every render must not refire this on its own.
  }, [
    route.kind,
    route.kind === 'admin-course' ? route.courseId : undefined,
    refreshCourseDetail,
  ])

  // WEB-33/WEB-34: `/platform-admin` itself is never rendered past this —
  // once mounted, it replaces to the console's own landing screen, the
  // identical "one-time entry, resolved and replaced" shape `App.tsx`'s
  // own `'home'` effect already gives `/`.
  useEffect(() => {
    if (route.kind !== 'platform-admin') return
    navigate({ kind: 'admin-organizations' }, { replace: true })
  }, [route.kind, navigate])

  const handleDelete = async (organizationId: string, name: string) => {
    setError(undefined)
    let preview: OrganizationDeletionPreview
    try {
      preview = await fetchDeletionPreview(organizationId)
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
      return
    }

    // ADMIN-5's own "names exactly what will be deleted before it happens" —
    // read into the confirmation itself, not a separate screen an
    // administrator could click past without seeing it.
    const typed = await prompt({
      title: `Delete ${name}?`,
      description:
        `This permanently deletes ${preview.courses} course(s), ` +
        `${preview.people} student record(s), ${preview.conversations} conversation(s), ` +
        `${preview.messages} message(s), ${preview.enrolments} enrolment(s), ` +
        `${preview.courseAttachments} knowledge file(s) and its Discord server binding, if any. ` +
        (preview.queuedJobs > 0
          ? `${preview.queuedJobs} job(s) still queued or running for it will be deleted too — ` +
            'an export in progress will not produce a file. '
          : '') +
        'This cannot be undone. Type the organization’s name to confirm.',
      label: 'Organization name',
      placeholder: name,
      confirmLabel: 'Delete',
      destructive: true,
      validate: (value) =>
        value === name ? undefined : 'Type the name exactly to confirm.',
    })
    if (typed === undefined) return

    setDeletingId(organizationId)
    try {
      await deleteTenant(organizationId, typed)
      refresh()
      refreshDeletions()
      // WEB-33 — a delete started from the organization's *own* address
      // leaves that address naming something that no longer exists, which
      // would render `NotFound` the moment the refreshed read lands. Go back
      // to the list, where the operator can see the deletion took effect.
      if (route.kind === 'admin-organization') {
        navigate({ kind: 'admin-organizations' }, { replace: true })
      }
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setDeletingId(undefined)
    }
  }

  // ADMIN-6 — Approve/Unapprove refresh whichever of the two screens
  // (`'admin-courses'`'s own list, `'admin-course'`'s own detail) is
  // actually current, rather than always the list: a decision made from
  // the detail screen must show up there too, not only once an operator
  // navigates back.
  const refreshCurrentCourseScreen = () => {
    if (route.kind === 'admin-course') refreshCourseDetail(route.courseId)
    else refreshCourses()
  }

  // WEB-53's Approve button — not destructive, runs immediately, the same
  // "enabling is not destructive" treatment `components/CourseRows.tsx`'s
  // own toggle already gives the non-destructive direction of that choice.
  const handleApprove = async (courseId: string) => {
    setError(undefined)
    setDecidingCourseId(courseId)
    try {
      await approveAdminCourse(courseId)
      refreshCurrentCourseScreen()
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setDecidingCourseId(undefined)
    }
  }

  // WEB-53's Unapprove button — the destructive direction (a course stops
  // answering the moment this lands), confirmed through this panel's one
  // modal, the same plain `confirm()` `components/CourseRows.tsx`'s own
  // disable-a-course confirmation already uses — no typed name, unlike
  // ADMIN-5's own delete: revoking an approval is reversible (an
  // administrator can simply approve again), where deleting a tenant is
  // not.
  //
  // ADMIN-6 — takes only `{ courseId, courseTitle }`, not the full
  // `AdminCourseSummary`: the detail screen's own `AdminCourseDetail` names
  // both under the same two field names, so this one handler serves both
  // screens without either reshaping the other's response to match.
  const handleUnapprove = async (course: {
    courseId: string
    courseTitle: string
  }) => {
    setError(undefined)
    const confirmed = await confirm({
      title: `Unapprove ${course.courseTitle}?`,
      description:
        'This course stops answering questions until a platform administrator approves it again.',
      confirmLabel: 'Unapprove',
      destructive: true,
    })
    if (!confirmed) return

    setDecidingCourseId(course.courseId)
    try {
      await unapproveAdminCourse(course.courseId)
      refreshCurrentCourseScreen()
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setDecidingCourseId(undefined)
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6 pb-[calc(var(--spacing-footer)+1.5rem)]">
      <div className="flex items-center justify-between">
        <h1 className="text-page-title font-semibold text-neutral-900">
          Platform administration
        </h1>
        <Button variant="secondary" onClick={onBack}>
          Back to the panel
        </Button>
      </div>

      {/* WEB-54 — every one of the console's five screens, above whichever
          is current. */}
      <AdminNav route={route} navigate={navigate} />

      {error && <ErrorMessage error={error} />}

      {route.kind === 'admin-organization' ? (
        <OrganizationDetail
          organizationId={route.organizationId}
          data={data}
          failed={error !== undefined}
          deletingId={deletingId}
          onDelete={handleDelete}
          onBack={() => navigate({ kind: 'admin-organizations' })}
        />
      ) : route.kind === 'admin-deletions' ? (
        <DeletionsView
          deletions={deletions}
          failed={error !== undefined}
          onBack={() => navigate({ kind: 'admin-organizations' })}
        />
      ) : route.kind === 'admin-courses' ? (
        <CoursesView
          courses={courses}
          failed={error !== undefined}
          decidingCourseId={decidingCourseId}
          onOpen={(courseId) => navigate({ kind: 'admin-course', courseId })}
          onApprove={handleApprove}
          onUnapprove={handleUnapprove}
          onBack={() => navigate({ kind: 'admin-organizations' })}
        />
      ) : route.kind === 'admin-course' ? (
        <CourseDetailView
          courseId={route.courseId}
          course={courseDetail}
          notFound={courseNotFound}
          failed={error !== undefined}
          decidingCourseId={decidingCourseId}
          onApprove={handleApprove}
          onUnapprove={handleUnapprove}
          onBack={() => navigate({ kind: 'admin-courses' })}
        />
      ) : (
        <OrganizationsList
          data={data}
          failed={error !== undefined}
          deletingId={deletingId}
          onOpen={(organizationId) =>
            navigate({ kind: 'admin-organization', organizationId })
          }
          onDelete={handleDelete}
          onViewDeletions={() => navigate({ kind: 'admin-deletions' })}
          onViewCourses={() => navigate({ kind: 'admin-courses' })}
        />
      )}

      {/* WEB-54 — fixed to the console's own viewport bottom, on every
          screen; the outer `<div>`'s own `pb-[calc(...)]` above keeps the
          last row of a long list clear of it. */}
      <AdminHealthFooter data={data} />
    </div>
  )
}

/** WEB-33's `'admin-organizations'` screen — unchanged from what `Admin` rendered directly before this slice, aside from the organization's own name now being a link into `'admin-organization'` and the deletion history moving to its own address (below `OrganizationsList`'s own link to it). */
function OrganizationsList({
  data,
  failed,
  deletingId,
  onOpen,
  onDelete,
  onViewDeletions,
  onViewCourses,
}: {
  data: AdminOrganizationsResponse | undefined
  /** True once the read this screen renders from has failed — the refusal itself is already on screen above (`Admin`'s own `ErrorMessage`), so this screen must not also claim to still be loading. Restores the `!error &&` guard the split into three screens dropped: a non-administrator reaching `/platform-admin` saw the 403 *and* a permanent "Loading…" underneath it. */
  failed: boolean
  deletingId: string | undefined
  onOpen: (organizationId: string) => void
  onDelete: (organizationId: string, name: string) => void
  onViewDeletions: () => void
  /** WEB-53 — the console's own entry point into the Courses screen. */
  onViewCourses: () => void
}) {
  return (
    <>
      {data === undefined ? (
        failed ? null : (
          // WEB-45: shaped like the `<li>` organizations just below.
          // `failed` above is what keeps this from reappearing under a
          // refusal `Admin`'s own `ErrorMessage` already shows (`failed`'s
          // own doc comment on the past bug this guards against).
          <div className="flex flex-col gap-3">
            <SkeletonRow />
            <SkeletonRow />
            <LoadingStatus />
          </div>
        )
      ) : data.organizations.length === 0 ? (
        <p className="text-sm text-neutral-500">No organizations yet.</p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="admin-organizations">
          {data.organizations.map((organization) => (
            <li
              key={organization.organizationId}
              data-testid={`admin-org-${organization.organizationId}`}
              className="flex flex-col gap-2 rounded-md border border-neutral-200 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <button
                  type="button"
                  onClick={() => onOpen(organization.organizationId)}
                  className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
                >
                  {organization.organizationName}
                </button>
                <p className="text-xs text-neutral-500">
                  {formatMicros(organization.totalCostMicros)} spent ·{' '}
                  {organization.callCount} call(s)
                  {organization.estimatedCostMicros > 0 &&
                    ' · partly estimated'}
                </p>
                {organization.bySurface.length > 0 && (
                  // COST-7 — the total above, broken down by surface.
                  <p className="text-xs text-neutral-400">
                    By surface: {formatBySurface(organization.bySurface)}
                  </p>
                )}
              </div>
              <Button
                variant="destructive"
                icon={<DeleteIcon aria-hidden="true" className="size-4" />}
                onClick={() =>
                  onDelete(
                    organization.organizationId,
                    organization.organizationName
                  )
                }
                disabled={deletingId === organization.organizationId}
              >
                {deletingId === organization.organizationId
                  ? 'Deleting…'
                  : 'Delete'}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <Button variant="secondary" onClick={onViewCourses}>
          Courses
        </Button>
        <Button variant="secondary" onClick={onViewDeletions}>
          Deletion history
        </Button>
      </div>
    </>
  )
}

/** WEB-33's `'admin-organization'` screen — one organization's own card, reached by name from the list, so its own address can be shared directly. Resolved against `data` (the same `fetchAdminOrganizations` read `OrganizationsList` renders from) rather than a fetch of its own — mirrors `pages/ProjectsPanel.tsx`'s own `useResolvedProject`, the identical "no single-item read exists, so search the list" shape. */
function OrganizationDetail({
  organizationId,
  data,
  failed,
  deletingId,
  onDelete,
  onBack,
}: {
  organizationId: string
  data: AdminOrganizationsResponse | undefined
  /** See `OrganizationsList`'s own `failed` — same reason, same treatment. */
  failed: boolean
  deletingId: string | undefined
  onDelete: (organizationId: string, name: string) => void
  onBack: () => void
}) {
  if (data === undefined) {
    if (failed) return null
    // WEB-45: shaped like the card just below, once `organization` resolves.
    return (
      <div className="flex flex-col gap-3">
        <SkeletonRow />
        <LoadingStatus />
      </div>
    )
  }

  const organization: AdminOrganizationSummary | undefined =
    data.organizations.find(
      (candidate) => candidate.organizationId === organizationId
    )

  // An address naming an organization not in this read at all — deleted
  // since, or never real — gets the same not-found treatment the rest of
  // the panel gives (`pages/NotFound.tsx`), never an empty screen.
  if (organization === undefined) {
    return <NotFound onHome={onBack} />
  }

  return (
    <div
      className="flex flex-col gap-4"
      data-testid={`admin-org-detail-${organization.organizationId}`}
    >
      <Button variant="secondary" onClick={onBack}>
        ← Organizations
      </Button>
      <div className="flex flex-col gap-2 rounded-md border border-neutral-200 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-neutral-900">
            {organization.organizationName}
          </p>
          <p className="text-xs text-neutral-500">
            {formatMicros(organization.totalCostMicros)} spent ·{' '}
            {organization.callCount} call(s)
            {organization.estimatedCostMicros > 0 && ' · partly estimated'}
          </p>
          {organization.bySurface.length > 0 && (
            // COST-7 — the total above, broken down by surface.
            <p className="text-xs text-neutral-400">
              By surface: {formatBySurface(organization.bySurface)}
            </p>
          )}
        </div>
        <Button
          variant="destructive"
          icon={<DeleteIcon aria-hidden="true" className="size-4" />}
          onClick={() =>
            onDelete(organization.organizationId, organization.organizationName)
          }
          disabled={deletingId === organization.organizationId}
        >
          {deletingId === organization.organizationId ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
    </div>
  )
}

/** WEB-33's `'admin-deletions'` screen — ADMIN-5's own audit trail, unchanged in content from what `Admin` rendered inline before this slice, now at its own address. */
function DeletionsView({
  deletions,
  failed,
  onBack,
}: {
  deletions: TenantDeletion[] | undefined
  /** See `OrganizationsList`'s own `failed` — same reason, same treatment. */
  failed: boolean
  onBack: () => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <Button variant="secondary" onClick={onBack}>
        ← Organizations
      </Button>
      <h2 className="text-sm font-semibold text-neutral-900">
        Deletion history
      </h2>
      {deletions === undefined ? (
        failed ? null : (
          // WEB-45: shaped like the `<li>` deletions just below. `failed`
          // above is the same guard `OrganizationsList`'s own doc comment
          // explains — the refusal is already on screen, this must not
          // also claim to still be loading.
          <div className="flex flex-col gap-2">
            <SkeletonRow />
            <SkeletonRow />
            <LoadingStatus />
          </div>
        )
      ) : deletions.length === 0 ? (
        <p className="text-sm text-neutral-500">No deletions yet.</p>
      ) : (
        <ul
          className="flex flex-col gap-2"
          data-testid="admin-tenant-deletions"
        >
          {deletions.map((deletion) => (
            <li
              key={deletion.id}
              className="rounded-md border border-neutral-200 p-3 text-xs text-neutral-600"
            >
              <span className="font-medium text-neutral-900">
                {deletion.organizationName}
              </span>{' '}
              — deleted {new Date(deletion.deletedAt).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * WEB-33's `'admin-courses'` screen — pending courses first, each with an
 * Approve button, then approved courses with an Unapprove one. Since
 * ADMIN-6, a row's own title is a link into `'admin-course'` — this file's
 * own module comment.
 */
function CoursesView({
  courses,
  failed,
  decidingCourseId,
  onOpen,
  onApprove,
  onUnapprove,
  onBack,
}: {
  courses: AdminCourseSummary[] | undefined
  /** See `OrganizationsList`'s own `failed` — same reason, same treatment. */
  failed: boolean
  decidingCourseId: string | undefined
  /** ADMIN-6 — a row's own title, clicked. */
  onOpen: (courseId: string) => void
  onApprove: (courseId: string) => void
  onUnapprove: (course: { courseId: string; courseTitle: string }) => void
  onBack: () => void
}) {
  if (courses === undefined) {
    if (failed) {
      return (
        <Button variant="secondary" onClick={onBack}>
          ← Organizations
        </Button>
      )
    }
    // WEB-45: shaped like the `<li>` rows below, once the read resolves.
    return (
      <div className="flex flex-col gap-3">
        <SkeletonRow />
        <SkeletonRow />
        <LoadingStatus />
      </div>
    )
  }

  const pending = courses.filter((course) => course.aiApprovedAt === null)
  const approved = courses.filter((course) => course.aiApprovedAt !== null)

  return (
    <div className="flex flex-col gap-4">
      <Button variant="secondary" onClick={onBack}>
        ← Organizations
      </Button>
      <h2 className="text-sm font-semibold text-neutral-900">
        Pending approval
      </h2>
      {pending.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No courses awaiting approval.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="admin-courses-pending">
          {pending.map((course) => (
            <li
              key={course.courseId}
              data-testid={`admin-course-${course.courseId}`}
              className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <CourseRowDetail course={course} onOpen={onOpen} />
              <Button
                variant="primary"
                onClick={() => onApprove(course.courseId)}
                disabled={decidingCourseId === course.courseId}
              >
                {decidingCourseId === course.courseId
                  ? 'Approving…'
                  : 'Approve'}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <h2 className="text-sm font-semibold text-neutral-900">Approved</h2>
      {approved.length === 0 ? (
        <p className="text-sm text-neutral-500">No approved courses yet.</p>
      ) : (
        <ul
          className="flex flex-col gap-2"
          data-testid="admin-courses-approved"
        >
          {approved.map((course) => (
            <li
              key={course.courseId}
              data-testid={`admin-course-${course.courseId}`}
              className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <CourseRowDetail course={course} onOpen={onOpen} />
              <Button
                variant="destructive"
                onClick={() => onUnapprove(course)}
                disabled={decidingCourseId === course.courseId}
              >
                {decidingCourseId === course.courseId
                  ? 'Unapproving…'
                  : 'Unapprove'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** WEB-53's own identifying detail for one course row — title, project, organization, owner(s) and when created, plus (for an approved course) who approved it and when. Shared between the pending and approved lists above, the same "one row shape, two action columns" the `<Button>` alone differs between. ADMIN-6 — the title is now a link into `'admin-course'`, the same underlined-button-as-link treatment `OrganizationsList`'s own name already uses for `'admin-organization'`. */
function CourseRowDetail({
  course,
  onOpen,
}: {
  course: AdminCourseSummary
  onOpen: (courseId: string) => void
}) {
  return (
    <div>
      <button
        type="button"
        onClick={() => onOpen(course.courseId)}
        className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
      >
        {course.courseTitle}
      </button>
      <p className="text-xs text-neutral-500">
        {course.projectName} · {course.organizationName}
        {course.ownerEmails.length > 0 && ` · ${course.ownerEmails.join(', ')}`}
      </p>
      <p className="text-xs text-neutral-400">
        Created {new Date(course.createdAt).toLocaleString()}
        {course.aiApprovedAt !== null &&
          ` · approved ${new Date(course.aiApprovedAt).toLocaleString()}${
            course.aiApprovedByEmail ? ` by ${course.aiApprovedByEmail}` : ''
          }`}
      </p>
    </div>
  )
}

/**
 * ADMIN-6's own `'admin-course'` screen — one course's settings, read-only,
 * reached by clicking a row on `CoursesView` above. Grouped General/AI/
 * Knowledge the way `pages/CourseEditor.tsx` groups them for the course's
 * own owner (`docs/SPEC.md` §41's own words), rendered directly rather than
 * through that component — `CourseEditor` is a large form wired to
 * organization-scoped actions (`dispatchAction`) this console deliberately
 * never calls (this file's own module comment on why every read here goes
 * through `routes/admin.ts` instead); reusing it here would mean either
 * contorting it to take a second, read-only data source, or leaving dead
 * editable affordances behind a `readOnly` flag nobody asked for. See
 * `docs/DECISIONS.md` D-118.
 *
 * Approve/Unapprove are rendered here too (the brief's own "this is where
 * the decision gets made"), reusing `Admin`'s own two handlers — a decision
 * made from this screen refreshes this screen (`refreshCurrentCourseScreen`,
 * above), not only the list an operator would otherwise have to navigate
 * back to to see it take effect.
 */
function CourseDetailView({
  courseId,
  course,
  notFound,
  failed,
  decidingCourseId,
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
  onApprove: (courseId: string) => void
  onUnapprove: (course: { courseId: string; courseTitle: string }) => void
  onBack: () => void
}) {
  if (notFound) {
    return <NotFound onHome={onBack} />
  }

  // `course.courseId !== courseId` — a stale read from the *previous*
  // address, still in `course` because `refreshCourseDetail`'s own request
  // has not resolved yet, would otherwise flash under the new one for one
  // render (`Admin`'s own effect already clears this to `undefined` first,
  // but a caller that skips that guard is not a case worth trusting away).
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

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-page-title font-semibold text-neutral-900">
            {course.courseTitle}
          </h2>
          <p className="text-xs text-neutral-500">
            {course.projectName} · {course.organizationName}
          </p>
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
            onClick={() => onApprove(course.courseId)}
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

      {/* WEB-35's own three of five groups — Discord, Roster and People stay
          out of this screen entirely: the first has no place in a
          three-group read (this file's own module comment/D-118), and the
          latter two are exactly ADMIN-4's own boundary (never a person, an
          enrolment or anything that could identify a student). */}
      <section
        aria-label="General"
        className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
      >
        <h3 className="text-section-title font-semibold text-neutral-900">
          General
        </h3>
        {/* Must-fix, second review round: a `<dt>`/`<dd>` pair with no `<dl>`
            ancestor is invalid HTML, and it drops exactly the description-
            list semantics `ReadOnlyField`'s own doc comment gives as the
            reason to use `<dt>`/`<dd>` over a disabled `<input>` in the
            first place. Wrapped the same way `pages/Home.tsx`'s own
            "What it does" list and `pages/Mcp.tsx`'s own per-client field
            lists already wrap theirs — a `<dl>` around the series of
            `<div>`s each `ReadOnlyField` renders. */}
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
              // No stable id in `AdminCourseAttachment` (metadata only,
              // `routes/admin.ts`'s own doc comment) — index is safe here:
              // this list is read-only and never reorders itself.
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
    </div>
  )
}

/**
 * ADMIN-6 — a label/value pair rendered as plain text, never a control a
 * person can type into: this screen's own "nothing editable" requirement
 * (the brief's own words), so every setting below is a `<dt>`/`<dd>` pair,
 * not a disabled `<input>` — a disabled input still renders as a textbox to
 * assistive technology and to a test asserting "nothing editable" by role,
 * where a plain paragraph does not.
 */
function ReadOnlyField({
  label,
  value,
  multiline = false,
}: {
  label: string
  value: string
  multiline?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
      <dt className="w-48 shrink-0 text-xs font-medium text-neutral-500">
        {label}
      </dt>
      <dd
        className={
          multiline
            ? 'whitespace-pre-wrap text-sm text-neutral-900'
            : 'text-sm text-neutral-900'
        }
      >
        {value}
      </dd>
    </div>
  )
}
