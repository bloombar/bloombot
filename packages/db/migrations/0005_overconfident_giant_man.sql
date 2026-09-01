CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`max_attempts` integer NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`claimed_by` text,
	`claim_expires_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "jobs_status_check" CHECK("jobs"."status" in ('pending', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `jobs_status_next_attempt_idx` ON `jobs` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `jobs_organization_id_idx` ON `jobs` (`organization_id`);