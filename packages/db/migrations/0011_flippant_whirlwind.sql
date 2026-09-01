CREATE TABLE `person_link_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`person_id` text NOT NULL,
	`surface` text NOT NULL,
	`secret_hash` text NOT NULL,
	`code_verifier` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "person_link_challenges_surface_check" CHECK("person_link_challenges"."surface" in ('discord', 'mcp'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `person_link_challenges_secret_hash_unique` ON `person_link_challenges` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `person_link_challenges_person_id_idx` ON `person_link_challenges` (`person_id`);--> statement-breakpoint
ALTER TABLE `people` ADD `connected_at` integer;--> statement-breakpoint
ALTER TABLE `people` ADD `merged_into_person_id` text REFERENCES people(id);--> statement-breakpoint
ALTER TABLE `people` ADD `merged_at` integer;