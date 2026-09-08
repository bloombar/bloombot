CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`person_id` text NOT NULL,
	`surface` text,
	`upstream_thread_id` text,
	`created_at` integer NOT NULL,
	`last_message_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversations_surface_check" CHECK("conversations"."surface" is null or "conversations"."surface" in ('discord', 'web', 'mcp'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_org_course_person_unscoped_unique` ON `conversations` (`organization_id`,`course_id`,`person_id`) WHERE "conversations"."surface" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_org_course_person_surface_unique` ON `conversations` (`organization_id`,`course_id`,`person_id`,`surface`) WHERE "conversations"."surface" is not null;--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`person_id` text NOT NULL,
	`course_id` text NOT NULL,
	`direction` text NOT NULL,
	`content` text NOT NULL,
	`surface` text,
	`channel_ref` text,
	`category_ref` text,
	`sequence` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "messages_direction_check" CHECK("messages"."direction" in ('from_person', 'to_person')),
	CONSTRAINT "messages_surface_check" CHECK("messages"."surface" is null or "messages"."surface" in ('discord', 'web', 'mcp'))
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_id_idx` ON `messages` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `messages_created_at_idx` ON `messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`display_name` text,
	`email` text,
	`first_name` text,
	`last_name` text,
	`github_handle` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `person_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`person_id` text NOT NULL,
	`surface` text NOT NULL,
	`external_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "person_identities_surface_check" CHECK("person_identities"."surface" in ('discord', 'web', 'mcp'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `person_identities_org_surface_external_unique` ON `person_identities` (`organization_id`,`surface`,`external_id`);--> statement-breakpoint
CREATE TABLE `usage_counters` (
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`person_id` text NOT NULL,
	`day` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `course_id`, `person_id`, `day`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "usage_counters_day_check" CHECK(length("usage_counters"."day") = 10
        and substr("usage_counters"."day", 1, 1) between '0' and '9'
        and substr("usage_counters"."day", 2, 1) between '0' and '9'
        and substr("usage_counters"."day", 3, 1) between '0' and '9'
        and substr("usage_counters"."day", 4, 1) between '0' and '9'
        and substr("usage_counters"."day", 5, 1) = '-'
        and substr("usage_counters"."day", 6, 1) between '0' and '9'
        and substr("usage_counters"."day", 7, 1) between '0' and '9'
        and substr("usage_counters"."day", 8, 1) = '-'
        and substr("usage_counters"."day", 9, 1) between '0' and '9'
        and substr("usage_counters"."day", 10, 1) between '0' and '9')
);
--> statement-breakpoint
-- CONV-1 / finding 1 of the CONV-1 rework: `drizzle-kit generate` proposes a
-- full table rebuild here (`DROP TABLE courses` behind a `PRAGMA
-- foreign_keys=OFF`), because SQLite ties a table-level CHECK constraint to
-- the whole `CREATE TABLE` statement. That rebuild fails on any database
-- that already has a course: drizzle's SQLite migrator wraps every
-- migration in `BEGIN`, `openDatabase` (`src/client.ts`) turns
-- `foreign_keys` back `ON` for the connection regardless, and `PRAGMA
-- foreign_keys=OFF` is a documented no-op once a transaction is open — so
-- `DROP TABLE courses` is enforced against `course_categories.course_id`
-- and the migration rolls back. A plain `ALTER TABLE ... ADD COLUMN` cannot
-- orphan anything: SQLite accepts a column-level `CHECK` on it directly
-- (verified against the running `better-sqlite3` version this package
-- pins), so the enum constraint stays enforced without a rebuild.
ALTER TABLE `courses` ADD COLUMN `conversation_scope` text DEFAULT 'course' NOT NULL CHECK("conversation_scope" in ('course', 'course_surface'));