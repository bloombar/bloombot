CREATE TABLE `course_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`email` text NOT NULL,
	`first_name` text,
	`last_name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`accepted_at` integer,
	`accepted_person_id` text,
	`outcome` text,
	`revoked_at` integer,
	`revoked_by_account_id` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accepted_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "course_invitations_outcome_check" CHECK("course_invitations"."outcome" is null or "course_invitations"."outcome" in ('enrolled', 'already_enrolled', 'refused_ended'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `course_invitations_course_email_open_unique` ON `course_invitations` (`course_id`,`email`) WHERE "course_invitations"."accepted_at" is null and "course_invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX `course_invitations_email_idx` ON `course_invitations` (`email`);--> statement-breakpoint
CREATE INDEX `course_invitations_organization_id_idx` ON `course_invitations` (`organization_id`);