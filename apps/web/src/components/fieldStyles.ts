/**
 * WEB-11/WEB-16: the Tailwind classes every text input, select and textarea
 * in this panel shares — named once so a field's own visual treatment
 * (border, padding, the `aria-invalid` danger outline) stays consistent
 * across every form without each page re-deriving it, the same "named
 * once, not repeated" discipline `style.css`'s own `@theme` block already
 * follows for color and spacing.
 *
 * WEB-48: the font size is `text-base` (16px) below the `sm` breakpoint and
 * `text-sm` (14px) at `sm` and up. iOS Safari zooms the whole page in when a
 * focused input's font-size is under 16px, and it does not zoom back out on
 * blur — that is the "sometimes zoomed in, sometimes not" the field report
 * described: it happens on screens with a form and not on screens without
 * one. The fix is a bigger font on phones, not disabling zoom (that would be
 * a WCAG 1.4.4 failure — see docs/DECISIONS.md); at `sm` and up the desktop
 * panel is unchanged.
 */

export const textInputClasses =
  'w-full rounded-md border border-neutral-300 px-3 py-2 text-base sm:text-sm text-neutral-900 shadow-sm ' +
  'focus:border-brand-500 aria-[invalid=true]:border-danger-600'

export const checkboxClasses =
  'size-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500'
