ALTER TABLE `memberships` ADD `revoked_by_account_id` text REFERENCES accounts(id);--> statement-breakpoint
ALTER TABLE `memberships` ADD `revoked_at` integer;