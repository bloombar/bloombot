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
 * that router, not `dispatchAction` — there is no organization id to
 * dispatch within.
 *
 * **ADMIN-4's own boundary, on this page too:** nothing rendered here ever
 * shows a transcript or a message — only an entity's own facts and usage.
 * This app does not hide that boundary by omission alone; `apps/api`'s own
 * response shapes have nothing in them to show even if a screen tried.
 *
 * ADMIN-5's confirmation is the prompt variant of this panel's one modal
 * (`components/modal/`) — an administrator types the organization's own
 * name to proceed, the same "severe enough to warrant the prompt variant"
 * treatment this slice's own brief calls for, never a plain confirm a
 * stray click could pass.
 *
 * **WEB-33 — every screen this console renders is its own address**, under
 * `routing/route.ts#AdminRoute`. See each of the per-screen modules in
 * `pages/admin/` for what each one renders; this module is only the
 * router/fetch shell WEB-33/ADMIN-7..11's own brief asks this file to stay
 * — one `useState`/`useCallback` pair per read, one `useEffect` choosing
 * which of them fires for the route that is current, and the `<AdminNav>`/
 * `<AdminHealthFooter>` every one of those screens shares.
 *
 * **ADMIN-7..ADMIN-11 (phase 40) split this file into a directory.** It had
 * grown past 1300 lines holding five screens' worth of markup in one
 * module; `pages/admin/` now holds one module per screen
 * (`OrganizationsList`, `OrganizationDetail`, `ProjectDetail`,
 * `CoursesView`, `CourseDetailView`, `AccountsList`, `AccountDetail`,
 * `DeletionsView`, `AdminNav`, `AdminHealthFooter`, and the shared
 * formatting helpers in `shared.tsx`), and this file stays the shell that
 * decides which read fires for which route and renders the matching
 * screen. Every `data-testid` this file's own screens carried before the
 * split is unchanged — `apps/web/tests/admin.test.tsx` and four e2e specs
 * depend on them by name, not by which module they now live in.
 *
 * Three new addresses join the console this phase: `'admin-project'`
 * (ADMIN-8, reached from a link on `'admin-organization'` or
 * `'admin-course'`), `'admin-accounts'` (ADMIN-10, the Users list, between
 * Courses and Deletion history in `AdminNav`) and `'admin-account'`
 * (ADMIN-11, reached from a row on `'admin-accounts'` or an account link
 * anywhere else in the console). `'admin-organization'` itself changes
 * shape under the hood: it used to `.find()` a row out of
 * `fetchAdminOrganizations()`'s own list (which never carried a project, a
 * course or a member at all); it now fetches its own richer read,
 * `fetchAdminOrganization(id)`, the same per-entity-read pattern
 * `'admin-course'` already established for ADMIN-6.
 *
 * Every navigation between these pushes (`navigate`, no `{ replace: true }`)
 * — WEB-34's ordinary rule, the same the rest of the panel already follows.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ApiError,
  approveAdminCourse,
  deleteTenant,
  fetchAdminAccount,
  fetchAdminAccounts,
  fetchAdminCourse,
  fetchAdminCourses,
  fetchAdminOrganization,
  fetchAdminOrganizations,
  fetchAdminProject,
  fetchDeletionPreview,
  fetchTenantDeletions,
  unapproveAdminCourse,
} from '../api/client.js'
import type {
  AdminAccountDetail,
  AdminAccountSummary,
  AdminCourseDetail,
  AdminCourseSummary,
  AdminOrganizationDetail,
  AdminOrganizationsResponse,
  AdminProjectDetail,
  OrganizationDeletionPreview,
  TenantDeletion,
} from '../api/types.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { useModal } from '../components/modal/ModalProvider.js'
import type { AdminRoute, Route } from '../routing/route.js'
import { AccountDetail } from './admin/AccountDetail.js'
import { AccountsList } from './admin/AccountsList.js'
import { AdminHealthFooter } from './admin/AdminHealthFooter.js'
import { AdminNav } from './admin/AdminNav.js'
import { CourseDetailView } from './admin/CourseDetail.js'
import { Button } from '../components/Button.js'
import { CoursesView } from './admin/CoursesView.js'
import { DeletionsView } from './admin/DeletionsView.js'
import { OrganizationDetail } from './admin/OrganizationDetail.js'
import { OrganizationsList } from './admin/OrganizationsList.js'
import { ProjectDetail } from './admin/ProjectDetail.js'

export interface AdminScreenProps {
  /** WEB-33 — which of the console's own screens is current. */
  route: AdminRoute
  navigate: (route: Route, options?: { replace?: boolean }) => void
  onBack: () => void
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

  // ADMIN-7 — `'admin-organization'`'s own read, one organization at a
  // time — the same "`undefined` covers loading and stale, `notFound`
  // stands apart from `error`" shape `courseDetail`/`courseNotFound` above
  // already give `'admin-course'`.
  const [organizationDetail, setOrganizationDetail] = useState<
    AdminOrganizationDetail | undefined
  >(undefined)
  const [organizationNotFound, setOrganizationNotFound] = useState(false)

  // ADMIN-8 — `'admin-project'`'s own read, the identical shape one level
  // down.
  const [projectDetail, setProjectDetail] = useState<
    AdminProjectDetail | undefined
  >(undefined)
  const [projectNotFound, setProjectNotFound] = useState(false)

  // ADMIN-10 — the Users list's own read, fetched only for `'admin-accounts'`
  // — no other screen here needs the whole account list, the same "no
  // other screen needs this read" reasoning `refreshCourses` already gives
  // its own sibling.
  const [accounts, setAccounts] = useState<AdminAccountSummary[] | undefined>(
    undefined
  )

  // ADMIN-11 — `'admin-account'`'s own read.
  const [accountDetail, setAccountDetail] = useState<
    AdminAccountDetail | undefined
  >(undefined)
  const [accountNotFound, setAccountNotFound] = useState(false)

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

  // ADMIN-5's own audit trail, read back.
  const refreshDeletions = useCallback(() => {
    fetchTenantDeletions().then(
      (result) => setDeletions(result),
      (caught: unknown) => {
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [])

  // WEB-53 — read only for the Courses screen itself: no other screen here
  // needs a course's own approval state, so there is no reason to pay for
  // this read on every visit to `/platform-admin`.
  const refreshCourses = useCallback(() => {
    fetchAdminCourses().then(
      (result) => setCourses(result.courses),
      (caught: unknown) => {
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [])

  // ADMIN-6/ADMIN-9 — one course's own settings and overview, fetched only
  // for `'admin-course'`. A `course_not_found` (404) is this course id's
  // own state, not a console-wide refusal — kept apart from `error` so it
  // renders `NotFound` rather than the top-level banner.
  //
  // `currentCourseIdRef` guards against an out-of-order response — course
  // A's read is slow, an operator goes back and opens course B (fast), and
  // A's response then lands *after* B's already has. Without this, A's late
  // `.then` would overwrite B's already-rendered detail (or, worse, mark B
  // `courseNotFound` off the back of a stale 404 for A). A plain boolean
  // "ignore late responses" ref would not do: the *next* read for the
  // *same* course (a retry, or Approve's own refresh) has to still be
  // honoured, so this stores which course id is actually current rather
  // than merely whether one read has already landed. Every other
  // per-entity read below (`currentOrganizationIdRef`, `currentProjectIdRef`,
  // `currentAccountIdRef`) guards its own screen the identical way.
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

  // ADMIN-7 — one organization's own console read, the same out-of-order
  // guard `refreshCourseDetail` above already holds itself to.
  const currentOrganizationIdRef = useRef<string | undefined>(undefined)

  const refreshOrganizationDetail = useCallback((organizationId: string) => {
    currentOrganizationIdRef.current = organizationId
    setOrganizationNotFound(false)
    fetchAdminOrganization(organizationId).then(
      (result) => {
        if (currentOrganizationIdRef.current !== organizationId) return
        setOrganizationDetail(result)
      },
      (caught: unknown) => {
        if (currentOrganizationIdRef.current !== organizationId) return
        if (caught instanceof ApiError) {
          if (caught.status === 404) setOrganizationNotFound(true)
          else setError(caught)
        } else throw caught
      }
    )
  }, [])

  // ADMIN-8 — one project's own console read, the same guard again.
  const currentProjectIdRef = useRef<string | undefined>(undefined)

  const refreshProjectDetail = useCallback((projectId: string) => {
    currentProjectIdRef.current = projectId
    setProjectNotFound(false)
    fetchAdminProject(projectId).then(
      (result) => {
        if (currentProjectIdRef.current !== projectId) return
        setProjectDetail(result)
      },
      (caught: unknown) => {
        if (currentProjectIdRef.current !== projectId) return
        if (caught instanceof ApiError) {
          if (caught.status === 404) setProjectNotFound(true)
          else setError(caught)
        } else throw caught
      }
    )
  }, [])

  // ADMIN-10 — the Users list's own read, fired only for `'admin-accounts'`.
  const refreshAccounts = useCallback(() => {
    fetchAdminAccounts().then(
      (result) => setAccounts(result.accounts),
      (caught: unknown) => {
        if (caught instanceof ApiError) setError(caught)
        else throw caught
      }
    )
  }, [])

  // ADMIN-11 — one account's own console read, the same out-of-order guard
  // as every other per-entity read above.
  const currentAccountIdRef = useRef<string | undefined>(undefined)

  const refreshAccountDetail = useCallback((accountId: string) => {
    currentAccountIdRef.current = accountId
    setAccountNotFound(false)
    fetchAdminAccount(accountId).then(
      (result) => {
        if (currentAccountIdRef.current !== accountId) return
        setAccountDetail(result)
      },
      (caught: unknown) => {
        if (currentAccountIdRef.current !== accountId) return
        if (caught instanceof ApiError) {
          if (caught.status === 404) setAccountNotFound(true)
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
  // mount, not on every navigation, so a refusal from either of them would
  // otherwise still be on screen long after an operator has moved on
  // through the nav to a screen that never re-ran either read. Keying on
  // `route.kind` (not the full `route`) clears it the moment the console
  // moves to a different screen, before that screen's own read — if it
  // fires one — has a chance to set a fresh one of its own.
  //
  // **`not_platform_administrator` is exempted — it stays on screen**: it
  // describes this *account*, not this *screen* (ADMIN-4's own gate, made
  // on every route behind `/platform-admin`), so clearing it outright can
  // strand a screen that fires no read of its own on navigation.
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
      // for nobody's own current address.
      currentCourseIdRef.current = undefined
      return
    }
    // A fresh navigation between two courses must not render the previous
    // one under the new address while the new read is still in flight.
    setCourseDetail(undefined)
    refreshCourseDetail(route.courseId)
  }, [
    route.kind,
    route.kind === 'admin-course' ? route.courseId : undefined,
    refreshCourseDetail,
  ])

  // ADMIN-7 — the identical "fetch, guarded by which id is current" effect
  // as `'admin-course'` above, for `'admin-organization'`.
  useEffect(() => {
    if (route.kind !== 'admin-organization') {
      currentOrganizationIdRef.current = undefined
      return
    }
    setOrganizationDetail(undefined)
    refreshOrganizationDetail(route.organizationId)
  }, [
    route.kind,
    route.kind === 'admin-organization' ? route.organizationId : undefined,
    refreshOrganizationDetail,
  ])

  // ADMIN-8 — the same, for `'admin-project'`.
  useEffect(() => {
    if (route.kind !== 'admin-project') {
      currentProjectIdRef.current = undefined
      return
    }
    setProjectDetail(undefined)
    refreshProjectDetail(route.projectId)
  }, [
    route.kind,
    route.kind === 'admin-project' ? route.projectId : undefined,
    refreshProjectDetail,
  ])

  // ADMIN-10 — fired only for `'admin-accounts'`, the same "no other screen
  // needs this read" reasoning `refreshCourses` already gives.
  useEffect(() => {
    if (route.kind !== 'admin-accounts') return
    refreshAccounts()
  }, [route.kind, refreshAccounts])

  // ADMIN-11 — the same guarded fetch as every other per-entity read above,
  // for `'admin-account'`.
  useEffect(() => {
    if (route.kind !== 'admin-account') {
      currentAccountIdRef.current = undefined
      return
    }
    setAccountDetail(undefined)
    refreshAccountDetail(route.accountId)
  }, [
    route.kind,
    route.kind === 'admin-account' ? route.accountId : undefined,
    refreshAccountDetail,
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

      {/* WEB-54 — every one of the console's screens, above whichever is
          current. */}
      <AdminNav route={route} navigate={navigate} />

      {error && <ErrorMessage error={error} />}

      {route.kind === 'admin-organization' ? (
        <OrganizationDetail
          organizationId={route.organizationId}
          organization={organizationDetail}
          notFound={organizationNotFound}
          failed={error !== undefined}
          deletingId={deletingId}
          navigate={navigate}
          onDelete={handleDelete}
          onBack={() => navigate({ kind: 'admin-organizations' })}
        />
      ) : route.kind === 'admin-project' ? (
        <ProjectDetail
          projectId={route.projectId}
          project={projectDetail}
          notFound={projectNotFound}
          failed={error !== undefined}
          navigate={navigate}
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
          navigate={navigate}
          onApprove={handleApprove}
          onUnapprove={handleUnapprove}
          onBack={() => navigate({ kind: 'admin-courses' })}
        />
      ) : route.kind === 'admin-accounts' ? (
        <AccountsList
          accounts={accounts}
          failed={error !== undefined}
          navigate={navigate}
          onBack={() => navigate({ kind: 'admin-organizations' })}
        />
      ) : route.kind === 'admin-account' ? (
        <AccountDetail
          accountId={route.accountId}
          account={accountDetail}
          notFound={accountNotFound}
          failed={error !== undefined}
          navigate={navigate}
          onBack={() => navigate({ kind: 'admin-accounts' })}
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
          onViewUsers={() => navigate({ kind: 'admin-accounts' })}
        />
      )}

      {/* WEB-54 — fixed to the console's own viewport bottom, on every
          screen; the outer `<div>`'s own `pb-[calc(...)]` above keeps the
          last row of a long list clear of it. */}
      <AdminHealthFooter data={data} />
    </div>
  )
}
