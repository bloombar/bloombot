PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_courses` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`enabled` integer NOT NULL,
	`admins_role` text,
	`students_role` text,
	`prompt_id` text,
	`instructions` text,
	`model` text,
	`vector_store_id` text,
	`max_requests_per_day` integer,
	`conversation_scope` text DEFAULT 'course' NOT NULL,
	`discord_server_id` text,
	`self_enrol_from_discord` integer DEFAULT false NOT NULL,
	`answer_unenrolled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`discord_server_id`) REFERENCES `discord_server_bindings`(`server_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "courses_conversation_scope_check" CHECK("__new_courses"."conversation_scope" in ('course', 'course_surface'))
);
--> statement-breakpoint
INSERT INTO `__new_courses`("id", "organization_id", "project_id", "title", "enabled", "admins_role", "students_role", "prompt_id", "instructions", "model", "vector_store_id", "max_requests_per_day", "conversation_scope", "discord_server_id", "self_enrol_from_discord", "answer_unenrolled", "created_at") SELECT "id", "organization_id", "project_id", "title", "enabled", "admins_role", "students_role", "prompt_id", "instructions", "model", "vector_store_id", "max_requests_per_day", "conversation_scope", "discord_server_id", "self_enrol_from_discord", "answer_unenrolled", "created_at" FROM `courses`;--> statement-breakpoint
DROP TABLE `courses`;--> statement-breakpoint
ALTER TABLE `__new_courses` RENAME TO `courses`;--> statement-breakpoint
PRAGMA foreign_keys=ON;