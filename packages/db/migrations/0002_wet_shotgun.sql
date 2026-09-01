CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`person_id` text NOT NULL,
	`surface` text,
	`upstream_thread_id` text,
	`created_at` integer NOT NULL,
	`last_message_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversations_surface_check" CHECK("conversations"."surface" is null or "conversations"."surface" in ('discord', 'web', 'mcp'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_org_course_person_unscoped_unique` ON `conversations` (`organization_id`,`course_id`,`person_id`) WHERE "conversations"."surface" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_org_course_person_surface_unique` ON `conversations` (`organization_id`,`course_id`,`person_id`,`surface`) WHERE "conversations"."surface" is not null;--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`person_id` text NOT NULL,
	`course_id` text NOT NULL,
	`direction` text NOT NULL,
	`content` text NOT NULL,
	`surface` text,
	`channel_ref` text,
	`category_ref` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "messages_direction_check" CHECK("messages"."direction" in ('from_person', 'to_person')),
	CONSTRAINT "messages_surface_check" CHECK("messages"."surface" is null or "messages"."surface" in ('discord', 'web', 'mcp'))
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_id_idx` ON `messages` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `messages_created_at_idx` ON `messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`display_name` text,
	`email` text,
	`first_name` text,
	`last_name` text,
	`github_handle` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `person_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`person_id` text NOT NULL,
	`surface` text NOT NULL,
	`external_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "person_identities_surface_check" CHECK("person_identities"."surface" in ('discord', 'web', 'mcp'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `person_identities_org_surface_external_unique` ON `person_identities` (`organization_id`,`surface`,`external_id`);--> statement-breakpoint
CREATE TABLE `usage_counters` (
	`organization_id` text NOT NULL,
	`course_id` text NOT NULL,
	`person_id` text NOT NULL,
	`day` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `course_id`, `person_id`, `day`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_courses` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`file_prefix` text NOT NULL,
	`enabled` integer NOT NULL,
	`admins_role` text NOT NULL,
	`students_role` text NOT NULL,
	`prompt_id` text,
	`instructions` text,
	`model` text,
	`vector_store_id` text,
	`max_requests_per_day` integer,
	`conversation_scope` text DEFAULT 'course' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "courses_conversation_scope_check" CHECK("__new_courses"."conversation_scope" in ('course', 'course_surface'))
);
--> statement-breakpoint
INSERT INTO `__new_courses`("id", "organization_id", "project_id", "title", "file_prefix", "enabled", "admins_role", "students_role", "prompt_id", "instructions", "model", "vector_store_id", "max_requests_per_day", "created_at") SELECT "id", "organization_id", "project_id", "title", "file_prefix", "enabled", "admins_role", "students_role", "prompt_id", "instructions", "model", "vector_store_id", "max_requests_per_day", "created_at" FROM `courses`;--> statement-breakpoint
DROP TABLE `courses`;--> statement-breakpoint
ALTER TABLE `__new_courses` RENAME TO `courses`;--> statement-breakpoint
PRAGMA foreign_keys=ON;