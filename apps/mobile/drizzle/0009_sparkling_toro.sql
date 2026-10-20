CREATE TABLE `account_balance_checkpoints` (
	`account_id` text PRIMARY KEY NOT NULL,
	`account_type` text NOT NULL,
	`balance_paise` integer NOT NULL,
	`as_of` integer NOT NULL,
	`confirmed_at` integer NOT NULL,
	`reconciliation_delta_paise` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "balance_checkpoint_type_check" CHECK("account_balance_checkpoints"."account_type" in ('bank', 'credit_card', 'wallet', 'upi_lite', 'cash')),
	CONSTRAINT "balance_checkpoint_money_check" CHECK(typeof("account_balance_checkpoints"."balance_paise") = 'integer' and "account_balance_checkpoints"."balance_paise" between -9007199254740991 and 9007199254740991),
	CONSTRAINT "balance_checkpoint_delta_check" CHECK("account_balance_checkpoints"."reconciliation_delta_paise" is null or (typeof("account_balance_checkpoints"."reconciliation_delta_paise") = 'integer' and "account_balance_checkpoints"."reconciliation_delta_paise" between -9007199254740991 and 9007199254740991)),
	CONSTRAINT "balance_checkpoint_date_check" CHECK(typeof("account_balance_checkpoints"."as_of") = 'integer' and "account_balance_checkpoints"."as_of" between -8640000000000000 and 8640000000000000 and typeof("account_balance_checkpoints"."confirmed_at") = 'integer' and "account_balance_checkpoints"."confirmed_at" between "account_balance_checkpoints"."as_of" and 8640000000000000)
);
--> statement-breakpoint
CREATE TABLE `recurring_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`day_of_month` integer NOT NULL,
	`kind` text NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	CONSTRAINT "recurring_schedules_label_check" CHECK(length(trim("recurring_schedules"."label")) > 0),
	CONSTRAINT "recurring_schedules_amount_check" CHECK(typeof("recurring_schedules"."amount_paise") = 'integer' and "recurring_schedules"."amount_paise" between 1 and 9007199254740991),
	CONSTRAINT "recurring_schedules_day_check" CHECK(typeof("recurring_schedules"."day_of_month") = 'integer' and "recurring_schedules"."day_of_month" between 1 and 31),
	CONSTRAINT "recurring_schedules_kind_check" CHECK("recurring_schedules"."kind" in ('bill', 'card_payment')),
	CONSTRAINT "recurring_schedules_paused_check" CHECK(typeof("recurring_schedules"."paused") = 'integer' and "recurring_schedules"."paused" in (0, 1))
);
