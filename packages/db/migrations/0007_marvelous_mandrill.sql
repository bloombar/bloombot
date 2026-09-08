CREATE TABLE `course_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`status` text NOT NULL,
	`provider_file_id` text,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "course_attachments_status_check" CHECK("course_attachments"."status" in ('pending', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `course_attachments_course_id_idx` ON `course_attachments` (`course_id`);--> statement-breakpoint
CREATE INDEX `course_attachments_organization_id_idx` ON `course_attachments` (`organization_id`);--> statement-breakpoint
CREATE TABLE `course_instruction_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`instructions` text NOT NULL,
	`saved_by_account_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`saved_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `course_instruction_revisions_course_id_idx` ON `course_instruction_revisions` (`course_id`);--> statement-breakpoint
CREATE INDEX `course_instruction_revisions_organization_id_idx` ON `course_instruction_revisions` (`organization_id`);