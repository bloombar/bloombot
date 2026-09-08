CREATE TABLE `course_join_links` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`created_by_account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `course_join_links_secret_hash_unique` ON `course_join_links` (`secret_hash`);--> statement-breakpoint
CREATE TABLE `enrolments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`person_id` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "enrolments_source_check" CHECK("enrolments"."source" in ('join_link', 'discord_role', 'roster'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enrolments_org_course_person_active_unique` ON `enrolments` (`organization_id`,`course_id`,`person_id`) WHERE "enrolments"."ended_at" is null;--> statement-breakpoint
CREATE INDEX `enrolments_organization_id_idx` ON `enrolments` (`organization_id`);--> statement-breakpoint
ALTER TABLE `memberships` ADD `granted_by_account_id` text REFERENCES accounts(id);--> statement-breakpoint
ALTER TABLE `memberships` ADD `granted_at` integer;