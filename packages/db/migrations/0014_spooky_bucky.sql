ALTER TABLE `enrolments` ADD `reinstated_by_account_id` text REFERENCES accounts(id);--> statement-breakpoint
ALTER TABLE `enrolments` ADD `reinstated_at` integer;