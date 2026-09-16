/**
 * BOT-13/PROJ-10: a category name matches another one when the two are equal
 * after lowercasing and removing *every* whitespace character — leading,
 * trailing, and every run of inner whitespace collapses to nothing, not just
 * to a single space. `"Web Design"`, `" web  design "`, `"WEBDESIGN"` and
 * `"Web\tDesign"` all normalize to the same string; `"Web-Design"` does not,
 * since punctuation is not touched. One comparison, shared by Discord's own
 * routing (BOT-13, `@bloombot/core`'s `routing.ts`), every save-time
 * uniqueness check of a category name (PROJ-10, `repos/courses.ts`), and
 * scaffolding's recognition of an existing Discord category
 * (`apps/worker/src/handlers/discord-scaffold.ts`).
 *
 * Lives in `@bloombot/db`, not `@bloombot/core`: `core` already depends on
 * `db`, not the other way around, and `courses.ts`'s own PROJ-3 checks need
 * this too.
 *
 * Deliberately *removes* whitespace rather than collapsing runs of it to one
 * space (docs/DECISIONS.md has the fuller reasoning) — "Web  Design" (two
 * spaces) and "WebDesign" (none) count as the same category, not merely
 * "Web Design" and "Web  Design".
 */
export function normalizeCategoryName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '')
}
