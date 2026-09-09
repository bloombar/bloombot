/**
 * PORT-1/PORT-7: the course export format reads back what it wrote, and
 * refuses everything else by saying which of the several possible things is
 * wrong with it — a malformed file, a file from another program, and a file
 * from a newer build are three different problems.
 */

import { describe, expect, it } from 'vitest'

import {
  COURSE_EXPORT_KIND,
  COURSE_EXPORT_VERSION,
  readCourseExport,
  type CourseExportFile,
} from '../src/index.js'

/** A minimal valid file, which each test below then breaks in exactly one way. */
function validFile(): CourseExportFile {
  return {
    bloombotCourseExport: COURSE_EXPORT_VERSION,
    kind: COURSE_EXPORT_KIND,
    exportedAt: '2026-09-08T00:00:00.000Z',
    course: {
      title: 'Web Design',
      adminsRole: 'admins-wd-fa26',
      studentsRole: 'students-wd-fa26',
      model: 'gpt-5',
      instructions: 'Be helpful.',
      maxRequestsPerDay: 50,
      conversationScope: 'course',
      categories: [
        {
          name: 'Web Design - GLOBAL',
          channels: [
            { name: 'chat', adminsOnly: false },
            { name: 'staff', adminsOnly: true },
          ],
        },
      ],
      websites: ['example.edu'],
    },
    notCarried: {
      vectorStore: true,
      storedPrompt: false,
      attachments: 2,
      discordServer: true,
    },
  }
}

describe('readCourseExport', () => {
  it('accepts a well-formed file and hands back exactly what it read', () => {
    const result = readCourseExport(validFile())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.course.title).toBe('Web Design')
    expect(result.file.course.categories[0]?.channels).toHaveLength(2)
    expect(result.file.course.websites).toEqual(['example.edu'])
    expect(result.file.notCarried.attachments).toBe(2)
  })

  it('accepts nulls where a course simply has no setting', () => {
    const file = validFile()
    const result = readCourseExport({
      ...file,
      course: {
        ...file.course,
        model: null,
        instructions: null,
        maxRequestsPerDay: null,
      },
    })
    expect(result.ok).toBe(true)
  })

  it('refuses something that is not an object at all', () => {
    const result = readCourseExport('just a string')
    expect(result).toEqual({
      ok: false,
      reason: 'That file is not a course export — it holds no course.',
    })
  })

  it('refuses a document with no version, as not one of ours', () => {
    const result = readCourseExport({ course: { title: 'Web Design' } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('not a course export')
  })

  it('tells a newer file apart from a broken one', () => {
    const result = readCourseExport({
      ...validFile(),
      bloombotCourseExport: 99,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('version 99')
    expect(result.reason).toContain(`version ${COURSE_EXPORT_VERSION}`)
  })

  it('names where a well-versioned file went wrong', () => {
    const file = validFile()
    const result = readCourseExport({
      ...file,
      course: { ...file.course, title: '' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('course.title')
  })

  it('refuses a key it does not recognize rather than dropping it', () => {
    const file = validFile()
    const result = readCourseExport({
      ...file,
      course: { ...file.course, roster: [{ email: 'ada@example.edu' }] },
    })
    // PORT-2 — there is no field for a person here, and a file carrying one
    // is refused rather than imported with it quietly ignored.
    expect(result.ok).toBe(false)
  })

  it('refuses a conversation scope this platform does not have', () => {
    const file = validFile()
    const result = readCourseExport({
      ...file,
      course: { ...file.course, conversationScope: 'per-message' },
    })
    expect(result.ok).toBe(false)
  })
})
