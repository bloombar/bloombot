/**
 * WEB-70 — a job's own `kind` is an internal string
 * (`roster.import`, `contentDeletions.removeBytes`) that tells an
 * organization's owner nothing; `describeJob` turns it into a short,
 * readable title and a plain-language sentence of what the work actually
 * did, for `pages/Jobs.tsx` to render instead of the raw `kind`.
 *
 * The eight entries below are the eight job kinds `apps/worker/src/index.ts`
 * registers a handler for (that file's own `handlers.register` calls, one
 * per kind) — this app cannot import that app's source (`apps/web` depends
 * on `@bloombot/actions`, never on `apps/worker`, the same app/package
 * boundary `Jobs.tsx`'s own module comment and `packages/actions/src/actions/
 * courses.ts`'s `COURSE_APPROVAL_NOTIFY_PENDING_JOB_KIND`/
 * `REMOVE_DELETED_CONTENT_BYTES_JOB_KIND` already draw for the kind strings
 * themselves), so the kind strings here are literal duplicates by the same
 * convention, not a cross-package import. Keep this table in step by hand
 * with `apps/worker/src/index.ts`'s own `handlers.register` calls whenever a
 * kind is added, renamed or removed there.
 *
 * A kind not in this table — a future one this module has not caught up
 * with yet, or a stale one no longer registered — falls back to naming the
 * kind itself, so a job is never rendered invisible or blank; see the
 * `default` case below.
 */

export interface JobDescription {
  /** A short, readable label for the row's own heading — never the raw `kind` string. */
  title: string
  /** One or two plain-language sentences of what finishing this job meant, free of implementation jargon. */
  detail: string
}

/**
 * Maps a job's own `kind` to the human-readable title and detail
 * `pages/Jobs.tsx` renders for it. An unrecognised kind falls back to
 * naming the kind itself, in both fields, rather than throwing or
 * returning something blank — the same "never invisible" requirement
 * WEB-70 states for a kind this table has not caught up with yet.
 */
export function describeJob(kind: string): JobDescription {
  switch (kind) {
    case 'discordServers.scaffold':
      return {
        title: 'Set up Discord channels',
        detail:
          "Created the course's Discord categories and channels, leaving anything that already existed untouched.",
      }
    case 'roster.import':
      return {
        title: 'Import roster',
        detail:
          'Read an uploaded class roster, matched each student to their Discord account where possible, and enrolled them in the course.',
      }
    case 'courseAttachments.attach':
      return {
        title: 'Add course file',
        detail:
          "Uploaded a file so the course's assistant can use it to answer questions.",
      }
    case 'courseAttachments.detach':
      return {
        title: 'Remove course file',
        detail:
          "Removed a file so the course's assistant can no longer use it to answer questions.",
      }
    case 'transcripts.export':
      return {
        title: 'Export transcripts',
        detail:
          "Built a downloadable file of a course's conversation history for the filters that were requested.",
      }
    case 'contentDeletions.removeBytes':
      return {
        title: 'Clean up deleted course data',
        detail:
          'Finished removing the files and other stored data left behind after a course or project was deleted.',
      }
    case 'courseApproval.notifyPending':
      return {
        title: 'Notify support of a pending course',
        detail:
          "Let this deployment's support contact know a course is waiting for approval.",
      }
    case 'retention.sweep':
      return {
        title: 'Clean up deleted data',
        detail:
          'Permanently removed accounts, people, organizations, projects, courses and conversation history that had been deleted for longer than this deployment allows for changing that.',
      }
    default:
      // WEB-70: a kind this table does not (yet) recognise is named by its
      // own kind string rather than hidden — the same "never invisible"
      // reasoning this module's own comment states above.
      return { title: kind, detail: kind }
  }
}
