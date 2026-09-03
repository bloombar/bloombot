CREATE TABLE `membership_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`secret_hash` text NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`redeemed_at` integer,
	`redeemed_by_account_id` text,
	`created_by_account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`redeemed_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "membership_invitations_role_check" CHECK("membership_invitations"."role" in ('owner', 'instructor', 'assistant'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `membership_invitations_secret_hash_unique` ON `membership_invitations` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `membership_invitations_organization_id_idx` ON `membership_invitations` (`organization_id`);