/**
 * WEB-45: skeleton loaders for the panel's `Loading…` placeholders.
 *
 * Tailwind's own `animate-pulse` utility is the pulsing block — no new
 * dependency, and the `bg-neutral-200`/`rounded-md` tokens are the same ones
 * every other card and border in this panel already draws from
 * (`style.css`'s own `@theme` block), so a skeleton never invents a grey the
 * rest of the app does not already use.
 *
 * A purely decorative pulse says nothing to a screen reader — the
 * `<p role="status">Loading…</p>` it replaces did. So every skeleton here is
 * two things, always together: the pulsing shape(s), marked
 * `aria-hidden="true"` so assistive technology skips straight past them, and
 * `LoadingStatus`, a visually-hidden (`sr-only`, the same convention
 * `FileDropZone.tsx` and `CourseEditor.tsx` already use for text sighted
 * users do not need) `role="status"` paragraph carrying the identical
 * "Loading…" text the old placeholder announced — preserved exactly as it
 * was, no worse than before this slice. Whether that announcement is
 * actually *heard* is a separate question `LoadingStatus` does not itself
 * answer: WEB-43's own finding (`pages/CourseEditor.tsx`'s `Save course`
 * status, further down this file's own call sites) is that a `role="status"`
 * region mounted at the same moment as the text it carries is commonly
 * missed entirely, and every one of `LoadingStatus`'s sixteen call sites
 * (`Jobs.tsx`'s own persistent live region is the one exception) mounts
 * exactly that way — conditionally, together with its text, on the same
 * render as the rest of the skeleton. Making it reliable means the
 * always-mounted-and-only-the-text-changes pattern `Jobs.tsx` already uses;
 * that is a follow-up across all sixteen sites, not something this file
 * alone can fix.
 *
 * `prefers-reduced-motion: reduce` suppressing the pulse lives once in
 * `style.css`, rather than a `motion-reduce:` variant repeated at every call
 * site — `AppShell.tsx`'s drawer transition takes the per-call-site
 * approach because each of its transitions is a one-off; the pulse here is
 * the same rule everywhere a skeleton appears, so it belongs in the
 * stylesheet's own global rules instead.
 *
 * Two composed shapes cover this panel's two repeated cases: `SkeletonLine`
 * for a run of text (a heading, a sentence, a field's value) and
 * `SkeletonRow` for a list row's card geometry (`Projects.tsx`, `Courses.tsx`,
 * `Admin.tsx` and the other card-per-item lists). A screen whose loaded
 * content is not a list or a line of text — `App.tsx`'s whole-screen session
 * gate, which nobody has seen the shape of yet — uses the base `Skeleton`
 * directly; see each call site for which shape it took and why.
 */

/** The base pulsing block. Decorative only — always `aria-hidden`, and sized entirely by the caller's `className` (this component supplies no width or height of its own). */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-md bg-neutral-200 ${className}`}
    />
  )
}

/** A single line of text — a heading, a sentence, a field's value — as a fixed-height pulsing bar. `className` controls width; a caller wanting a taller line (a heading) passes its own height too. */
export function SkeletonLine({
  className = 'h-4 w-full',
}: {
  className?: string
}) {
  return <Skeleton className={className} />
}

/**
 * One list row, shaped like the card-per-item rows `Projects.tsx`,
 * `Courses.tsx`, `Admin.tsx` and `Transcripts.tsx` all render once their own
 * data resolves: a title-height line and a shorter detail line stacked on
 * the leading side, a small square (the row's own kebab or action) trailing.
 * `bordered` draws the same `rounded-md border border-neutral-200` those
 * rows use; the nested course list inside `Projects.tsx`'s own project rows
 * has no border of its own, so passes `bordered={false}`.
 */
export function SkeletonRow({
  bordered = true,
  className = '',
}: {
  bordered?: boolean
  className?: string
}) {
  return (
    <div
      aria-hidden="true"
      className={`flex items-center justify-between gap-3 ${
        bordered ? 'rounded-md border border-neutral-200 p-4' : ''
      } ${className}`}
    >
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <Skeleton className="h-4 w-4 shrink-0" />
    </div>
  )
}

/**
 * The accessible half of every skeleton on this screen — a visually-hidden
 * `role="status"` paragraph, so a screen reader still hears "Loading…" (or
 * `label`, for a screen that already says something more specific) even
 * though nothing beside it has visible text of its own to expose. Render
 * exactly one alongside a given skeleton's decorative shapes, the same way
 * the `<p role="status">Loading…</p>` it replaces was exactly one paragraph.
 */
export function LoadingStatus({ label = 'Loading…' }: { label?: string }) {
  return (
    <p role="status" className="sr-only">
      {label}
    </p>
  )
}
