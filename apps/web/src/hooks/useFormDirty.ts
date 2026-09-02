/**
 * WEB-16: whether a form's current values differ from where it started —
 * "dirty" means "would be lost if this navigated away right now," not
 * "has been typed in." A value typed and then deleted back to its
 * original leaves the form clean again; counting keystrokes instead of
 * comparing values would prompt a person who changed nothing back, which
 * trains them to click through the prompt without reading it (this file's
 * own module comment's whole reason for existing).
 *
 * `baseline` is whatever the form last agreed with the server on — the
 * blank starting state for a new record, or the record itself once loaded
 * or just saved (`pages/CourseEditor.tsx`'s own `baseline` state tracks
 * this, updated in the same three places `form` itself is set from a real
 * record rather than an edit). `current` is the form's live state.
 *
 * Compared by `JSON.stringify`, not a field-by-field diff: every caller
 * today builds both `baseline` and `current` from the same object shape
 * via the same code path (so key order — the one thing `JSON.stringify`
 * equality is sensitive to that a deep-equality check would not be —
 * never differs between them), and a plain-object form's own state is
 * exactly the JSON-serializable shape this comparison assumes.
 */

import { useMemo } from 'react'

export function useFormDirty<T>(baseline: T, current: T): boolean {
  return useMemo(
    () => JSON.stringify(baseline) !== JSON.stringify(current),
    [baseline, current]
  )
}
