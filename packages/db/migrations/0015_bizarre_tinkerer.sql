PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`max_attempts` integer NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`claimed_by` text,
	`claim_expires_at` integer,
	`last_error` text,
	`result` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "jobs_status_check" CHECK("__new_jobs"."status" in ('pending', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_jobs`("id", "organization_id", "kind", "payload", "status", "attempts", "max_attempts", "next_attempt_at", "claimed_by", "claim_expires_at", "last_error", "result", "created_at", "updated_at") SELECT "id", "organization_id", "kind", "payload", "status", "attempts", "max_attempts", "next_attempt_at", "claimed_by", "claim_expires_at", "last_error", "result", "created_at", "updated_at" FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `jobs_status_next_attempt_idx` ON `jobs` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `jobs_organization_id_idx` ON `jobs` (`organization_id`);