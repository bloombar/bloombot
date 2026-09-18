PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_transcript_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`person_id` text,
	`requested_by_account_id` text NOT NULL,
	`status` text NOT NULL,
	`start_at` integer,
	`end_at` integer,
	`surface` text,
	`filename` text,
	`content_type` text,
	`size_bytes` integer,
	`failure_reason` text,
	`sequence` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transcript_exports_status_check" CHECK("__new_transcript_exports"."status" in ('pending', 'ready', 'failed')),
	CONSTRAINT "transcript_exports_surface_check" CHECK("__new_transcript_exports"."surface" is null or "__new_transcript_exports"."surface" in ('discord', 'web', 'mcp'))
);
--> statement-breakpoint
-- WEB-66: `transcript_exports` predates this column, so every existing row
-- backfills to `NULL` (unfiltered by surface) — hand-fixed from
-- drizzle-kit's own generated output, which selected a `"surface"` column
-- off the *old* table that does not exist there (the same defect the sibling
-- fix in `0030_uneven_human_torch.sql`'s own comment describes for
-- `cost_ledger_entries.surface`, though that column was `NOT NULL` and
-- backfilled to the literal `'unknown'` instead — this one is nullable, and
-- `NULL` is the accurate "no filter was ever requested" answer for a row
-- exported before this column existed, not a guess).
INSERT INTO `__new_transcript_exports`("id", "organization_id", "course_id", "person_id", "requested_by_account_id", "status", "start_at", "end_at", "surface", "filename", "content_type", "size_bytes", "failure_reason", "sequence", "created_at", "updated_at") SELECT "id", "organization_id", "course_id", "person_id", "requested_by_account_id", "status", "start_at", "end_at", NULL, "filename", "content_type", "size_bytes", "failure_reason", "sequence", "created_at", "updated_at" FROM `transcript_exports`;--> statement-breakpoint
DROP TABLE `transcript_exports`;--> statement-breakpoint
ALTER TABLE `__new_transcript_exports` RENAME TO `transcript_exports`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `transcript_exports_course_id_idx` ON `transcript_exports` (`course_id`);--> statement-breakpoint
CREATE INDEX `transcript_exports_organization_id_idx` ON `transcript_exports` (`organization_id`);