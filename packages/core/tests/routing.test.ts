/**
 * CORE-2: category wins, roles are the fallback, no match is unmatched, and
 * two matches on one signal is reported as an ambiguity rather than resolved
 * silently. Pure — `routeMessage` touches no database and no model, so
 * these tests need neither.
 */

import { describe, expect, it } from 'vitest'

import { routeMessage, type RoutableCourse } from '../src/routing.js'

const webDesign: RoutableCourse = {
  id: 'course-web-design',
  categoryNames: ['Web Design'],
  adminsRole: 'admins-wd',
  studentsRole: 'students-wd',
  enabled: true,
}

const dataScience: RoutableCourse = {
  id: 'course-data-science',
  categoryNames: ['Data Science'],
  adminsRole: 'admins-ds',
  studentsRole: 'students-ds',
  enabled: true,
}

describe('routeMessage (CORE-2)', () => {
  it('matches by category — this test fails without CORE-2s category signal', () => {
    const result = routeMessage([webDesign, dataScience], {
      categoryName: 'Web Design',
      channelName: 'general',
      roleNames: [],
    })
    expect(result).toEqual({ kind: 'matched', course: webDesign })
  })

  it('falls back to the roles when the category matches nothing', () => {
    const result = routeMessage([webDesign, dataScience], {
      categoryName: 'Uncategorized DMs',
      channelName: null,
      roleNames: ['students-ds'],
    })
    expect(result).toEqual({ kind: 'matched', course: dataScience })
  })

  it('falls back to the roles when there is no category at all (a DM)', () => {
    const result = routeMessage([webDesign, dataScience], {
      categoryName: null,
      channelName: null,
      roleNames: ['admins-wd'],
    })
    expect(result).toEqual({ kind: 'matched', course: webDesign })
  })

  it('matches the admin role, not only the student role (BOT-12)', () => {
    const result = routeMessage([webDesign], {
      categoryName: null,
      channelName: null,
      roleNames: ['admins-wd'],
    })
    expect(result).toEqual({ kind: 'matched', course: webDesign })
  })

  it('is unmatched — and therefore unanswered — when neither signal matches anything', () => {
    const result = routeMessage([webDesign, dataScience], {
      categoryName: 'Uncategorized DMs',
      channelName: null,
      roleNames: ['some-other-role'],
    })
    expect(result).toEqual({ kind: 'unmatched' })
  })

  it('reports a category matched by two courses as an ambiguity, not a silent pick', () => {
    const duplicateCategory: RoutableCourse = {
      id: 'course-duplicate',
      categoryNames: ['Web Design'],
      adminsRole: 'admins-dup',
      studentsRole: 'students-dup',
      enabled: true,
    }
    const result = routeMessage([webDesign, duplicateCategory], {
      categoryName: 'Web Design',
      channelName: 'general',
      roleNames: [],
    })
    expect(result).toEqual({
      kind: 'ambiguous',
      signal: 'category',
      courseIds: [webDesign.id, duplicateCategory.id],
    })
  })

  it('reports a role held by two courses as an ambiguity, not a silent pick', () => {
    const sharedRole: RoutableCourse = {
      id: 'course-shared-role',
      categoryNames: ['Something Else'],
      adminsRole: 'admins-wd',
      studentsRole: 'students-shared',
      enabled: true,
    }
    const result = routeMessage([webDesign, sharedRole], {
      categoryName: null,
      channelName: null,
      roleNames: ['admins-wd'],
    })
    expect(result).toEqual({
      kind: 'ambiguous',
      signal: 'role',
      courseIds: [webDesign.id, sharedRole.id],
    })
  })

  // Finding 1 of the CORE-1 rework: an ended course must stop being
  // answered through routing, not just through `answerQuestion`'s own
  // guard — the two are reached by different callers.
  it('is unmatched — not answered — when the only course whose category matches is disabled', () => {
    const disabledWebDesign: RoutableCourse = { ...webDesign, enabled: false }
    const result = routeMessage([disabledWebDesign, dataScience], {
      categoryName: 'Web Design',
      channelName: 'general',
      roleNames: [],
    })
    expect(result).toEqual({ kind: 'unmatched' })
  })

  it('is unmatched — not answered — when the only course whose role matches is disabled', () => {
    const disabledWebDesign: RoutableCourse = { ...webDesign, enabled: false }
    const result = routeMessage([disabledWebDesign, dataScience], {
      categoryName: null,
      channelName: null,
      roleNames: ['admins-wd'],
    })
    expect(result).toEqual({ kind: 'unmatched' })
  })

  // A disabled course's retained category name must not survive to force a
  // spurious ambiguity that silences the live course still using it.
  it('matches the still-enabled course outright, rather than reporting an ambiguity against a disabled course sharing its category', () => {
    const disabledDuplicate: RoutableCourse = {
      id: 'course-disabled-duplicate',
      categoryNames: ['Web Design'],
      adminsRole: 'admins-dup',
      studentsRole: 'students-dup',
      enabled: false,
    }
    const result = routeMessage([webDesign, disabledDuplicate], {
      categoryName: 'Web Design',
      channelName: 'general',
      roleNames: [],
    })
    expect(result).toEqual({ kind: 'matched', course: webDesign })
  })

  // PROJ-7: a course may name no role at all — the platform then does not
  // attempt role-based identification for it. `Set<string>.has(null)` is
  // `false` at runtime regardless of the explicit `!== null` guard in
  // `routing.ts` — so this test (and "does not make an otherwise-unambiguous
  // message ambiguous", below) do not fail if that guard is removed; only
  // `tsc` objects to the resulting type error (`roleNames.has(null)` against
  // a `Set<string>`). What they still pin down: a role-less course is inert
  // for an author holding no role, and does not create a spurious ambiguity,
  // regardless of *how* that is implemented. The one case with genuine
  // runtime teeth is the next test, which rules out coalescing an absent
  // role to `''` (`course.adminsRole ?? ''`) rather than checking it for
  // `null` explicitly — that variant really would treat a role named `''`
  // as a match.
  it('a role-less course is never a role match, even for an author holding no role at all', () => {
    const roleless: RoutableCourse = {
      id: 'course-roleless',
      categoryNames: ['Something Else'],
      adminsRole: null,
      studentsRole: null,
      enabled: true,
    }
    const result = routeMessage([roleless], {
      categoryName: null,
      channelName: null,
      roleNames: [],
    })
    expect(result).toEqual({ kind: 'unmatched' })
  })

  // The exact danger this slice's own brief names: a role-less course must
  // not match every author. A course whose absent role were ever coalesced
  // to `''` (`course.adminsRole ?? ''`) rather than checked explicitly for
  // `null` would wrongly match an author who — however unlikely — holds a
  // Discord role literally named the empty string, since `roleNames` would
  // then contain `''` too. This fails against that implementation and
  // passes against the real one, which never produces `''` at all.
  it('a role-less course does not match an author holding a role literally named the empty string', () => {
    const roleless: RoutableCourse = {
      id: 'course-roleless',
      categoryNames: ['Something Else'],
      adminsRole: null,
      studentsRole: null,
      enabled: true,
    }
    const result = routeMessage([roleless], {
      categoryName: null,
      channelName: null,
      roleNames: [''],
    })
    expect(result).toEqual({ kind: 'unmatched' })
  })

  it('a role-less course does not make an otherwise-unambiguous message ambiguous', () => {
    const rolelessOne: RoutableCourse = {
      id: 'course-roleless-one',
      categoryNames: ['Something Else'],
      adminsRole: null,
      studentsRole: null,
      enabled: true,
    }
    const rolelessTwo: RoutableCourse = {
      id: 'course-roleless-two',
      categoryNames: ['Yet Another'],
      adminsRole: null,
      studentsRole: null,
      enabled: true,
    }
    // Same caveat as the first test above: this does not fail if the
    // `!== null` guard is removed (`Set<string>.has(null)` is already
    // `false` at runtime), only if `null` were ever coalesced to `''`
    // first. Pinned here anyway, alongside `webDesign`, so a later reader
    // has a worked example of "role-less does not manufacture an
    // ambiguity" next to "a real role match still wins."
    const result = routeMessage([rolelessOne, rolelessTwo, webDesign], {
      categoryName: null,
      channelName: null,
      roleNames: ['admins-wd'],
    })
    expect(result).toEqual({ kind: 'matched', course: webDesign })
  })

  it('a course with only one role set still matches on that one', () => {
    const adminsOnly: RoutableCourse = {
      id: 'course-admins-only',
      categoryNames: ['Something Else'],
      adminsRole: 'admins-only-course',
      studentsRole: null,
      enabled: true,
    }
    const result = routeMessage([adminsOnly], {
      categoryName: null,
      channelName: null,
      roleNames: ['admins-only-course'],
    })
    expect(result).toEqual({ kind: 'matched', course: adminsOnly })
  })
})
