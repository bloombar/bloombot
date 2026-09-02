/**
 * WEB-16: a field's label, help text and error live next to the field they
 * belong to, not only in a form-level summary — "invalid input" for a
 * fourteen-field course tells an instructor nothing, and a per-field
 * message is what fixes that.
 *
 * `FormField` wraps one control (an `<input>`, `<select>` or `<textarea>`
 * passed as `children`) and wires up the accessible plumbing a screen
 * reader needs to connect the three: `htmlFor`/`id`, `aria-describedby`
 * pointing at the help text and/or the error, and `aria-invalid` when an
 * error is present. A page using this component gets that wiring for free
 * rather than reimplementing it per field — the same "one component, not a
 * rule to remember" reasoning `Button.tsx`'s own module comment gives for
 * WEB-15.
 *
 * This does not render the control itself: `CourseEditor.tsx` and the rest
 * still own their own `<input>`/`<select>`/`<textarea>`, since their props
 * (`value`, `onChange`, `type`) vary too much for one wrapper to own
 * usefully — this component only owns the label/help/error frame around
 * whatever the caller renders inside it.
 */

import { cloneElement, isValidElement, useId, type ReactNode } from 'react'

import { ErrorIcon } from '../icons.js'

export interface FormFieldProps {
  label: string
  /** Optional guidance shown under the label, above the control — e.g. "Enter a whole number, or leave blank to use the platform default." */
  help?: string
  /** A field-specific validation or refusal message (WEB-16) — rendered in the danger color, next to the field, not only in a form-level summary. */
  error?: string
  /** The one form control this field wraps — must accept `id`/`aria-describedby`/`aria-invalid`, true of every native form element. */
  children: ReactNode
}

export function FormField({ label, help, error, children }: FormFieldProps) {
  const id = useId()
  const helpId = help ? `${id}-help` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined

  const control = isValidElement(children)
    ? cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        id,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        'aria-invalid': error ? true : undefined,
      })
    : children

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-neutral-800">
        {label}
      </label>
      {help && (
        <p id={helpId} className="text-sm text-neutral-500">
          {help}
        </p>
      )}
      {control}
      {error && (
        <p
          id={errorId}
          className="flex items-center gap-1 text-sm text-danger-700"
        >
          <ErrorIcon aria-hidden="true" className="size-4 shrink-0" />
          {error}
        </p>
      )}
    </div>
  )
}
