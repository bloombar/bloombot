/**
 * WEB-15/WEB-17: the one modal dialog this panel renders — alert, confirm,
 * prompt and choice are four *modes* of this single component, not four
 * separate implementations. ("Choice" is a confirm with a third button —
 * "save, discard, or stay here" — added for the course editor's own
 * per-tab unsaved-changes prompt.) `ModalProvider.tsx` is the only thing that
 * renders this component; nothing else in this app renders a `<dialog>`
 * itself (`AppShell.tsx`'s own mobile drawer is a different kind of
 * surface — a persistent navigation panel, not an alert/confirm/prompt —
 * and keeps its own, simpler `<dialog>` for that reason).
 *
 * Built on the native `<dialog>` element (the same choice, and the same
 * reasoning, this app's own former `ConfirmDialog.tsx` already made —
 * folded into this file rather than kept alongside it, since a second
 * dialog implementation is exactly the duplication this component exists
 * to remove): `showModal()` already traps focus, makes the rest of the
 * page inert to interaction and assistive technology, and restores focus
 * to the triggering element once it closes. What this component adds on
 * top:
 *
 *  - **Which control gets initial focus is chosen deliberately, not left
 *    to the browser's own "first focusable element" default.** A
 *    destructive confirm's default focus lands on Cancel, never on the
 *    destructive button itself — accidentally pressing `Enter` the instant
 *    the dialog opens must never run the destructive action.
 *  - **`Escape` closes a cancellable dialog** (confirm, prompt, choice) —
 *    for a choice it means "stay here", the same answer Cancel gives. The
 *    native dialog's own `cancel` event already fires for it; this
 *    component's own `onCancel` is what that event resolves to.
 *  - **A prompt's value comes back through the same `onConfirm`,** and its
 *    own `Enter` inside the text field submits, the same convention a
 *    single-line form field already carries.
 */

import { useEffect, useId, useRef, type ReactNode } from 'react'

import { Button } from '../Button.js'
import { textInputClasses } from '../fieldStyles.js'

export type ModalKind = 'alert' | 'confirm' | 'prompt' | 'choice'

export interface ModalProps {
  open: boolean
  kind: ModalKind
  title: string
  description?: ReactNode
  confirmLabel: string
  /** Absent for `kind: 'alert'` — an alert has only one way out. */
  cancelLabel?: string
  /** `kind: 'confirm'` only — renders the confirm button in the danger palette (WEB-15), and moves initial focus to Cancel instead of it. */
  destructive?: boolean
  /**
   * `kind: 'choice'` only — the label of the third button, the one that
   * is neither "do the thing" (confirm) nor "back out" (cancel). A
   * three-way question ("Save, discard, or stay?") needs exactly one more
   * button than a confirm does, so it is one more mode of this same
   * component rather than a second dialog implementation (this file's own
   * module comment).
   */
  altLabel?: string
  /** `kind: 'choice'` only — activated by the `altLabel` button. */
  onAlt?: () => void
  /** `kind: 'prompt'` only. */
  promptLabel?: string
  promptValue?: string
  promptPlaceholder?: string
  promptError?: string
  onPromptValueChange?: (value: string) => void
  onConfirm: () => void
  onCancel: () => void
}

export function Modal({
  open,
  kind,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
  altLabel,
  onAlt,
  promptLabel,
  promptValue = '',
  promptPlaceholder,
  promptError,
  onPromptValueChange,
  onConfirm,
  onCancel,
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const promptRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      // Deliberate initial focus (this file's own module comment): a
      // prompt focuses its own field, a destructive confirm focuses
      // Cancel, and everything else focuses the confirm/acknowledge
      // button — never the browser's own "first focusable element"
      // default, which for this markup would already have been Cancel or
      // the field regardless, but is pinned explicitly rather than relied
      // on so a later reorder of this markup cannot silently change it.
      if (kind === 'prompt') promptRef.current?.focus()
      else if (destructive) cancelRef.current?.focus()
      else confirmRef.current?.focus()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open, kind, destructive])

  const id = useId()
  const titleId = `${id}-title`
  const descriptionId = description ? `${id}-description` : undefined

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      {...(descriptionId ? { 'aria-describedby': descriptionId } : {})}
      className="w-full max-w-sm rounded-lg border border-neutral-200 p-0 shadow-xl backdrop:bg-neutral-900/40"
      // WEB-17: `Escape` — the native dialog's own `cancel` event — closes
      // a cancellable dialog. An alert has no `cancelLabel`/`onCancel`
      // distinct from acknowledging it, so `Escape` there resolves the
      // same way the one button does. `preventDefault()` here is
      // deliberate: the browser's own default action for `cancel` is to
      // close the dialog itself, which would race this component's own
      // `open` prop — `onCancel()` instead runs `ModalProvider`'s own
      // `settle()`, which flips `open` to `false`, and *this* component's
      // own effect (above) is the one and only place that ever calls the
      // native `close()` — never the browser's own default, never a
      // second path (no `onClose` handler here) — so a native `close`
      // event only ever fires once per settle, not twice.
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <form
        method="dialog"
        className="flex flex-col gap-4 p-6"
        onSubmit={(event) => {
          event.preventDefault()
          onConfirm()
        }}
      >
        <h2 id={titleId} className="text-base font-semibold text-neutral-900">
          {title}
        </h2>
        {description && (
          <p id={descriptionId} className="text-sm text-neutral-600">
            {description}
          </p>
        )}
        {kind === 'prompt' && (
          <label className="flex flex-col gap-1 text-sm font-medium text-neutral-800">
            {promptLabel}
            <input
              ref={promptRef}
              type="text"
              value={promptValue}
              onChange={(event) => onPromptValueChange?.(event.target.value)}
              placeholder={promptPlaceholder}
              aria-invalid={promptError ? true : undefined}
              className={textInputClasses}
            />
            {promptError && (
              <span className="text-sm font-normal text-danger-700">
                {promptError}
              </span>
            )}
          </label>
        )}
        <div className="flex justify-end gap-2">
          {kind !== 'alert' && (
            <Button
              ref={cancelRef}
              type="button"
              variant="secondary"
              onClick={onCancel}
            >
              {cancelLabel ?? 'Cancel'}
            </Button>
          )}
          {/* The third way out of a `choice` dialog — "discard", where the
              confirm button is "save" and cancel is "stay here". Rendered
              between the two so the two *destructive-ish* answers are not
              adjacent to each other, and typed `button` so it never
              submits the form (which is what runs `onConfirm`). */}
          {kind === 'choice' && altLabel !== undefined && (
            <Button type="button" variant="secondary" onClick={onAlt}>
              {altLabel}
            </Button>
          )}
          <Button
            ref={confirmRef}
            type="submit"
            variant={destructive ? 'destructive' : 'primary'}
          >
            {confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  )
}
