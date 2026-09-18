CREATE TABLE `roster_import_acknowledgements` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`account_id` text NOT NULL,
	`filename` text NOT NULL,
	`job_id` text NOT NULL,
	`acknowledgement_version` text NOT NULL,
	`acknowledged_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `roster_import_acknowledgements_course_id_idx` ON `roster_import_acknowledgements` (`course_id`);--> statement-breakpoint
CREATE INDEX `roster_import_acknowledgements_organization_id_idx` ON `roster_import_acknowledgements` (`organization_id`);--> statement-breakpoint
CREATE INDEX `roster_import_acknowledgements_account_id_idx` ON `roster_import_acknowledgements` (`account_id`);