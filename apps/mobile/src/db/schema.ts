import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export const accountTypes = ['bank', 'credit_card', 'wallet', 'upi_lite', 'cash'] as const;
export const transactionDirections = ['debit', 'credit'] as const;
export const transactionKinds = [
  'expense',
  'income',
  'transfer',
  'refund',
  'reversal',
  'cash_withdrawal',
] as const;
export const transactionStatuses = ['posted', 'failed', 'pending'] as const;
export const transactionSources = ['sms', 'manual', 'ios_intent', 'paste'] as const;
export const categoryKinds = ['expense', 'income'] as const;

/** Public key identifier only. The fingerprint secret belongs in platform key storage. */
export const importKeyState = sqliteTable('import_key_state', {
  id: integer('id').primaryKey(),
  keyId: text('key_id').notNull(),
}, (table) => [check('import_key_singleton', sql`${table.id} = 1`)]);

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    institution: text('institution'),
    type: text('type', { enum: accountTypes }).notNull(),
    last4: text('last4'),
    isOwn: integer('is_own', { mode: 'boolean' }).notNull().default(true),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    check('accounts_type_check', sql`${table.type} in ('bank', 'credit_card', 'wallet', 'upi_lite', 'cash')`),
  ],
);

export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    icon: text('icon'),
    color: text('color'),
    parentId: text('parent_id').references((): AnySQLiteColumn => categories.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: categoryKinds }).notNull(),
    isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Rent, EMIs, subscriptions: the same every month, so pace views set it apart from flexible spend. */
    isFixed: integer('is_fixed', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    check('categories_kind_check', sql`${table.kind} in ('expense', 'income')`),
  ],
);

export const budgets = sqliteTable(
  'budgets',
  {
    id: text('id').primaryKey(),
    categoryId: text('category_id').notNull().references(() => categories.id),
    month: text('month').notNull(),
    amountPaise: integer('amount_paise').notNull(),
  },
  (table) => [
    check(
      'budgets_month_check',
      sql`length(${table.month}) = 7 and ${table.month} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]' and cast(substr(${table.month}, 6, 2) as integer) between 1 and 12`,
    ),
    check(
      'budgets_amount_paise_check',
      sql`typeof(${table.amountPaise}) = 'integer' and ${table.amountPaise} between 1 and 9007199254740991`,
    ),
    unique('budgets_category_month_unique').on(table.categoryId, table.month),
  ],
);

export const bills = sqliteTable(
  'bills',
  {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    amountPaise: integer('amount_paise').notNull(),
    dueDate: text('due_date').notNull(),
    paid: integer('paid', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    check('bills_label_check', sql`length(trim(${table.label})) > 0`),
    check(
      'bills_amount_paise_check',
      sql`typeof(${table.amountPaise}) = 'integer' and ${table.amountPaise} between 1 and 9007199254740991`,
    ),
    check(
      'bills_due_date_check',
      sql`length(${table.dueDate}) = 10 and ${table.dueDate} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
    check('bills_paid_check', sql`typeof(${table.paid}) = 'integer' and ${table.paid} in (0, 1)`),
  ],
);

export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    amountPaise: integer('amount_paise').notNull(),
    direction: text('direction', { enum: transactionDirections }).notNull(),
    kind: text('kind', { enum: transactionKinds }).notNull(),
    status: text('status', { enum: transactionStatuses }).notNull().default('posted'),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    counterparty: text('counterparty'),
    merchantId: text('merchant_id'),
    categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    note: text('note'),
    source: text('source', { enum: transactionSources }).notNull(),
    smsRefId: text('sms_ref_id'),
    upiRef: text('upi_ref'),
    dedupeKey: text('dedupe_key'),
    bodyHash: text('body_hash'),
    ruleId: text('rule_id'),
    ruleVersion: integer('rule_version'),
    linkedTxnId: text('linked_txn_id').references((): AnySQLiteColumn => transactions.id, { onDelete: 'set null' }),
    excludeFromStats: integer('exclude_from_stats', { mode: 'boolean' }).notNull().default(false),
    userEdited: integer('user_edited', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    check(
      'transactions_amount_paise_check',
      sql`typeof(${table.amountPaise}) = 'integer' and ${table.amountPaise} between 1 and 9007199254740991`,
    ),
    check('transactions_direction_check', sql`${table.direction} in ('debit', 'credit')`),
    check(
      'transactions_kind_check',
      sql`${table.kind} in ('expense', 'income', 'transfer', 'refund', 'reversal', 'cash_withdrawal')`,
    ),
    check('transactions_status_check', sql`${table.status} in ('posted', 'failed', 'pending')`),
    check('transactions_source_check', sql`${table.source} in ('sms', 'manual', 'ios_intent', 'paste')`),
    check('transactions_occurred_at_check', sql`typeof(${table.occurredAt}) = 'integer'`),
    check('transactions_created_at_check', sql`typeof(${table.createdAt}) = 'integer'`),
    check('transactions_updated_at_check', sql`typeof(${table.updatedAt}) = 'integer'`),
    check(
      'transactions_deleted_at_check',
      sql`${table.deletedAt} is null or typeof(${table.deletedAt}) = 'integer'`,
    ),
  ],
);

export const themePreferences = ['system', 'light', 'dark'] as const;

/** Small app settings as key/value text; the ledger file stays the one place app state lives. */
export const preferences = sqliteTable('preferences', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
