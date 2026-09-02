CREATE TABLE `tenant_deletions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`organization_name` text NOT NULL,
	`deleted_by_account_id` text NOT NULL,
	`summary` text NOT NULL,
	`deleted_at` integer NOT NULL,
	FOREIGN KEY (`deleted_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `transcript_access_log` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`actor_account_id` text NOT NULL,
	`person_id` text,
	`kind` text NOT NULL,
	`start_at` integer,
	`end_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transcript_access_log_kind_check" CHECK("transcript_access_log"."kind" in ('read', 'export'))
);
--> statement-breakpoint
CREATE INDEX `transcript_access_log_course_id_idx` ON `transcript_access_log` (`course_id`);--> statement-breakpoint
CREATE INDEX `transcript_access_log_organization_id_idx` ON `transcript_access_log` (`organization_id`);--> statement-breakpoint
CREATE TABLE `transcript_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`person_id` text,
	`requested_by_account_id` text NOT NULL,
	`status` text NOT NULL,
	`start_at` integer,
	`end_at` integer,
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
	CONSTRAINT "transcript_exports_status_check" CHECK("transcript_exports"."status" in ('pending', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `transcript_exports_course_id_idx` ON `transcript_exports` (`course_id`);--> statement-breakpoint
CREATE INDEX `transcript_exports_organization_id_idx` ON `transcript_exports` (`organization_id`);