/**
 * A large drag-and-drop target for choosing a file, with clicking and the
 * keyboard as equal routes to the same picker.
 *
 * Drag-and-drop is an addition, never the only way in: it is unusable on a
 * touch screen, awkward with a screen reader, and impossible for somebody
 * driving the keyboard. So the zone is a real `<button>` that opens a hidden
 * `<input type="file">` — Tab reaches it, Enter and Space activate it, and
 * the focus ring shows where you are (WEB-17). A `<div>` with an `onClick`
 * would look identical and be none of those things.
 *
 * Two behaviours are easy to leave out and expensive to leave out.
 *
 *   - **The page must not become a drop target.** A file dropped anywhere
 *     outside this zone is, by default, *navigated to* — the browser leaves
 *     the page and opens the file. On a half-filled course form that
 *     discards the edit, so this suppresses the default at the window while
 *     mounted, and a drop still does nothing unless it lands here.
 *   - **The drag state has to clear.** `dragenter`/`dragleave` fire for every
 *     child element a pointer crosses, so a naive boolean flickers and can
 *     stick "armed" after the pointer has left. This counts entries against
 *     leaves, and resets unconditionally on drop.
 *
 * A file the caller will not accept is refused here, with a reason, rather
 * than sent and refused by the server — `FormField`'s per-field error is what
 * WEB-16 asks for, and a silent no-op is the worst of the three.
 *
 * FILE-7: `multiple` is opt-in and additive. Every existing caller
 * (`RosterImport.tsx`, `CourseImportDialog.tsx`) passes neither `multiple`
 * nor `onFilesChosen`, and keeps taking exactly one file through
 * `onFileChosen` exactly as before — `<input multiple>` stays off, and a
 * drop or a pick still yields a single `File`. Only `CourseAttachments.tsx`
 * sets `multiple`, which turns the picker's own `multiple` attribute on and
 * routes every dropped or chosen file through the same per-file `maxBytes`/
 * `validate` checks `consider` already runs for one, collected into a
 * single `onFilesChosen(files)` call rather than one `onFileChosen` call
 * per file — the caller decides how to queue several files, not this
 * component.
 */

import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, KeyboardEvent, ReactElement } from 'react'

import { FormField } from './FormField.js'

export interface FileDropZoneProps {
  /** Field label, and the basis of the zone's own accessible name. */
  label: string
  /** Help text under the label — say what is accepted, in words. */
  help?: string
  /** `accept` for the picker. Advisory only: a drop bypasses it, so `validate` is the real gate. */
  accept?: string
  /** Largest file this caller will take, in bytes. */
  maxBytes?: number
  /** The file currently chosen, if any — the caller owns that state. Single-file mode only (`multiple` is off); a multi-file caller queues its own selections and never passes this. */
  selectedFile?: File | undefined
  /** Called with a file that passed `maxBytes` and `validate`. Required in single-file mode; unused (and safely omittable) once `multiple` is on. */
  onFileChosen?: (file: File) => void
  /** Turns on `<input multiple>` and routes every dropped/chosen file to `onFilesChosen` instead of `onFileChosen` — off by default, so every existing single-file caller is unaffected. */
  multiple?: boolean
  /** Called with every dropped/chosen file that passed `maxBytes` and `validate`, when `multiple` is on. */
  onFilesChosen?: (files: File[]) => void
  /** Extra caller rules: return a sentence to refuse, or undefined to accept. Applied per file in `multiple` mode. */
  validate?: (file: File) => string | undefined
  /** Closes every route in, while an upload is in flight. */
  disabled?: boolean
}

/**
 * Bytes rendered the way somebody reading a limit expects to see them —
 * exported (FILE-7) so `CourseAttachments.tsx`'s own queued-file list can
 * use the same whole-unit rounding for a single file's size, rather than
 * the coarser whole-MB rounding its own budget sentence uses (`describeMb`
 * there): a queued file well under a megabyte would otherwise round to
 * "0 MB" and read as if it had no size at all.
 */
export function describeSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} bytes`
}

export function FileDropZone({
  label,
  help,
  accept,
  maxBytes,
  selectedFile,
  onFileChosen,
  multiple = false,
  onFilesChosen,
  validate,
  disabled = false,
}: FileDropZoneProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [rejection, setRejection] = useState<string | undefined>(undefined)

  useEffect(() => {
    const swallow = (event: Event): void => event.preventDefault()
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  /** One file's own `maxBytes`/`validate` check — a sentence to refuse it, or `undefined` to accept. Shared by both the single- and multi-file paths so the rule is checked identically either way. */
  const checkFile = (file: File): string | undefined => {
    if (maxBytes !== undefined && file.size > maxBytes) {
      return `That file is ${describeSize(file.size)}. The limit is ${describeSize(maxBytes)}.`
    }
    return validate?.(file)
  }

  const consider = (file: File | undefined): void => {
    if (!file) return
    const refusal = checkFile(file)
    if (refusal) {
      setRejection(refusal)
      return
    }
    setRejection(undefined)
    onFileChosen?.(file)
  }

  /** FILE-7's multi-file path: every file dropped/chosen is checked, the ones that pass are handed to the caller in one `onFilesChosen` call, and the first rejection (if any) is what the zone shows — a caller queuing several files still hears about a file it cannot take, without one dialog per rejection. */
  const considerMany = (files: File[]): void => {
    if (files.length === 0) return
    const accepted: File[] = []
    let firstRejection: string | undefined
    for (const file of files) {
      const refusal = checkFile(file)
      if (refusal) {
        firstRejection ??= refusal
        continue
      }
      accepted.push(file)
    }
    setRejection(firstRejection)
    if (accepted.length > 0) onFilesChosen?.(accepted)
  }

  const handleDrop = (event: DragEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (disabled) return
    const files = event.dataTransfer?.files
    if (!files) return
    if (multiple) considerMany(Array.from(files))
    else consider(files[0])
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    // A `<button>` already activates on Enter and Space; this only stops
    // Space scrolling the page underneath first.
    if (event.key === ' ') event.preventDefault()
  }

  return (
    <div className="flex flex-col gap-1">
      {/*
        `FormField` clones its single child to carry the generated id, so the
        button is that child and the label points at the control a person
        actually operates. The picker is a sibling, reached only by ref.
      */}
      {/* `exactOptionalPropertyTypes` is on, so an absent optional is spread
          in rather than passed as an explicit `undefined`. */}
      <FormField
        label={label}
        {...(help === undefined ? {} : { help })}
        {...(rejection === undefined ? {} : { error: rejection })}
      >
        <button
          type="button"
          disabled={disabled}
          aria-label={
            multiple
              ? `${label} — drop files here, or activate to browse`
              : `${label} — drop a file here, or activate to browse`
          }
          data-dragging={dragging ? 'true' : undefined}
          onClick={() => inputRef.current?.click()}
          onKeyDown={handleKeyDown}
          onDragEnter={(event) => {
            event.preventDefault()
            dragDepth.current += 1
            if (!disabled) setDragging(true)
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1)
            if (dragDepth.current === 0) setDragging(false)
          }}
          onDrop={handleDrop}
          className={[
            'flex w-full flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors',
            disabled
              ? 'cursor-not-allowed border-neutral-200 text-neutral-400'
              : dragging
                ? 'border-brand-500 bg-brand-50 text-brand-700'
                : 'border-neutral-300 text-neutral-600 hover:border-brand-400 hover:bg-neutral-50',
          ].join(' ')}
        >
          <span className="text-base font-medium">
            {multiple
              ? 'Drop files here'
              : selectedFile
                ? selectedFile.name
                : 'Drop a file here'}
          </span>
          <span className="text-sm">
            {multiple
              ? 'or click to browse'
              : selectedFile
                ? 'Drop another to replace it'
                : 'or click to browse'}
          </span>
        </button>
      </FormField>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const files = event.target.files
          if (!files) return
          if (multiple) {
            considerMany(Array.from(files))
            // A native file input keeps its previous selection until a new
            // pick replaces it — no browser `change` event fires for
            // choosing the exact same set of files twice in a row, which
            // would silently block an instructor picking the same file
            // again on a second pass (this file's own module comment: an
            // instructor picking readings in two passes is the normal
            // case). Only cleared in `multiple` mode — the single-file path
            // below is unchanged, `selectedFile` is what drives what this
            // button shows there.
            event.target.value = ''
          } else {
            consider(files[0])
          }
        }}
      />
    </div>
  )
}
