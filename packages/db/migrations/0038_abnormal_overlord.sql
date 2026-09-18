ALTER TABLE `accounts` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `deleted_by_account_id` text REFERENCES accounts(id);--> statement-breakpoint
ALTER TABLE `conversations` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `deleted_by_account_id` text REFERENCES accounts(id);--> statement-breakpoint
ALTER TABLE `courses` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `courses` ADD `deleted_by_account_id` text REFERENCES accounts(id);--> statement-breakpoint
ALTER TABLE `organizations` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `organizations` ADD `deleted_by_account_id` text REFERENCES accounts(id);--> statement-breakpoint
ALTER TABLE `people` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `people` ADD `deleted_by_account_id` text REFERENCES accounts(id);--> statement-breakpoint
ALTER TABLE `projects` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `deleted_by_account_id` text REFERENCES accounts(id);