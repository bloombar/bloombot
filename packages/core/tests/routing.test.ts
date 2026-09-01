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
})
