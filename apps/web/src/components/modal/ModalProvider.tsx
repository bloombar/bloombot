/**
 * WEB-15/WEB-16/WEB-17: the imperative side of `Modal.tsx` — a caller
 * writes `await confirm({...})` rather than wiring `open`/`onConfirm`/
 * `onCancel` state into every screen that needs a destructive confirmation
 * or an unsaved-changes prompt. One `<Modal>` is mounted here, once, for
 * the whole app (`App.tsx` wraps everything in `ModalProvider`); every
 * caller shares it rather than mounting a dialog of its own — a second
 * `<dialog>` for an alert/confirm/prompt anywhere else in this app is the
 * duplication this file exists to prevent.
 *
 * Only one request is ever open at a time (this app never needs to stack
 * a confirmation on top of another one) — a second call while one is
 * already open queues behind it rather than clobbering the first caller's
 * still-pending promise, so two guards that both fire in the same tick
 * (WEB-16's own unsaved-changes prompt firing from two different exits at
 * once, say) both still get an honest answer instead of one silently
 * losing its `resolve`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { Modal, type ModalKind } from './Modal.js'

export interface AlertOptions {
  title: string
  description?: string
  confirmLabel?: string
}

export interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  /** WEB-15: renders the confirm button destructive, and moves initial focus to Cancel instead of it (`Modal.tsx`'s own module comment). */
  destructive?: boolean
}

export interface PromptOptions {
  title: string
  description?: string
  label: string
  placeholder?: string
  initialValue?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Returns an error message to show (and keep the dialog open) when the current value is not acceptable — e.g. "type the course's title to confirm" not yet matching. */
  validate?: (value: string) => string | undefined
  /** WEB-15, the same flag `ConfirmOptions` already carries: renders the submit button destructive (`Modal.tsx`'s own `variant={destructive ? 'destructive' : 'primary'}` already applies to a prompt's own button, not only a confirm's) — for a prompt severe enough to ask a typed name rather than a plain yes/no, e.g. ADMIN-5's own tenant deletion. */
  destructive?: boolean
}

interface ModalContextValue {
  /** Acknowledge-only — resolves once the one button is activated (or `Escape` is pressed, which this component treats the same way: nothing to cancel *back to*). */
  alert(options: AlertOptions): Promise<void>
  /** Resolves `true` on confirm, `false` on cancel or `Escape` — never rejects, so a caller never needs a `.catch` just to handle "the caller backed out." */
  confirm(options: ConfirmOptions): Promise<boolean>
  /** Resolves the typed value on confirm, `undefined` on cancel or `Escape`. */
  prompt(options: PromptOptions): Promise<string | undefined>
}

const ModalContext = createContext<ModalContextValue | undefined>(undefined)

/** One pending request this provider is currently showing, or about to. */
interface Request {
  kind: ModalKind
  title: string
  description?: string
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
  promptLabel?: string
  promptValue?: string
  promptPlaceholder?: string
  validate?: (value: string) => string | undefined
  resolve: (value: string | boolean | undefined) => void
}

export function ModalProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Request | undefined>(undefined)
  // Finding, caught only by `e2e/keyboard.spec.ts` against a real browser
  // (jsdom's own `<dialog>` polyfill cannot catch this — `tests/setup.ts`'s
  // own module comment): `<Modal>` used to be conditionally rendered —
  // `{current && <Modal .../>}` — so `settle()` clearing `current` on
  // Cancel/Confirm/`Escape` *unmounted* the `<dialog>` element outright,
  // rather than calling its own native `close()` first. A `<dialog>`
  // ripped out of the DOM without `close()` ever running never runs the
  // browser's own focus-restoration algorithm (that is `close()`'s own
  // job) — focus fell back to `<body>` instead of returning to whatever
  // opened the dialog, silently failing WEB-17's own "focus restored to
  // the trigger." `renderedRequest` is the fix: it holds the *last*
  // request's own content, is set once and never cleared, so `<Modal>`
  // stays mounted, with `open={current !== undefined}` toggling instead —
  // `Modal.tsx`'s own effect then calls the native `close()` itself,
  // letting the browser do its own restoration before this app removes
  // anything.
  const [renderedRequest, setRenderedRequest] = useState<Request | undefined>(
    undefined
  )
  const [promptValue, setPromptValue] = useState('')
  const [promptError, setPromptError] = useState<string | undefined>(undefined)
  // Mirrors `current`, synchronously — `show()` below needs to know
  // whether a request is already open at the moment it is called, and
  // reading state set by a previous render is not reliable for that; a
  // ref updated in lockstep with `setCurrent` (`openNext`/`settle`, both
  // below) is. Finding: a second `confirm()`/`alert()`/`prompt()` call
  // while one is already open must not silently drop the first caller's
  // own promise — queued here and drained by `settle` once the open one
  // resolves (this file's own module comment).
  const currentRef = useRef<Request | undefined>(undefined)
  const queueRef = useRef<Request[]>([])

  const openNext = useCallback((request: Request) => {
    currentRef.current = request
    setPromptValue(request.promptValue ?? '')
    setPromptError(undefined)
    setCurrent(request)
    setRenderedRequest(request)
  }, [])

  const show = useCallback(
    (request: Omit<Request, 'resolve'>) =>
      new Promise<string | boolean | undefined>((resolve) => {
        const full: Request = { ...request, resolve }
        if (currentRef.current) {
          queueRef.current.push(full)
        } else {
          openNext(full)
        }
      }),
    [openNext]
  )

  const settle = useCallback(
    (value: string | boolean | undefined) => {
      currentRef.current?.resolve(value)
      currentRef.current = undefined
      const next = queueRef.current.shift()
      if (next) openNext(next)
      else setCurrent(undefined)
    },
    [openNext]
  )

  const value: ModalContextValue = {
    alert: (options) =>
      show({
        kind: 'alert',
        title: options.title,
        ...(options.description !== undefined
          ? { description: options.description }
          : {}),
        confirmLabel: options.confirmLabel ?? 'OK',
      }).then(() => undefined),
    confirm: (options) =>
      show({
        kind: 'confirm',
        title: options.title,
        ...(options.description !== undefined
          ? { description: options.description }
          : {}),
        confirmLabel: options.confirmLabel ?? 'Confirm',
        cancelLabel: options.cancelLabel ?? 'Cancel',
        destructive: options.destructive ?? false,
      }).then((result) => result === true),
    prompt: (options) =>
      show({
        kind: 'prompt',
        title: options.title,
        ...(options.description !== undefined
          ? { description: options.description }
          : {}),
        confirmLabel: options.confirmLabel ?? 'Confirm',
        cancelLabel: options.cancelLabel ?? 'Cancel',
        promptLabel: options.label,
        promptValue: options.initialValue ?? '',
        ...(options.placeholder !== undefined
          ? { promptPlaceholder: options.placeholder }
          : {}),
        ...(options.validate !== undefined
          ? { validate: options.validate }
          : {}),
        destructive: options.destructive ?? false,
      }).then((result) => (typeof result === 'string' ? result : undefined)),
  }

  const handleConfirm = () => {
    if (current?.kind === 'prompt') {
      const error = current.validate?.(promptValue)
      if (error) {
        setPromptError(error)
        return
      }
      settle(promptValue)
      return
    }
    settle(true)
  }

  const handleCancel = () => {
    settle(current?.kind === 'confirm' ? false : undefined)
  }

  return (
    <ModalContext value={value}>
      {children}
      {renderedRequest && (
        <Modal
          // `current`, not `renderedRequest` — this is the one prop that
          // actually toggles native open/close (this file's own module
          // comment on `renderedRequest`); every other prop below reads
          // `renderedRequest` so the dialog's own content does not go
          // blank the instant it starts closing.
          open={current !== undefined}
          kind={renderedRequest.kind}
          title={renderedRequest.title}
          {...(renderedRequest.description !== undefined
            ? { description: renderedRequest.description }
            : {})}
          confirmLabel={renderedRequest.confirmLabel}
          {...(renderedRequest.cancelLabel !== undefined
            ? { cancelLabel: renderedRequest.cancelLabel }
            : {})}
          destructive={renderedRequest.destructive ?? false}
          {...(renderedRequest.promptLabel !== undefined
            ? { promptLabel: renderedRequest.promptLabel }
            : {})}
          promptValue={promptValue}
          {...(renderedRequest.promptPlaceholder !== undefined
            ? { promptPlaceholder: renderedRequest.promptPlaceholder }
            : {})}
          {...(promptError !== undefined ? { promptError } : {})}
          onPromptValueChange={(next) => {
            setPromptValue(next)
            setPromptError(undefined)
          }}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </ModalContext>
  )
}

/** WEB-15/WEB-16: `await confirm({...})`/`await prompt({...})`/`await alert({...})` — see `ModalProvider`'s own module comment for why this is the one door to a modal in this app. Throws if used outside `ModalProvider` (`App.tsx` mounts exactly one, at the root) — a call site with no provider above it is a wiring mistake, not a state this hook should silently paper over. */
export function useModal(): ModalContextValue {
  const context = useContext(ModalContext)
  if (!context) {
    throw new Error('useModal() must be used inside a <ModalProvider>')
  }
  return context
}
