CREATE TABLE `course_self_enrolment_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`person_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`redeemed_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `course_self_enrolment_intents_org_course_person_unredeemed_unique` ON `course_self_enrolment_intents` (`organization_id`,`course_id`,`person_id`) WHERE "course_self_enrolment_intents"."redeemed_at" is null;--> statement-breakpoint
CREATE INDEX `course_self_enrolment_intents_organization_id_idx` ON `course_self_enrolment_intents` (`organization_id`);--> statement-breakpoint
CREATE INDEX `course_self_enrolment_intents_person_id_idx` ON `course_self_enrolment_intents` (`person_id`,`organization_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_enrolments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`person_id` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	`reinstated_by_account_id` text,
	`reinstated_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reinstated_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "enrolments_source_check" CHECK("__new_enrolments"."source" in ('join_link', 'discord_role', 'roster', 'self_enrolment'))
);
--> statement-breakpoint
INSERT INTO `__new_enrolments`("id", "organization_id", "course_id", "person_id", "source", "created_at", "ended_at", "reinstated_by_account_id", "reinstated_at") SELECT "id", "organization_id", "course_id", "person_id", "source", "created_at", "ended_at", "reinstated_by_account_id", "reinstated_at" FROM `enrolments`;--> statement-breakpoint
DROP TABLE `enrolments`;--> statement-breakpoint
ALTER TABLE `__new_enrolments` RENAME TO `enrolments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `enrolments_org_course_person_active_unique` ON `enrolments` (`organization_id`,`course_id`,`person_id`) WHERE "enrolments"."ended_at" is null;--> statement-breakpoint
CREATE INDEX `enrolments_organization_id_idx` ON `enrolments` (`organization_id`);--> statement-breakpoint
CREATE INDEX `enrolments_person_id_idx` ON `enrolments` (`person_id`,`organization_id`);--> statement-breakpoint
ALTER TABLE `courses` ADD `self_enrol_from_discord` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `courses` ADD `answer_unenrolled` integer DEFAULT true NOT NULL;