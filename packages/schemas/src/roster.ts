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
  //
  // Rework finding 7: `"@" in email` alone lets `@example.edu` through —
  // a local part of `''`. The Python script never had to care (it never
  // derived a channel name from the local part); this platform does
  // (`roster-import.ts`'s `channelNameForEmail`), and a channel named `''`
  // is a 400 Discord rejects at creation. Caught here, at the schema, so
  // it is reported against its own row rather than surfacing as an opaque
  // channel-creation failure three steps later.
  email: z
    .string()
    .trim()
    .min(1, 'Email is required')
    .refine((value) => value.includes('@'), 'Email must contain "@"')
    .refine(
      (value) => (value.split('@')[0] ?? '').length > 0,
      'Email must have a non-empty local part before "@"'
    ),
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

/** One physical record this scanner produced — its own fields, and the physical line (1-indexed) it *started* on (rework finding 3, below). */
interface CsvRecord {
  startLine: number
  fields: string[]
}

/**
 * Find the `"` that closes a quoted field opened at `text[openIndex]`
 * (`openIndex` itself), skipping over every escaped `""` pair along the way
 * — the index of the real closing quote, or `-1` when none exists anywhere
 * in the rest of `text`. Used by `parseCsvRows` to decide, *before*
 * committing to quoted-field mode, whether a field's opening quote is
 * genuine or a typo (rework finding 1, below): a lookahead rather than a
 * single-character peek, because the field can legitimately span more of
 * `text` than one line (an embedded newline inside a quoted field is valid
 * RFC 4180, not itself the bug).
 */
function findClosingQuote(text: string, openIndex: number): number {
  let i = openIndex + 1
  while (i < text.length) {
    if (text[i] === '"') {
      if (text[i + 1] === '"') {
        i += 2
        continue
      }
      return i
    }
    i++
  }
  return -1
}

/**
 * A minimal RFC 4180 CSV line splitter — quoted fields, embedded commas and
 * escaped `""` quotes within them, `\r\n` or `\n` line endings. Deliberately
 * hand-rolled rather than an added dependency: `packages/schemas`'
 * `package.json` is explicit that it "depends on zod alone so it can be
 * bundled into the browser" (PLAT-2), and a roster is, in practice, a small
 * text file — nothing here needs a streaming parser.
 *
 * Rework finding 1: a `"` is only ever the *start* of a quoted field when it
 * is a field's very first character (RFC 4180 §2.5) — the previous version
 * toggled quoted mode on *any* `"`, so a typo like `O"Brien` (a stray quote
 * mid-field, not one opening a field) put the scanner into quoted mode with
 * no real closing quote anywhere in the rest of the file, and the entire
 * remainder collapsed into one field: every row after it silently vanished.
 * Two changes fix this: a `"` with `field` already non-empty is now just a
 * literal character (the `O"Brien` case never reaches quoted mode at all),
 * and a `"` that *does* open a field is verified, via `findClosingQuote`,
 * to actually close somewhere in the rest of the text before this scanner
 * commits to reading it as one — if it never closes, that one record is
 * abandoned (reported by `parseRosterCsv`, not this function, which only
 * signals it through `unterminatedQuoteErrors`) and scanning resumes at the
 * next physical line, so the rest of the file still imports.
 */
function parseCsvRows(text: string): {
  records: CsvRecord[]
  /** A record whose opening quote never closed anywhere in the rest of the file — `line` is the physical line that record started on. `parseRosterCsv` turns each of these into a `RosterParseError`. */
  unterminatedQuoteErrors: { line: number }[]
} {
  // Normalize line endings up front so the character-by-character scan
  // below only ever has to treat `\n` as a row boundary.
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const length = normalized.length

  const records: CsvRecord[] = []
  const unterminatedQuoteErrors: { line: number }[] = []

  let i = 0
  let physicalLine = 1 // Rework finding 3 — the *physical* line, not the record count; see this function's own module comment.

  while (i < length) {
    const recordStartLine = physicalLine
    const row: string[] = []
    let field = ''
    let abandoned = false

    for (;;) {
      if (i >= length) {
        row.push(field)
        break
      }
      const char = normalized[i]

      if (char === '"' && field.length === 0) {
        // A quote at a field's own start (RFC 4180 §2.5) — but only a
        // genuine quoted field if it actually closes somewhere ahead;
        // otherwise this is the unterminated-quote case this rework fixes.
        const closeIndex = findClosingQuote(normalized, i)
        if (closeIndex === -1) {
          unterminatedQuoteErrors.push({ line: recordStartLine })
          // Recovery: abandon this record (its fields are unusable — there
          // is no principled way to say where they were meant to end) and
          // resync scanning at the next physical line, so every row after
          // it still imports, exactly this rework's own "one bad row never
          // costs an instructor the whole roster" for a bad *quote* too.
          let j = i
          while (j < length && normalized[j] !== '\n') j++
          i = j < length ? j + 1 : j
          physicalLine++
          abandoned = true
          break
        }
        for (let k = i + 1; k < closeIndex; k++) {
          if (normalized[k] === '"') {
            field += '"' // An escaped `""` pair inside the quoted field.
            k++
          } else {
            if (normalized[k] === '\n') physicalLine++ // A legitimate embedded newline.
            field += normalized[k]
          }
        }
        i = closeIndex + 1
        continue
      }
      if (char === ',') {
        row.push(field)
        field = ''
        i++
        continue
      }
      if (char === '\n') {
        row.push(field)
        i++
        physicalLine++
        break
      }
      field += char
      i++
    }

    if (!abandoned) records.push({ startLine: recordStartLine, fields: row })
  }

  return { records, unterminatedQuoteErrors }
}

/**
 * Parse a roster CSV's text into valid rows and per-line errors (ROST-9).
 * Never throws on a malformed row — that row's line number and reason land
 * in `errors` instead, and parsing continues with the rest of the file, so
 * one bad row never costs an instructor the whole roster.
 */
export function parseRosterCsv(text: string): RosterParseResult {
  // Rework finding 2: Excel's "CSV UTF-8" export — the default a
  // registrar's file goes through — writes a leading byte-order mark
  // (U+FEFF). Left in place, it silently becomes part of the first
  // header's own name (a `First` with an invisible character glued to its
  // front), so a file that plainly contains `First` is reported as missing
  // it. Stripped here, once, before any scanning — never a defaulted or
  // invented column, just the one character Excel adds that this format has
  // no use for. Written as an escape, not the literal character, so this
  // file itself stays free of the irregular whitespace ESLint's own
  // `no-irregular-whitespace` rule (correctly) flags.
  const BOM = '\uFEFF'
  const withoutBom = text.startsWith(BOM) ? text.slice(BOM.length) : text

  const { records, unterminatedQuoteErrors } = parseCsvRows(withoutBom)
  const result: RosterParseResult = { rows: [], errors: [] }

  // Rework finding 1 — the header row (always the file's first record,
  // always physical line 1) can itself be the one an unterminated quote
  // abandoned; nothing meaningful follows without a header to read columns
  // by, so this is reported the same way an actually-empty file already is.
  const headerBroke = unterminatedQuoteErrors.some((error) => error.line === 1)
  if (headerBroke) {
    result.errors.push({
      line: 1,
      message: 'The header row has an unterminated quoted field.',
    })
    return result
  }

  const headerRow = records[0]?.fields
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

  // Every data-row unterminated-quote error, reported against the line it
  // started on — interleaved with the schema errors below in whatever order
  // they naturally land; nothing here promises the *combined* list is
  // sorted by line, only that every malformed row (a bad quote, or a bad
  // value) is named once, with its own line.
  for (const error of unterminatedQuoteErrors) {
    if (error.line === 1) continue // The header case is handled above.
    result.errors.push({
      line: error.line,
      message: 'Unterminated quoted field.',
    })
  }

  for (let i = 1; i < records.length; i++) {
    const record = records[i]
    if (!record) continue
    const line = record.startLine
    const values = record.fields
    // A line that is entirely blank (a trailing newline, an extra blank
    // line an instructor's spreadsheet tool left in the middle of the
    // file) carries nothing to report — skipped, not reported as an error.
    if (values.length === 1 && values[0] === '') continue

    const rowRecord: Record<string, string> = {}
    headerRow.forEach((header, index) => {
      rowRecord[header] = values[index] ?? ''
    })

    const parsed = rosterRowSchema.safeParse({
      first: rowRecord['First'],
      last: rowRecord['Last'],
      email: rowRecord['Email'],
      discord: rowRecord['Discord'],
      github: rowRecord['GitHub'],
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
