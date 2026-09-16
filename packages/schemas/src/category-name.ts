/**
 * WEB-51 — a browser-safe mirror of `@bloombot/db`'s own
 * `normalizeCategoryName` (`packages/db/src/category-name.ts`, BOT-13/
 * PROJ-10): a category name matches another one when the two are equal
 * after lowercasing and removing *every* whitespace character, not merely
 * collapsing runs of it to one space — `"Web Design"`, `" web  design "`,
 * `"WEBDESIGN"` and `"Web\tDesign"` all normalize to the same string;
 * `"Web-Design"` does not, since punctuation is untouched.
 *
 * Duplicated rather than imported: `apps/web` never depends on `@bloombot/db`
 * at all (PLAT-2 — its own `package.json` description, enforced by
 * `eslint.config.js`'s `no-restricted-imports` and checked structurally by
 * `apps/web/tests/bundle.test.ts`), and `@bloombot/schemas` is this repo's
 * existing home for a small, dependency-free string helper more than one
 * package reuses (`web-source-domain.ts`'s own module comment). The two
 * copies must stay identical — `packages/db/src/category-name.ts`'s own
 * comment cross-references this one — but a single shared function across
 * that boundary would cost `apps/web` a dependency on the entire database
 * package just to normalize a string, the same trade `web-source-domain.ts`
 * already declined for `@bloombot/core`.
 *
 * Used client-side for two things (`pages/CourseEditor.tsx`): flagging a
 * same-course category duplicate before a save is even attempted, and
 * matching a server-refused save's `conflict.name` back to the category row
 * that caused it.
 */
export function normalizeCategoryName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '')
}
