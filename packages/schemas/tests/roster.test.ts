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

  // Rework finding 1: the old scanner toggled quoted mode on *any* `"`,
  // wherever it fell in a field — so a typo like `O"Brien` (a stray quote
  // mid-field, never one opening a field) put the rest of the file inside
  // one giant "quoted" field. Three valid rows collapsed to zero rows and
  // one error. A `"` only opens a field when it is that field's very first
  // character (RFC 4180 §2.5); anywhere else it is just a character.
  it('does not let a stray mid-field quote (a typo like O"Brien) swallow the rest of the file', () => {
    const csv = [
      HEADER,
      'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      'Conor,O"Brien,conor@example.edu,cobrien,cob',
      'Grace,Hopper,grace@example.edu,gracehopper,ghopper',
    ].join('\n')

    const result = parseRosterCsv(csv)

    expect(result.errors).toEqual([])
    expect(result.rows.map((r) => r.row.email)).toEqual([
      'ada@example.edu',
      'conor@example.edu',
      'grace@example.edu',
    ])
    // The stray quote is preserved as ordinary text, not dropped.
    expect(result.rows[1]?.row.last).toBe('O"Brien')
  })

  // The other half of finding 1: a field that genuinely *opens* with a
  // quote (RFC 4180's own trigger) but never closes anywhere in the rest of
  // the file — a forgotten closing quote around an embedded comma, say.
  // This is detected and reported against the row it started on, and the
  // rest of the file still imports.
  it('reports a field that opens with a quote and never closes, against its own row, without stopping the rest of the roster', () => {
    const csv = [
      HEADER,
      'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      'Alan,"Turing,alan@example.edu,,aturing', // opening quote, no closing quote anywhere after
      'Grace,Hopper,grace@example.edu,gracehopper,ghopper',
    ].join('\n')

    const result = parseRosterCsv(csv)

    expect(result.rows.map((r) => r.row.email)).toEqual([
      'ada@example.edu',
      'grace@example.edu',
    ])
    expect(result.errors).toEqual([
      {
        line: 3,
        message: expect.stringContaining('Unterminated') as unknown as string,
      },
    ])
  })

  // Rework finding 2: Excel's "CSV UTF-8" export — the default a
  // registrar's roster goes through — writes a leading byte-order mark, so
  // the first header silently becomes a `First` with an invisible
  // character glued to its front, and a file that plainly contains `First`
  // was reported as missing it.
  it('strips a leading UTF-8 byte-order mark, rather than reporting a plainly-present column as missing', () => {
    const csv =
      '\uFEFF' +
      [HEADER, 'Ada,Lovelace,ada@example.edu,adalovelace,adal'].join('\n')

    const result = parseRosterCsv(csv)

    expect(result.errors).toEqual([])
    expect(result.rows).toHaveLength(1)
  })

  // Rework finding 3: `line` used to be `i + 1` — the record's own index,
  // not its physical line — so a row containing a quoted embedded newline
  // (legal RFC 4180, exercised two tests above this file's own quoted-comma
  // one) threw off every line number reported after it. The malformed row
  // below sits on physical line 4 (header=1, Ada's own row spans 2-3), not
  // line 3, which a record-count-based `line` would have reported instead.
  it('reports a later row against its physical line, not its record index, after an earlier row with an embedded newline', () => {
    const csv = [
      HEADER,
      'Ada,"Lovelace\nAugusta",ada@example.edu,adalovelace,adal',
      'Alan,Turing,not-an-email,,aturing',
    ].join('\n')

    const result = parseRosterCsv(csv)

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.row.last).toBe('Lovelace\nAugusta')
    expect(result.errors).toEqual([
      { line: 4, message: expect.any(String) as unknown as string },
    ])
  })

  // Rework finding 7: `"@" in email` alone lets `@example.edu` through — a
  // local part of `''`. `roster-import.ts` derives a channel name from the
  // local part, and Discord rejects a channel named `''` with a 400 that
  // (pre-rework finding 4) killed the whole job — caught here instead, at
  // the schema, against its own row.
  it('rejects an email with an empty local part before "@"', () => {
    const csv = [HEADER, 'Ada,Lovelace,@example.edu,adalovelace,adal'].join(
      '\n'
    )

    const result = parseRosterCsv(csv)

    expect(result.rows).toEqual([])
    expect(result.errors).toEqual([
      {
        line: 2,
        message: expect.stringContaining('local part') as unknown as string,
      },
    ])
  })
})
