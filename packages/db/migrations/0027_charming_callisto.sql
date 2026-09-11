CREATE TABLE `mcp_oauth_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`account_id` text NOT NULL,
	`scope` text,
	`resource` text,
	`refresh_token_id` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `mcp_oauth_clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`refresh_token_id`) REFERENCES `mcp_oauth_refresh_tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_oauth_access_tokens_token_hash_unique` ON `mcp_oauth_access_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `mcp_oauth_authorization_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`code_challenge` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`scope` text,
	`resource` text,
	`account_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `mcp_oauth_clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_oauth_authorization_codes_code_hash_unique` ON `mcp_oauth_authorization_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `mcp_oauth_authorization_codes_client_id_idx` ON `mcp_oauth_authorization_codes` (`client_id`);--> statement-breakpoint
CREATE TABLE `mcp_oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`redirect_uris` text NOT NULL,
	`client_name` text,
	`scope` text,
	`grant_types` text,
	`token_endpoint_auth_method` text DEFAULT 'none' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_oauth_pending_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`state` text,
	`scope` text,
	`resource` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `mcp_oauth_clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mcp_oauth_pending_authorizations_client_id_idx` ON `mcp_oauth_pending_authorizations` (`client_id`);--> statement-breakpoint
CREATE TABLE `mcp_oauth_refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`account_id` text NOT NULL,
	`scope` text,
	`resource` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `mcp_oauth_clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_oauth_refresh_tokens_token_hash_unique` ON `mcp_oauth_refresh_tokens` (`token_hash`);