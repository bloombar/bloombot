CREATE TABLE `course_approval_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`action` text NOT NULL,
	`account_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "course_approval_events_action_check" CHECK("course_approval_events"."action" in ('auto-approve', 'approve', 'revoke'))
);
--> statement-breakpoint
CREATE INDEX `course_approval_events_course_id_idx` ON `course_approval_events` (`course_id`);--> statement-breakpoint
CREATE INDEX `course_approval_events_organization_id_idx` ON `course_approval_events` (`organization_id`);--> statement-breakpoint
ALTER TABLE `courses` ADD `ai_approved_at` integer;--> statement-breakpoint
ALTER TABLE `courses` ADD `ai_approved_by_account_id` text REFERENCES accounts(id);--> statement-breakpoint
ALTER TABLE `courses` ADD `ai_approval_decided_at` integer;