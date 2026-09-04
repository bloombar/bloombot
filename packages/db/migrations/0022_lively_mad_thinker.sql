CREATE TABLE `course_web_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`domain` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `course_web_sources_course_id_idx` ON `course_web_sources` (`course_id`);--> statement-breakpoint
CREATE INDEX `course_web_sources_organization_id_idx` ON `course_web_sources` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `course_web_sources_course_domain_unique` ON `course_web_sources` (`course_id`,`domain`);