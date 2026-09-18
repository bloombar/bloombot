DROP INDEX `accounts_email_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_email_active_unique` ON `accounts` (`email`) WHERE "accounts"."deleted_at" is null;--> statement-breakpoint
DROP INDEX `conversations_org_course_person_unscoped_unique`;--> statement-breakpoint
DROP INDEX `conversations_org_course_person_surface_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_org_course_person_unscoped_unique` ON `conversations` (`organization_id`,`course_id`,`person_id`) WHERE "conversations"."surface" is null and "conversations"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_org_course_person_surface_unique` ON `conversations` (`organization_id`,`course_id`,`person_id`,`surface`) WHERE "conversations"."surface" is not null and "conversations"."deleted_at" is null;--> statement-breakpoint
DROP INDEX `projects_org_name_active_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_org_name_active_unique` ON `projects` (`organization_id`,`name`) WHERE "projects"."archived_at" is null and "projects"."deleted_at" is null;