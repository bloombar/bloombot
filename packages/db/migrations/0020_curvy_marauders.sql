ALTER TABLE `course_join_links` ADD `secret_ciphertext` text;--> statement-breakpoint
ALTER TABLE `course_join_links` ADD `secret_nonce` text;--> statement-breakpoint
ALTER TABLE `course_join_links` ADD `secret_auth_tag` text;