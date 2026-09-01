CREATE TABLE `discord_install_states` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`account_id` text NOT NULL,
	`state_hash` text NOT NULL,
	`code_verifier` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discord_install_states_state_hash_unique` ON `discord_install_states` (`state_hash`);--> statement-breakpoint
CREATE INDEX `discord_install_states_account_id_idx` ON `discord_install_states` (`account_id`);