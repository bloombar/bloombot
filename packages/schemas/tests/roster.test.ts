/**
 * Tests for the roster CSV schema (ROST-9). Fixtures are written inline
 * here, never read from `rosters/` or `results/` — this slice's own brief
 * is explicit that those may hold real students' names and emails and must
 * never be touched, even for a fixture.
 */

import { describe, expect, it } from 'vitest'

import { parseRosterCsv } from '../src/roster.js'

const HEADER = 'First,Last,Email,Discord,GitHub'

describe('parseRosterCsv', () => {
  // ROST-9: two good rows and one malformed row (no Discord handle) —
  // the two import, the third is reported with its own line number.
  it('imports the rows that parse and reports a malformed row with its line number', () => {
    const csv = [
      HEADER,
      'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      'Alan,Turing,alan@example.edu,,aturing', // no Discord handle
      'Grace,Hopper,grace@example.edu,gracehopper,ghopper',
    ].join('\n')

    const result = parseRosterCsv(csv)

    expect(result.rows).toHaveLength(2)
    expect(result.rows.map((r) => r.row.email)).toEqual([
      'ada@example.edu',
      'grace@example.edu',
    ])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ line: 3 })
    expect(result.errors[0]?.message).toMatch(/Discord handle is required/)
  })

  it('reports a row with no "@" in its email, by line number, without stopping the rest of the roster', () => {
    const csv = [
      HEADER,
      'Ada,Lovelace,not-an-email,adalovelace,adal',
      'Grace,Hopper,grace@example.edu,gracehopper,ghopper',
    ].join('\n')

    const result = parseRosterCsv(csv)

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.row.email).toBe('grace@example.edu')
    expect(result.errors).toEqual([
      { line: 2, message: expect.stringContaining('@') as unknown as string },
    ])
  })

  it('defaults First/Last/GitHub to empty strings when blank, matching the Python reader\'s row.get(key, "")', () => {
    const csv = [HEADER, ',,ada@example.edu,adalovelace,'].join('\n')

    const result = parseRosterCsv(csv)

    expect(result.errors).toEqual([])
    expect(result.rows[0]?.row).toEqual({
      first: '',
      last: '',
      email: 'ada@example.edu',
      discord: 'adalovelace',
      github: '',
    })
  })

  it('handles a quoted field containing a comma', () => {
    const csv = [
      HEADER,
      '"Lovelace, Ada",Lovelace,ada@example.edu,adalovelace,adal',
    ].join('\n')

    const result = parseRosterCsv(csv)

    expect(result.errors).toEqual([])
    expect(result.rows[0]?.row.first).toBe('Lovelace, Ada')
  })

  it('reports a file missing a required column, rather than misreading every row', () => {
    const csv = [
      'First,Last,Email,GitHub',
      'Ada,Lovelace,ada@example.edu,adal',
    ].join('\n')

    const result = parseRosterCsv(csv)

    expect(result.rows).toEqual([])
    expect(result.errors).toEqual([
      {
        line: 1,
        message: expect.stringContaining('Discord') as unknown as string,
      },
    ])
  })

  it('skips a genuinely blank trailing line without reporting it as an error', () => {
    const csv = [
      HEADER,
      'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      '',
    ].join('\n')

    const result = parseRosterCsv(csv)

    expect(result.rows).toHaveLength(1)
    expect(result.errors).toEqual([])
  })
})
