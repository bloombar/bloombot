CREATE TABLE `roster_channel_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`person_id` text NOT NULL,
	`discord_channel_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roster_channel_assignments_course_person_unique` ON `roster_channel_assignments` (`course_id`,`person_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `roster_channel_assignments_channel_unique` ON `roster_channel_assignments` (`discord_channel_id`);--> statement-breakpoint
CREATE INDEX `roster_channel_assignments_organization_id_idx` ON `roster_channel_assignments` (`organization_id`);