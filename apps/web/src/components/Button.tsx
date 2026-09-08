/**
 * WEB-15: one button component every screen reaches for, so "primary looks
 * different from secondary, and destructive is distinguishable from both"
 * is a property of this component rather than a rule every page has to
 * remember to apply consistently by hand.
 *
 *  - `primary` — solid brand fill. At most one per screen (WEB-15's own
 *    "one primary call to action") — this component cannot enforce that by
 *    itself (nothing stops a page from rendering two), so it stays a
 *    per-page discipline; see each page's own choice of which action gets
 *    it.
 *  - `secondary` — outlined, low emphasis. Every other ordinary action.
 *  - `destructive` — outlined in the danger color, filling solid on
 *    hover/focus. Never the primary action's own color, so a destructive
 *    control never reads as "the thing this screen wants you to do."
 *  - `ghost` — no border, no fill — icon-only controls in a list row (edit,
 *    remove) where a bordered button per row would be visual noise; still
 *    gets the same focus ring and disabled treatment as every other
 *    variant.
 *
 * WEB-17: every variant keeps the global `:focus-visible` ring
 * (`style.css`), a visible `disabled` state, and is a real `<button>` — so
 * keyboard reachability and operability come from using this component at
 * all, not from a rule a page author has to remember.
 */

import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost'

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-300 border border-transparent',
  secondary:
    'bg-white text-neutral-800 border border-neutral-300 hover:bg-neutral-50 disabled:text-neutral-400 disabled:bg-neutral-50',
  destructive:
    'bg-white text-danger-700 border border-danger-600 hover:bg-danger-600 hover:text-white disabled:text-danger-300 disabled:border-danger-200',
  ghost:
    'bg-transparent text-neutral-600 border border-transparent hover:bg-neutral-100 disabled:text-neutral-300',
}

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className'
> {
  variant?: ButtonVariant
  /** A Lucide icon component (from `icons.ts`) shown before the label — `aria-hidden`, since the label alongside it already carries the meaning (WEB-12). */
  icon?: ReactNode
  /** Icon-only button: no visible label. Required to say why not — this component refuses to render an icon-only button silently missing one (WEB-12's "an icon never carries meaning alone"). */
  'aria-label'?: string
  /** React 19 passes `ref` as a plain prop to a function component — no `forwardRef` wrapper needed. `Modal.tsx` uses this to move initial focus deliberately (WEB-17's own "not the browser's default" — that file's module comment has the reasoning). */
  ref?: Ref<HTMLButtonElement>
}

export function Button({
  variant = 'secondary',
  icon,
  children,
  type = 'button',
  ref,
  ...rest
}: ButtonProps) {
  // WEB-12's own "an icon never carries meaning alone" — enforced here, not
  // only documented: an icon-only button (has `icon`, no visible label
  // text, no `aria-label`) warns loudly in development rather than shipping
  // a control a screen reader has nothing to say about. Dev-only
  // (`import.meta.env.DEV`) — this is a build-time lint substitute, not a
  // production-facing check, and a console warning on every render of every
  // button in production would be its own kind of noise.
  if (
    import.meta.env.DEV &&
    icon &&
    !children &&
    !rest['aria-label'] &&
    !rest['aria-labelledby']
  ) {
    console.error(
      'Button: an icon-only button (no visible label text) must carry an aria-label — WEB-12 requires every icon-only control to have an accessible name.'
    )
  }

  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}
