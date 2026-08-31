/**
 * derive.mjs — build/refresh the board manifest from the spec docs.
 *
 * Reads docs/SPEC.md (requirement ids + titles + sections) and docs/ROADMAP.md
 * (phase scope + done/outstanding status), and writes scripts/board/manifest.yaml
 * — the human-curated source of truth that sync.mjs pushes to GitHub.
 *
 * Merge semantics: on re-run, titles/sections/families are refreshed from the
 * SPEC, but any human-set phase/status/review on an existing entry is PRESERVED.
 * New ids are added with a best-effort phase/status (flagged review when unsure);
 * ids that vanished from the SPEC are kept and reported as stale.
 *
 * Phase seeding rules (wikistreets):
 *   - ids claimed by a ROADMAP phase/track scope line get that phase.
 *   - ids claimed by no phase are the SHIPPED BASELINE → phase 0, status Done.
 *     (New program work must be added to a ROADMAP scope line in the same PR
 *     that adds it to the SPEC — the manifest diff makes a miss visible.)
 *   - the ROADMAP "Current status" snapshot can override status per id.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'
import { PHASES } from './config.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const SPEC = join(root, 'docs', 'SPEC.md')
const ROADMAP = join(root, 'docs', 'ROADMAP.md')
const MANIFEST = join(here, 'manifest.yaml')

const familyOf = id => id.replace(/-\d+.*$/, '')

// Requirements deliberately NOT tracked as their own board issues because they
// are fully realized by another tracked requirement (avoids duplication).
const EXCLUDE = new Set([])

/** Trim to a word boundary with an ellipsis, for tidy issue titles. */
const shorten = (s, max) => {
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  return (
    s
      .slice(0, max)
      .replace(/\s+\S*$/, '')
      .replace(/[\s—:,;(-]+$/, '') + '…'
  )
}

/**
 * Expand a run of prose into concrete ids. Handles the two ROADMAP shorthands:
 * ranges (`REF-1..6`) and slash-lists (`REF-1/2/3`, `XTR-1/2`). A bare number
 * continues the previous family ONLY when joined by `/` or `..`, so stray
 * numbers like "200 items" or "100% coverage" are ignored.
 */
export const expandIds = text => {
  // Drop markdown link targets and code backticks so both linked scope
  // paragraphs and plain code-span status lines reduce to the same shape.
  const flat = text.replace(/\]\([^)]*\)/g, '').replace(/[`[\]]/g, '')
  const out = []
  const re = /([A-Z]+-\d+|\d+)/g
  let m
  let curFam = null
  let prevNum = null
  let prevEnd = 0
  while ((m = re.exec(flat))) {
    const sep = flat.slice(prevEnd, m.index)
    prevEnd = re.lastIndex
    const tok = m[1]
    const isRange = /\.\./.test(sep)
    const joined = /\/|\.\./.test(sep) // '/' or '..' only — NOT a lone sentence period
    let fam
    let num
    if (tok.includes('-')) {
      fam = tok.replace(/-\d+$/, '')
      num = Number(tok.slice(tok.lastIndexOf('-') + 1))
    } else {
      if (!curFam || !joined) {
        continue // unrelated bare number
      }
      fam = curFam
      num = Number(tok)
    }
    if (isRange && prevNum != null && fam === curFam) {
      for (let n = prevNum + 1; n <= num; n++) out.push(`${fam}-${n}`)
    } else {
      out.push(`${fam}-${num}`)
    }
    curFam = fam
    prevNum = num
  }
  return out
}

/** Grab the section body between a heading match and the next same-level heading. */
const sliceSection = (text, headingRe, stopRe = /^#{2,4}\s/m) => {
  const start = text.search(headingRe)
  if (start < 0) return ''
  const rest = text.slice(start)
  const after = rest.slice(rest.indexOf('\n') + 1)
  const stop = after.search(stopRe)
  return stop < 0 ? after : after.slice(0, stop)
}

/** Flatten a chunk of markdown to plain prose for an issue body. */
const cleanMd = s =>
  s
    .replace(/```[\s\S]*?```/g, ' ') // drop fenced code blocks
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> their label text
    .replace(/^\s*[-+*]\s+/gm, ' ') // list bullet markers
    .replace(/[*`>#|]/g, '') // emphasis / heading / quote / table pipes
    .replace(/\s+/g, ' ')
    .trim()

// ---- Parse SPEC: id -> { title, full?, section, family } in document order ----
// The format contract (documented in .claude/CLAUDE.md and PROJECT_BOARD.md):
// a requirement is a `#### <ID> <title>` subheading plus the prose beneath it
// up to the next heading; its section is the enclosing `### <N>. <title>`.
export const parseSpec = text => {
  const items = []
  let section = ''
  let cur = null // heading item currently collecting its body prose

  const flush = () => {
    if (!cur) return
    const full = shorten(cleanMd(cur.body.join('\n')), 700)
    if (full && full !== cur.item.title) cur.item.full = full
    items.push(cur.item)
    cur = null
  }

  for (const line of text.split('\n')) {
    const sec = line.match(/^###\s+(\d+)\.\s+(.+?)\s*$/)
    if (sec) {
      flush()
      section = `§${sec[1]} ${sec[2]}`
      continue
    }
    const head = line.match(/^####\s+([A-Z]+-\d+[a-z]?)\s+(.+?)\s*$/)
    if (head) {
      flush()
      cur = {
        item: {
          id: head[1],
          title: head[2].trim(),
          section,
          family: familyOf(head[1]),
        },
        body: [],
      }
      continue
    }
    if (/^#{1,6}\s/.test(line)) {
      flush() // any other heading ends the current item's body
      continue
    }
    if (cur) cur.body.push(line)
  }
  flush()
  return items
}

// ---- Parse ROADMAP: best-effort phase + status seeds ----
// Phase scope comes from `**In scope:** …ids…` lines inside sections whose
// heading names a phase — `Phase <n>`, `Track S<n>` (S1→10, S2→11, S3→12), or
// `Future work` (→13). Status comes from the `### Current status` snapshot's
// Done:/Outstanding: bullets.
const phaseOfHeading = heading => {
  let m = heading.match(/Phase\s+(\d+)/i)
  if (m) return Number(m[1])
  m = heading.match(/Track\s+S(\d)/i)
  if (m) return 9 + Number(m[1]) // S1→10, S2→11, S3→12
  if (/Future\s+work/i.test(heading)) return 13
  return null
}

export const parseRoadmap = text => {
  const phaseOf = new Map()
  const status = new Map()
  const flags = new Map()

  const flag = (id, why) => flags.set(id, why)
  const setPhase = (id, p) => {
    if (phaseOf.has(id) && phaseOf.get(id) !== p) {
      flag(id, `spans phases ${phaseOf.get(id)} and ${p}`)
      return // keep the earliest phase
    }
    if (!phaseOf.has(id)) phaseOf.set(id, p)
  }

  // Walk `##` sections; a phase-titled section's "**In scope:**" line claims ids.
  const lines = text.split('\n')
  let curPhase = null
  for (const line of lines) {
    const h = line.match(/^##\s+(.+)$/)
    if (h) {
      curPhase = phaseOfHeading(h[1])
      continue
    }
    if (curPhase != null && /\*\*In scope/.test(line)) {
      for (const id of expandIds(line)) setPhase(id, curPhase)
    }
  }

  // Status from the "Current status" snapshot: Done vs Outstanding lists.
  const snap = sliceSection(text, /^###\s+Current status/m, /^##\s/m)
  for (const line of snap.split('\n')) {
    if (!/^-\s/.test(line)) continue
    const ids = expandIds(line)
    const s = /Done:/.test(line)
      ? 'Done'
      : /Outstanding:/.test(line)
        ? 'Backlog'
        : null
    if (!s) continue
    for (const id of ids) if (!status.has(id)) status.set(id, s)
  }

  return { phaseOf, status, flags }
}

// ---- Assemble & merge with any existing manifest (pure — testable) ----
/**
 * Build the manifest entries from spec/roadmap text plus the previous manifest
 * entries (curation source). Returns { entries, stale }. Exported so the
 * freshness test (server/__tests__/scripts/board-manifest.test.js) can verify
 * the committed manifest matches the docs without touching the filesystem.
 */
export const buildEntries = (specText, roadText, prev = []) => {
  const specItems = parseSpec(specText).filter(i => !EXCLUDE.has(i.id))
  const byId = new Map(specItems.map(i => [i.id, { ...i }]))
  const road = parseRoadmap(roadText)

  // Seed phase/status: roadmap-claimed ids get their phase (Backlog unless the
  // snapshot says Done); unclaimed ids are the shipped baseline (phase 0, Done).
  for (const e of byId.values()) {
    const claimed = road.phaseOf.get(e.id)
    if (claimed != null) {
      e._seedPhase = claimed
      e._seedStatus = road.status.get(e.id) ?? 'Backlog'
    } else {
      e._seedPhase = 0
      e._seedStatus = road.status.get(e.id) ?? 'Done'
      e._why = 'baseline (not claimed by a roadmap phase)'
    }
    if (road.flags.has(e.id)) {
      e._seedReview = true
      e._why = road.flags.get(e.id)
    }
  }

  // Preserve human curation from the existing manifest entries.
  const prevById = new Map((prev || []).map(e => [e.id, e]))

  const entries = []
  for (const e of byId.values()) {
    const old = prevById.get(e.id)
    entries.push({
      id: e.id,
      title: e.title,
      // `full` is the complete spec text (refreshed from the SPEC each run),
      // shown in the issue body when the short title is a clipped version.
      ...(e.full ? { full: e.full } : {}),
      section: e.section,
      family: e.family,
      phase: old ? old.phase : e._seedPhase,
      status: old ? old.status : e._seedStatus,
      review: old ? Boolean(old.review) : Boolean(e._seedReview),
      ...(e._why && !old
        ? { note: e._why }
        : old && old.note
          ? { note: old.note }
          : {}),
    })
  }
  // Keep (but warn about) manifest entries no longer in the SPEC.
  const stale = []
  for (const old of prev || []) {
    if (!byId.has(old.id)) {
      stale.push(old.id)
      entries.push(old)
    }
  }

  // Stable ordering: by phase, then family, then numeric id.
  const numOf = id => Number((id.match(/-(\d+)/) || [])[1] || 0)
  entries.sort(
    (a, b) =>
      (a.phase ?? 99) - (b.phase ?? 99) ||
      a.family.localeCompare(b.family) ||
      numOf(a.id) - numOf(b.id) ||
      a.id.localeCompare(b.id),
  )
  return { entries, stale }
}

// ---- CLI runner ----
const run = () => {
  const specText = readFileSync(SPEC, 'utf8')
  const roadText = readFileSync(ROADMAP, 'utf8')
  const prev = existsSync(MANIFEST) ? parse(readFileSync(MANIFEST, 'utf8')) : []
  const prevById = new Map((prev || []).map(e => [e.id, e]))
  const { entries, stale } = buildEntries(specText, roadText, prev)

  const header =
    '# Board manifest — SOURCE OF TRUTH for the GitHub project board.\n' +
    '# Generated by scripts/board/derive.mjs, then hand-curated. Re-running derive\n' +
    '# preserves your phase/status/review edits. Resolve every `review: true` row,\n' +
    '# then run scripts/board/sync.mjs. Do not edit ids (they key the issues).\n\n'
  writeFileSync(MANIFEST, header + stringify(entries))

  // Report.
  const byPhase = Object.fromEntries(PHASES.map(p => [p, 0]))
  let noPhase = 0
  let review = 0
  for (const e of entries) {
    if (e.phase == null) noPhase++
    else byPhase[e.phase] = (byPhase[e.phase] || 0) + 1
    if (e.review) review++
  }
  console.log(`Wrote ${entries.length} entries to ${MANIFEST}`)
  console.log(
    `  by phase: ${PHASES.map(p => `P${p}=${byPhase[p]}`).join('  ')}  none=${noPhase}`,
  )
  console.log(`  needing review: ${review}`)
  const news = entries.filter(e => !prevById.has(e.id)).map(e => e.id)
  if (prev && prev.length)
    console.log(
      `  new since last run: ${news.length ? news.join(', ') : 'none'}`,
    )
  if (stale.length)
    console.log(`  STALE (in manifest, not in SPEC): ${stale.join(', ')}`)
}

// Run only when invoked as a CLI (node scripts/board/derive.mjs), not when
// imported by the freshness test.
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  run()
}
