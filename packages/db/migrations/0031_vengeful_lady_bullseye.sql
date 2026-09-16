CREATE TABLE `content_deletions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`subject_name` text NOT NULL,
	`deleted_by_account_id` text NOT NULL,
	`summary` text NOT NULL,
	`deleted_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deleted_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "content_deletions_kind_check" CHECK("content_deletions"."kind" in ('course', 'project'))
);
--> statement-breakpoint
CREATE INDEX `content_deletions_organization_id_idx` ON `content_deletions` (`organization_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cost_ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text,
	`person_id` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_micros` integer NOT NULL,
	`measurement` text NOT NULL,
	`surface` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cost_ledger_entries_measurement_check" CHECK("__new_cost_ledger_entries"."measurement" in ('measured', 'estimated')),
	CONSTRAINT "cost_ledger_entries_surface_check" CHECK("__new_cost_ledger_entries"."surface" in ('discord', 'web', 'mcp', 'unknown'))
);
--> statement-breakpoint
INSERT INTO `__new_cost_ledger_entries`("id", "organization_id", "course_id", "person_id", "model", "input_tokens", "output_tokens", "cost_micros", "measurement", "surface", "created_at") SELECT "id", "organization_id", "course_id", "person_id", "model", "input_tokens", "output_tokens", "cost_micros", "measurement", "surface", "created_at" FROM `cost_ledger_entries`;--> statement-breakpoint
DROP TABLE `cost_ledger_entries`;--> statement-breakpoint
ALTER TABLE `__new_cost_ledger_entries` RENAME TO `cost_ledger_entries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `cost_ledger_entries_organization_id_idx` ON `cost_ledger_entries` (`organization_id`);--> statement-breakpoint
CREATE INDEX `cost_ledger_entries_course_id_idx` ON `cost_ledger_entries` (`course_id`);