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
  /** The file currently chosen, if any — the caller owns that state. */
  selectedFile?: File | undefined
  /** Called with a file that passed `maxBytes` and `validate`. */
  onFileChosen: (file: File) => void
  /** Extra caller rules: return a sentence to refuse, or undefined to accept. */
  validate?: (file: File) => string | undefined
  /** Closes every route in, while an upload is in flight. */
  disabled?: boolean
}

/** Bytes rendered the way somebody reading a limit expects to see them. */
function describeSize(bytes: number): string {
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

  const consider = (file: File | undefined): void => {
    if (!file) return
    if (maxBytes !== undefined && file.size > maxBytes) {
      setRejection(
        `That file is ${describeSize(file.size)}. The limit is ${describeSize(maxBytes)}.`
      )
      return
    }
    const refusal = validate?.(file)
    if (refusal) {
      setRejection(refusal)
      return
    }
    setRejection(undefined)
    onFileChosen(file)
  }

  const handleDrop = (event: DragEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (disabled) return
    consider(event.dataTransfer?.files?.[0])
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
          aria-label={`${label} — drop a file here, or activate to browse`}
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
            {selectedFile ? selectedFile.name : 'Drop a file here'}
          </span>
          <span className="text-sm">
            {selectedFile ? 'Drop another to replace it' : 'or click to browse'}
          </span>
        </button>
      </FormField>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={disabled}
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          consider(event.target.files?.[0])
        }
      />
    </div>
  )
}
