CREATE TABLE `discord_gateway_status` (
	`id` text PRIMARY KEY NOT NULL,
	`last_known_connected_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `discord_handled_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`handled_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `discord_handled_messages_handled_at_idx` ON `discord_handled_messages` (`handled_at`);