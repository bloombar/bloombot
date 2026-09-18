/**
 * ADMIN-12 — the console's own search box, built once and shared by every
 * list screen (`OrganizationsList`, `CoursesView`, `AccountsList`,
 * `DeletionsView`) rather than four near-identical copies of the same
 * input/label/count/clear markup. Matching happens over rows already
 * fetched — no new request (this slice's own brief: "no new request") —
 * so `useListSearch` below is plain, client-side, case-insensitive
 * substring filtering; `SearchField` is only the input itself, the
 * "Showing N of M" count, and the clear control every one of the four
 * screens needs to carry.
 *
 * Each caller decides which of its own fields a row is matched against by
 * the one string `getSearchText` returns for that row — `CoursesView`
 * joins title, project, organization and owner emails into one string, the
 * other three screens each join a single field — so this file stays a
 * single substring test rather than growing a field-by-field matcher only
 * one caller needs.
 */

import { useMemo, useState } from 'react'

import { Button } from '../../components/Button.js'
import { textInputClasses } from '../../components/fieldStyles.js'

export interface ListSearch<T> {
  query: string
  setQuery: (value: string) => void
  /** `undefined` while `items` itself is (the read has not resolved yet) — a caller must not render this screen's search field before it has rows to search. */
  filtered: T[] | undefined
  totalCount: number
  matchCount: number
}

/** Case-insensitive substring search over an already-fetched list — `items` stays whatever `undefined`/array shape the caller's own read gives it, so loading and "no rows at all" stay exactly the states they already were before this hook existed. */
export function useListSearch<T>(
  items: T[] | undefined,
  getSearchText: (item: T) => string
): ListSearch<T> {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    if (items === undefined) return undefined
    const normalized = query.trim().toLowerCase()
    if (normalized === '') return items
    return items.filter((item) =>
      getSearchText(item).toLowerCase().includes(normalized)
    )
    // `getSearchText` is named here too — every call site passes a fresh
    // closure each render, so this still recomputes whenever that render
    // happens, the same cost the screen's own render already pays.
  }, [items, query, getSearchText])

  return {
    query,
    setQuery,
    filtered,
    totalCount: items?.length ?? 0,
    matchCount: filtered?.length ?? 0,
  }
}

/**
 * The field itself — a real `<label>` (never a placeholder alone), the
 * match count as a live region so a screen reader hears it update as the
 * administrator types, and a Clear button that only appears once there is
 * something to clear. `id` must be unique per screen (four of these can be
 * on screen across navigations within one test run) — every call site
 * passes its own.
 */
export function SearchField({
  id,
  label,
  placeholder,
  query,
  onChange,
  matchCount,
  totalCount,
  itemLabel,
}: {
  id: string
  label: string
  placeholder: string
  query: string
  onChange: (value: string) => void
  matchCount: number
  totalCount: number
  /** The plural noun this field searches, e.g. "organizations" — feeds "Showing N of M organizations." */
  itemLabel: string
}) {
  return (
    <div className="flex flex-col gap-1" data-testid={`${id}-search`}>
      <label htmlFor={id} className="text-xs font-medium text-neutral-500">
        {label}
      </label>
      {/* WEB-48: full width at every breakpoint, including ~400px — a
          phone-width column with the Clear button wrapping onto its own
          line rather than forcing horizontal scroll. */}
      <div className="flex flex-wrap gap-2">
        <input
          id={id}
          type="search"
          value={query}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={`${textInputClasses} min-w-0 flex-1`}
        />
        {query !== '' && (
          <Button variant="secondary" onClick={() => onChange('')}>
            Clear
          </Button>
        )}
      </div>
      {/* The count alone — each list screen supplies its own "no matches"
          message in the list area itself (this component's own module
          comment), so this line never duplicates it; it only ever reports
          how many rows matched, even when that is zero. */}
      <p className="text-xs text-neutral-500" role="status">
        Showing {matchCount} of {totalCount} {itemLabel}
      </p>
    </div>
  )
}
