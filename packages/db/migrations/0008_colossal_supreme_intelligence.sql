CREATE TABLE `cost_ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`person_id` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_micros` integer NOT NULL,
	`measurement` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cost_ledger_entries_measurement_check" CHECK("cost_ledger_entries"."measurement" in ('measured', 'estimated'))
);
--> statement-breakpoint
CREATE INDEX `cost_ledger_entries_organization_id_idx` ON `cost_ledger_entries` (`organization_id`);--> statement-breakpoint
CREATE INDEX `cost_ledger_entries_course_id_idx` ON `cost_ledger_entries` (`course_id`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `spending_cap_micros` integer;