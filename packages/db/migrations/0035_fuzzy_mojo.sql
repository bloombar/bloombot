PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_transcript_access_log` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`actor_account_id` text NOT NULL,
	`person_id` text,
	`kind` text NOT NULL,
	`start_at` integer,
	`end_at` integer,
	`surface` text,
	`sequence` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transcript_access_log_kind_check" CHECK("__new_transcript_access_log"."kind" in ('read', 'export')),
	CONSTRAINT "transcript_access_log_surface_check" CHECK("__new_transcript_access_log"."surface" is null or "__new_transcript_access_log"."surface" in ('discord', 'web', 'mcp'))
);
--> statement-breakpoint
-- WEB-66: `transcript_access_log` predates this column, so every existing
-- row backfills to `NULL` (no surface filter was ever recorded) — hand-fixed
-- from drizzle-kit's own generated output the same way `0034_slow_mole_man.sql`'s
-- own comment already explains for the identical defect on
-- `transcript_exports.surface`: drizzle-kit selected a `"surface"` column
-- off the *old* table, which does not have one, rather than a literal.
INSERT INTO `__new_transcript_access_log`("id", "organization_id", "course_id", "actor_account_id", "person_id", "kind", "start_at", "end_at", "surface", "sequence", "created_at") SELECT "id", "organization_id", "course_id", "actor_account_id", "person_id", "kind", "start_at", "end_at", NULL, "sequence", "created_at" FROM `transcript_access_log`;--> statement-breakpoint
DROP TABLE `transcript_access_log`;--> statement-breakpoint
ALTER TABLE `__new_transcript_access_log` RENAME TO `transcript_access_log`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `transcript_access_log_course_id_idx` ON `transcript_access_log` (`course_id`);--> statement-breakpoint
CREATE INDEX `transcript_access_log_organization_id_idx` ON `transcript_access_log` (`organization_id`);