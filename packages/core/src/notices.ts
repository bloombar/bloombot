/**
 * SURF-10: the one wording every surface shows for `answerQuestion`'s own
 * `declined-not-approved` kind (COST-8). Unlike every other refusal kind
 * (`answer.ts`'s own module comment: "carries no text of its own... the
 * calling surface's job"), this one's *text itself* is a SPEC requirement —
 * SURF-10 says "a notice that the course must be approved... naming the
 * support contact the deployment configures" on the web, in Discord and
 * through MCP *alike* — so a shared function here, called by all three,
 * is what keeps the wording byte-identical rather than three surfaces each
 * inventing their own phrasing that drifts the moment one is edited.
 */

/**
 * `supportContact` is `CONFIG.SUPPORT_CONTACT` (`packages/config/src/env.ts`),
 * threaded in rather than read here — this package holds no dependency on
 * `@bloombot/config` at all (CORE-4's "dependencies as arguments"
 * discipline, D-29). An empty string (the unset default) drops the "at
 * <contact>" clause entirely rather than rendering a blank address.
 */
export function courseNotApprovedNotice(supportContact: string): string {
  const contact = supportContact.trim()
  const contactClause = contact ? ` at ${contact}` : ''
  return (
    "This course hasn't been approved to answer questions yet. The course " +
    `owner should contact Bloombot support${contactClause} to request approval.`
  )
}
