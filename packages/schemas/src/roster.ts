/**
 * Schema for the roster CSV a roster-import job parses (ROST-9).
 *
 * `roster_create_channels.py` reads a merged results CSV
 * (`results/PREFIX-result.csv`, written by `roster_setup.ipynb` — ROST-2)
 * with five normalized columns: `Last`, `First`, `Email`, `GitHub` and
 * `Discord`. That merge step — joining the registrar's own roster with an
 * intake questionnaire on email address — is `packages/legacy-import`'s
 * concern, not this slice's (see this repo's own brief: "the legacy
 * import" is explicitly out of scope), so the CSV this schema parses is
 * that same five-column shape an instructor uploads directly: a roster
 * already merged with a Discord handle per row, exactly what
 * `roster_create_channels.py` itself reads today.
 *
 * D-10's "mirror the reader's optionality, invent no defaults" (the same
 * discipline `legacy-yaml.ts`'s own module comment applies to
 * `bot_config.yml`) decides which columns are required here. The Python
 * reader treats every column with `row.get(key, "")`, so nothing overtly
 * *fails* on a missing column — but two columns are the ones a blank value
 * makes the row useless for this platform's own purposes, not merely
 * cosmetically incomplete: `Discord` (ROST-10 — the row's whole *identity*
 * is its Discord handle) and `Email`, and only inasmuch as `"@" in email`
 * is the one check the Python script itself performs
 * (`roster_create_channels.py`'s `if "@" in email:`) before doing anything
 * with a row at all — so this schema requires the same, not full RFC 5322
 * validation the Python tool never asked of it either. `First`/`Last`/
 * `GitHub` stay optional, defaulting to `''` the same way `row.get(key,
 * "")` already does, since the Python tool's own `format_welcome_message`
 * tolerates a blank name or handle without failing.
 */

import { z } from 'zod'

/** One parsed, valid roster row — camelCased, trimmed. */
export const rosterRowSchema = z.object({
  first: z.string().trim().default(''),
  last: z.string().trim().default(''),
  // Mirrors the Python reader's own check (`"@" in email`), not a full
  // email-format validation it never performed either — see this file's
  // own module comment.
  email: z
    .string()
    .trim()
    .min(1, 'Email is required')
    .refine((value) => value.includes('@'), 'Email must contain "@"'),
  discord: z.string().trim().min(1, 'Discord handle is required'),
  github: z.string().trim().default(''),
})

export type RosterRow = z.output<typeof rosterRowSchema>

/** The exact header row `roster_create_channels.py` reads (`row.get('First'|'Last'|'Email'|'Discord'|'GitHub')`) — case-sensitive, the same as the Python `csv.DictReader` this mirrors. */
const REQUIRED_HEADERS = [
  'First',
  'Last',
  'Email',
  'Discord',
  'GitHub',
] as const

/** One row this schema could not parse — ROST-9: "reported with its line rather than skipped in silence." `line` is the CSV's own 1-indexed line number (the header is line 1, so the first data row is line 2), matching what an instructor sees opening the file in a spreadsheet or text editor. */
export interface RosterParseError {
  line: number
  message: string
}

export interface RosterParseResult {
  /** Every row that parsed, each tagged with the CSV line it came from — `roster.ts` (the worker handler) needs this to report which row a later failure (an unresolved handle, a channel that could not be created) came from. */
  rows: { line: number; row: RosterRow }[]
  errors: RosterParseError[]
}

/**
 * A minimal RFC 4180 CSV line splitter — quoted fields, embedded commas and
 * escaped `""` quotes within them, `\r\n` or `\n` line endings. Deliberately
 * hand-rolled rather than an added dependency: `packages/schemas`'
 * `package.json` is explicit that it "depends on zod alone so it can be
 * bundled into the browser" (PLAT-2), and a roster is, in practice, a small
 * text file — nothing here needs a streaming parser.
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  // Normalize line endings up front so the character-by-character scan
  // below only ever has to treat `\n` as a row boundary.
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  function endField(): void {
    row.push(field)
    field = ''
  }
  function endRow(): void {
    endField()
    rows.push(row)
    row = []
  }

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]
    if (inQuotes) {
      if (char === '"') {
        if (normalized[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      endField()
    } else if (char === '\n') {
      endRow()
    } else {
      field += char
    }
  }
  // A trailing row with no final newline still needs to be flushed; a file
  // ending in a newline leaves `field`/`row` both empty, which would
  // otherwise append a spurious blank row.
  if (field.length > 0 || row.length > 0) endRow()

  return rows
}

/**
 * Parse a roster CSV's text into valid rows and per-line errors (ROST-9).
 * Never throws on a malformed row — that row's line number and reason land
 * in `errors` instead, and parsing continues with the rest of the file, so
 * one bad row never costs an instructor the whole roster.
 */
export function parseRosterCsv(text: string): RosterParseResult {
  const csvRows = parseCsvRows(text)
  const result: RosterParseResult = { rows: [], errors: [] }

  const headerRow = csvRows[0]
  if (!headerRow) {
    result.errors.push({ line: 1, message: 'The roster file is empty.' })
    return result
  }
  const missingHeaders = REQUIRED_HEADERS.filter(
    (header) => !headerRow.includes(header)
  )
  if (missingHeaders.length > 0) {
    result.errors.push({
      line: 1,
      message: `Missing required column(s): ${missingHeaders.join(', ')}.`,
    })
    return result
  }

  for (let i = 1; i < csvRows.length; i++) {
    const line = i + 1 // 1-indexed, header is line 1.
    const values = csvRows[i]
    if (!values) continue
    // A line that is entirely blank (a trailing newline, an extra blank
    // line an instructor's spreadsheet tool left in the middle of the
    // file) carries nothing to report — skipped, not reported as an error.
    if (values.length === 1 && values[0] === '') continue

    const record: Record<string, string> = {}
    headerRow.forEach((header, index) => {
      record[header] = values[index] ?? ''
    })

    const parsed = rosterRowSchema.safeParse({
      first: record['First'],
      last: record['Last'],
      email: record['Email'],
      discord: record['Discord'],
      github: record['GitHub'],
    })
    if (parsed.success) {
      result.rows.push({ line, row: parsed.data })
    } else {
      const message = parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')
      result.errors.push({ line, message })
    }
  }

  return result
}
