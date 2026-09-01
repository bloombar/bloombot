/**
 * The typed errors themselves (`errors.ts`) and the HTTP status table ACT-4
 * asks for — a pure mapping an eventual API middleware imports, checked here
 * for the shape it promises: one entry per error `code` this package throws.
 */

import { describe, expect, it } from 'vitest'

import {
  ActionConflictError,
  ActionInputError,
  ActionRefusedError,
  HTTP_STATUS_BY_ACTION_ERROR,
  UnknownActionError,
} from '../src/errors.js'

describe('typed action errors', () => {
  it('ActionInputError carries the zod issues that failed', () => {
    const issues = [
      { code: 'invalid_type' as const, path: ['name'], message: 'Required' },
    ]
    // Only the fields this class actually reads are exercised — a full
    // `ZodIssue` has more, but `ActionInputError` never inspects them.
    const error = new ActionInputError(issues as never)
    expect(error.name).toBe('ActionInputError')
    expect(error.code).toBe('action_input_invalid')
    expect(error.issues).toBe(issues)
  })

  it('ActionConflictError carries the repo-level conflict it wraps', () => {
    const conflict = { field: 'name', name: 'Fall 2026', message: 'taken' }
    const error = new ActionConflictError(conflict)
    expect(error.name).toBe('ActionConflictError')
    expect(error.code).toBe('action_conflict')
    expect(error.message).toBe('taken')
    expect(error.conflict).toBe(conflict)
  })

  it('UnknownActionError names the action that was not found', () => {
    const error = new UnknownActionError('projects.delete')
    expect(error.name).toBe('UnknownActionError')
    expect(error.code).toBe('action_unknown')
    expect(error.message).toContain('projects.delete')
  })

  it('every error this package throws has exactly one HTTP status entry', () => {
    const codes = [
      new ActionInputError([]).code,
      new ActionRefusedError().code,
      new ActionConflictError({ message: 'x' }).code,
      new UnknownActionError('x').code,
    ]
    for (const code of codes) {
      expect(typeof HTTP_STATUS_BY_ACTION_ERROR[code]).toBe('number')
    }
    expect(Object.keys(HTTP_STATUS_BY_ACTION_ERROR).sort()).toEqual(
      [...new Set(codes)].sort()
    )
  })
})
