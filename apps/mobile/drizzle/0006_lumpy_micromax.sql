CREATE INDEX `sms_import_refs_dedupe_key_idx` ON `sms_import_refs` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `transactions_dedupe_key_idx` ON `transactions` (`dedupe_key`);