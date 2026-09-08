/**
 * WEB-11/WEB-16: the Tailwind classes every text input, select and textarea
 * in this panel shares — named once so a field's own visual treatment
 * (border, padding, the `aria-invalid` danger outline) stays consistent
 * across every form without each page re-deriving it, the same "named
 * once, not repeated" discipline `style.css`'s own `@theme` block already
 * follows for color and spacing.
 */

export const textInputClasses =
  'w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 shadow-sm ' +
  'focus:border-brand-500 aria-[invalid=true]:border-danger-600'

export const checkboxClasses =
  'size-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500'
