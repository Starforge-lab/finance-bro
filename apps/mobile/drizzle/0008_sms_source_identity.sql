CREATE TABLE `__new_sms_import_refs` (
	`reference_id` text PRIMARY KEY NOT NULL,
	`platform_id` text NOT NULL,
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
	CONSTRAINT "sms_import_refs_status_check" CHECK("__new_sms_import_refs"."status" in ('review', 'saved', 'duplicate')),
	CONSTRAINT "sms_import_refs_received_at_check" CHECK(typeof("__new_sms_import_refs"."received_at") = 'integer'),
	CONSTRAINT "sms_import_refs_created_at_check" CHECK(typeof("__new_sms_import_refs"."created_at") = 'integer'),
	CONSTRAINT "sms_import_refs_rule_pair" CHECK(("__new_sms_import_refs"."rule_id" is null and "__new_sms_import_refs"."rule_version" is null) or ("__new_sms_import_refs"."rule_id" is not null and "__new_sms_import_refs"."rule_version" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_sms_import_refs`("reference_id", "platform_id", "received_at", "sender_hash", "dedupe_key", "body_hash", "key_id", "status", "reason", "rule_id", "rule_version", "transaction_id", "created_at") SELECT 'legacy:' || "platform_id", "platform_id", "received_at", "sender_hash", "dedupe_key", "body_hash", "key_id", "status", "reason", "rule_id", "rule_version", "transaction_id", "created_at" FROM `sms_import_refs`;--> statement-breakpoint
DROP TABLE `sms_import_refs`;--> statement-breakpoint
ALTER TABLE `__new_sms_import_refs` RENAME TO `sms_import_refs`;--> statement-breakpoint
CREATE INDEX `sms_import_refs_dedupe_key_idx` ON `sms_import_refs` (`dedupe_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `sms_import_refs_source_unique` ON `sms_import_refs` (`platform_id`,`received_at`,`body_hash`);
