CREATE TABLE `sms_import_refs` (
	`platform_id` text PRIMARY KEY NOT NULL,
	`received_at` integer NOT NULL,
	`sender_hash` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`body_hash` text NOT NULL,
	`key_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`rule_id` text,
	`rule_version` integer,
	`transaction_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sms_import_refs_status_check" CHECK("sms_import_refs"."status" in ('review', 'saved', 'duplicate')),
	CONSTRAINT "sms_import_refs_received_at_check" CHECK(typeof("sms_import_refs"."received_at") = 'integer'),
	CONSTRAINT "sms_import_refs_created_at_check" CHECK(typeof("sms_import_refs"."created_at") = 'integer'),
	CONSTRAINT "sms_import_refs_rule_pair" CHECK(("sms_import_refs"."rule_id" is null and "sms_import_refs"."rule_version" is null) or ("sms_import_refs"."rule_id" is not null and "sms_import_refs"."rule_version" is not null))
);
--> statement-breakpoint
CREATE TABLE `sms_import_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`cursor_received_at` integer,
	`cursor_platform_id` text,
	`key_id` text NOT NULL,
	CONSTRAINT "sms_import_state_singleton" CHECK("sms_import_state"."id" = 1),
	CONSTRAINT "sms_import_state_cursor_pair" CHECK(("sms_import_state"."cursor_received_at" is null and "sms_import_state"."cursor_platform_id" is null) or ("sms_import_state"."cursor_received_at" is not null and "sms_import_state"."cursor_platform_id" is not null))
);
