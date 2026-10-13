import { and, eq, isNull, notExists, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  accountTypes,
  accounts,
  budgets,
  categoryKinds,
  categories,
  transactionDirections,
  transactionKinds,
  transactionSources,
  transactionStatuses,
  transactions,
} from './schema';

export type LedgerMigrations = {
  journal: {
    entries: { idx: number; when: number; tag: string; breakpoints: boolean }[];
  };
  migrations: Record<string, string>;
};

export type LedgerSQLiteClient = Pick<
  SQLiteDatabase,
  'execAsync' | 'getFirstAsync' | 'withTransactionAsync' | 'prepareAsync'
>;

type TransactionInsert = typeof transactions.$inferInsert;
type TransactionRow = typeof transactions.$inferSelect;
type AccountInsert = typeof accounts.$inferInsert;
type CategoryInsert = typeof categories.$inferInsert;

export type NewAccount = Pick<AccountInsert, 'id' | 'name' | 'type'> & Partial<Pick<AccountInsert, 'institution' | 'last4' | 'isOwn'>>;
export type AccountPatch = Partial<Pick<AccountInsert, 'name' | 'institution' | 'type' | 'last4' | 'isOwn'>>;
export type NewCategory = Pick<CategoryInsert, 'id' | 'name' | 'kind'> & Partial<Pick<CategoryInsert, 'icon' | 'color' | 'sortOrder' | 'isFixed'>>;
export type CategoryPatch = Partial<Pick<CategoryInsert, 'name' | 'icon' | 'color' | 'kind' | 'sortOrder' | 'isFixed'>>;

export type ReviewedPasteTransaction = Pick<
  TransactionRow,
  | 'id'
  | 'amountPaise'
  | 'direction'
  | 'kind'
  | 'status'
  | 'occurredAt'
  | 'dedupeKey'
  | 'bodyHash'
  | 'ruleId'
  | 'ruleVersion'
> & Partial<Pick<
  TransactionRow,
  | 'accountId'
  | 'counterparty'
  | 'merchantId'
  | 'categoryId'
  | 'note'
  | 'upiRef'
  | 'linkedTxnId'
  | 'excludeFromStats'
>>;
export type NewTransaction = Omit<
  TransactionInsert,
  | 'createdAt'
  | 'updatedAt'
  | 'deletedAt'
  | 'userEdited'
  | 'source'
> & Partial<Pick<TransactionInsert, 'createdAt' | 'updatedAt'>> & { source: 'manual' };
export type ImportedTransaction = Omit<
  TransactionInsert,
  'createdAt' | 'updatedAt' | 'deletedAt' | 'userEdited' | 'source'
> & {
  source: Exclude<TransactionInsert['source'], 'manual'>;
};
export type TransactionPatch = Partial<
  Pick<
    TransactionInsert,
    | 'amountPaise'
    | 'direction'
    | 'kind'
    | 'status'
    | 'accountId'
    | 'counterparty'
    | 'merchantId'
    | 'categoryId'
    | 'occurredAt'
    | 'note'
    | 'upiRef'
    | 'linkedTxnId'
    | 'excludeFromStats'
  >
>;

export function assertValidAmountPaise(amountPaise: number): void {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new RangeError('amountPaise must be a positive safe integer');
  }
}

function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertId(value: unknown, name = 'id'): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertText(value: unknown, name: string, options: { nullable?: boolean; optional?: boolean; nonEmpty?: boolean } = {}): void {
  if (options.optional && value === undefined) return;
  if (options.nullable && value === null) return;
  if (typeof value !== 'string' || (options.nonEmpty && value.trim().length === 0)) {
    throw new TypeError(`${name} must be ${options.nullable ? 'a string or null' : 'a string'}${options.nonEmpty ? ' and non-empty' : ''}`);
  }
}

function assertEnum<const T extends readonly string[]>(value: unknown, values: T, name: string, optional = false): void {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new TypeError(`${name} is invalid`);
  }
}

function assertBoolean(value: unknown, name: string, optional = false): void {
  if (optional && value === undefined) return;
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
}

function assertSafeInteger(value: unknown, name: string, optional = false): void {
  if (optional && value === undefined) return;
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
}

function assertValidDate(value: unknown, name: string, optional = false): void {
  if (optional && value === undefined) return;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
}

function assertValidTextFields(input: Record<string, unknown>): void {
  for (const key of ['counterparty', 'note', 'upiRef']) assertText(input[key], key, { nullable: true, optional: true });
  for (const key of ['accountId', 'merchantId', 'categoryId', 'linkedTxnId']) {
    if (input[key] !== undefined && input[key] !== null) assertId(input[key], key);
  }
  assertBoolean(input.excludeFromStats, 'excludeFromStats', true);
}

function assertValidProvenance(input: Record<string, unknown>): void {
  assertText(input.smsRefId, 'smsRefId', { nullable: true, optional: true, nonEmpty: true });
  assertText(input.dedupeKey, 'dedupeKey', { nullable: true, optional: true, nonEmpty: true });
  assertText(input.bodyHash, 'bodyHash', { nullable: true, optional: true, nonEmpty: true });
  assertText(input.ruleId, 'ruleId', { nullable: true, optional: true, nonEmpty: true });
  const ruleAbsent = input.ruleId === undefined || input.ruleId === null;
  const versionAbsent = input.ruleVersion === undefined || input.ruleVersion === null;
  if (ruleAbsent !== versionAbsent) throw new TypeError('ruleId and ruleVersion must both be null or set');
  if (!versionAbsent && (!Number.isSafeInteger(input.ruleVersion) || (input.ruleVersion as number) <= 0)) {
    throw new TypeError('ruleVersion must be a positive safe integer or null');
  }
  if ((input.dedupeKey == null) !== (input.bodyHash == null)) {
    throw new TypeError('dedupeKey and bodyHash must both be null or set');
  }
}

function assertValidTransactionValues(
  input: Record<string, unknown>,
  { imported = false, statusOptional = false }: { imported?: boolean; statusOptional?: boolean } = {},
): void {
  assertId(input.id);
  if (typeof input.amountPaise !== 'number') throw new TypeError('amountPaise must be a positive safe integer');
  assertValidAmountPaise(input.amountPaise);
  assertValidDate(input.occurredAt, 'occurredAt');
  assertEnum(input.direction, transactionDirections, 'direction');
  assertEnum(input.kind, transactionKinds, 'kind');
  assertEnum(input.status, transactionStatuses, 'status', statusOptional);
  assertValidTextFields(input);
  if (imported) {
    assertEnum(input.source, transactionSources, 'source');
    if (input.source === 'manual') throw new TypeError('Imported transactions cannot use the manual source');
    assertValidProvenance(input);
    assertText(input.dedupeKey, 'dedupeKey', { nonEmpty: true });
    assertText(input.bodyHash, 'bodyHash', { nonEmpty: true });
    if ((input.source === 'sms' || input.source === 'ios_intent') && (input.ruleId == null || input.ruleVersion == null)) {
      throw new TypeError(`${input.source} transactions require rule provenance`);
    }
    if (input.source === 'sms') assertText(input.smsRefId, 'smsRefId', { nonEmpty: true });
  }
}

function assertValidReviewedPaste(input: ReviewedPasteTransaction): void {
  assertRecord(input, 'transaction');
  assertValidTransactionValues(input);
  assertValidProvenance(input);
  assertText(input.dedupeKey, 'dedupeKey', { nonEmpty: true });
  assertText(input.bodyHash, 'bodyHash', { nonEmpty: true });
}

function assertValidAccount(input: unknown): asserts input is NewAccount {
  assertRecord(input, 'account');
  assertId(input.id);
  assertText(input.name, 'name', { nonEmpty: true });
  assertEnum(input.type, accountTypes, 'type');
  assertText(input.institution, 'institution', { nullable: true, optional: true });
  assertText(input.last4, 'last4', { nullable: true, optional: true });
  assertBoolean(input.isOwn, 'isOwn', true);
}

function assertValidCategory(input: unknown): asserts input is NewCategory {
  assertRecord(input, 'category');
  assertId(input.id);
  assertText(input.name, 'name', { nonEmpty: true });
  assertEnum(input.kind, categoryKinds, 'kind');
  assertText(input.icon, 'icon', { nullable: true, optional: true });
  assertText(input.color, 'color', { nullable: true, optional: true });
  assertSafeInteger(input.sortOrder, 'sortOrder', true);
  assertBoolean(input.isFixed, 'isFixed', true);
}

export async function migrateLedger(client: LedgerSQLiteClient, migrations: LedgerMigrations): Promise<void> {
  const entries = migrations.journal.entries;
  if (entries.some((entry, index) => entry.idx !== index)) {
    throw new Error('Ledger migration journal must have contiguous indexes starting at 0');
  }

  for (const entry of entries) {
    if (!migrations.migrations[`m${String(entry.idx).padStart(4, '0')}`]) {
      throw new Error(`Missing ledger migration: ${entry.tag}`);
    }
  }

  await client.execAsync('PRAGMA foreign_keys = ON');
  const latestVersion = entries.length;
  const currentVersion = (await client.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
  if (!Number.isInteger(currentVersion) || currentVersion < 0 || currentVersion > latestVersion) {
    throw new Error(`Database schema version ${currentVersion} is newer than this app supports (${latestVersion})`);
  }
  if (currentVersion === latestVersion) return;

  await client.withTransactionAsync(async () => {
    const version = (await client.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
    if (!Number.isInteger(version) || version < 0 || version > latestVersion) {
      throw new Error(`Database schema version ${version} is newer than this app supports (${latestVersion})`);
    }

    for (const entry of entries.slice(version)) {
      const migration = migrations.migrations[`m${String(entry.idx).padStart(4, '0')}`];
      if (!migration) throw new Error(`Missing ledger migration: ${entry.tag}`);
      for (const statement of migration.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) {
        await client.execAsync(statement);
      }
      await client.execAsync(`PRAGMA user_version = ${entry.idx + 1}`);
    }
  });
}

export function createLedger(client: LedgerSQLiteClient, migrations: LedgerMigrations) {
  const db = drizzle(async (query, params, method) => {
    const statement = await client.prepareAsync(query);
    try {
      const rows = await (await statement.executeForRawResultAsync(params)).getAllAsync();
      return { rows: method === 'get' ? rows[0] : rows };
    } finally {
      await statement.finalizeAsync();
    }
  }, { schema: { accounts, budgets, categories, transactions } });
  const now = () => new Date();

  async function assertTransactionReferences(input: Record<string, unknown>): Promise<void> {
    if (typeof input.accountId === 'string' && !await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, input.accountId)).get()) {
      throw new RangeError('accountId must refer to an existing account');
    }
    if (typeof input.categoryId === 'string' && !await db.select({ id: categories.id }).from(categories).where(eq(categories.id, input.categoryId)).get()) {
      throw new RangeError('categoryId must refer to an existing category');
    }
    if (typeof input.linkedTxnId === 'string' && !await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.id, input.linkedTxnId)).get()) {
      throw new RangeError('linkedTxnId must refer to an existing transaction');
    }
  }

  async function assertTransactionSemantics(input: Record<string, unknown>): Promise<void> {
    if (input.kind === 'expense' && input.direction !== 'debit') throw new TypeError('Expense transactions must be debits');
    if (input.kind === 'income' && input.direction !== 'credit') throw new TypeError('Income transactions must be credits');

    const requiredCategoryKind = input.kind === 'expense' ||
      ((input.kind === 'refund' || input.kind === 'reversal') && input.direction === 'credit')
      ? 'expense'
      : input.kind === 'income' ? 'income' : undefined;
    if (requiredCategoryKind && typeof input.categoryId === 'string') {
      const category = await db.select({ kind: categories.kind }).from(categories)
        .where(eq(categories.id, input.categoryId)).get();
      if (category?.kind !== requiredCategoryKind) {
        throw new RangeError(`${input.kind} transactions require a ${requiredCategoryKind} category`);
      }
    }
  }

  return {
    db,
    migrateLedger: () => migrateLedger(client, migrations),
    async createAccount(input: NewAccount): Promise<void> {
      assertValidAccount(input);
      await db.insert(accounts).values({
        id: input.id,
        name: input.name.trim(),
        type: input.type,
        institution: input.institution,
        last4: input.last4,
        isOwn: input.isOwn,
      }).run();
    },
    async listAccounts(includeArchived = false) {
      assertBoolean(includeArchived, 'includeArchived');
      const query = db.select().from(accounts);
      return (includeArchived ? query : query.where(eq(accounts.archived, false)))
        .orderBy(accounts.name, accounts.id).all();
    },
    async updateAccount(id: string, patch: AccountPatch): Promise<boolean> {
      assertId(id);
      assertRecord(patch, 'patch');
      if (patch.name !== undefined) assertText(patch.name, 'name', { nonEmpty: true });
      if (patch.type !== undefined) assertEnum(patch.type, accountTypes, 'type');
      if (patch.institution !== undefined) assertText(patch.institution, 'institution', { nullable: true });
      if (patch.last4 !== undefined) assertText(patch.last4, 'last4', { nullable: true });
      if (patch.isOwn !== undefined) assertBoolean(patch.isOwn, 'isOwn');
      const changes = Object.fromEntries(Object.entries({
        name: patch.name?.trim(),
        institution: patch.institution,
        type: patch.type,
        last4: patch.last4,
        isOwn: patch.isOwn,
      }).filter(([, value]) => value !== undefined)) as AccountPatch;
      if (Object.keys(changes).length === 0) return false;
      return db.update(accounts).set(changes).where(eq(accounts.id, id))
        .returning({ id: accounts.id }).all().then((rows) => rows.length > 0);
    },
    async archiveAccount(id: string): Promise<boolean> {
      assertId(id);
      return db.update(accounts).set({ archived: true }).where(eq(accounts.id, id))
        .returning({ id: accounts.id }).all().then((rows) => rows.length > 0);
    },
    async createCategory(input: NewCategory): Promise<void> {
      assertValidCategory(input);
      await db.insert(categories).values({
        id: input.id,
        name: input.name.trim(),
        kind: input.kind,
        icon: input.icon,
        color: input.color,
        sortOrder: input.sortOrder,
        isFixed: input.isFixed,
      }).run();
    },
    async listCategories(kind?: typeof categoryKinds[number]) {
      if (kind !== undefined) assertEnum(kind, categoryKinds, 'kind');
      const query = db.select().from(categories);
      return (kind === undefined ? query : query.where(eq(categories.kind, kind)))
        .orderBy(categories.sortOrder, categories.name, categories.id).all();
    },
    async updateCategory(id: string, patch: CategoryPatch): Promise<boolean> {
      assertId(id);
      assertRecord(patch, 'patch');
      if (patch.name !== undefined) assertText(patch.name, 'name', { nonEmpty: true });
      if (patch.kind !== undefined) assertEnum(patch.kind, categoryKinds, 'kind');
      if (patch.icon !== undefined) assertText(patch.icon, 'icon', { nullable: true });
      if (patch.color !== undefined) assertText(patch.color, 'color', { nullable: true });
      if (patch.sortOrder !== undefined) assertSafeInteger(patch.sortOrder, 'sortOrder');
      assertBoolean(patch.isFixed, 'isFixed', true);
      const changes = Object.fromEntries(Object.entries({
        name: patch.name?.trim(),
        kind: patch.kind,
        icon: patch.icon,
        color: patch.color,
        sortOrder: patch.sortOrder,
        isFixed: patch.isFixed,
      }).filter(([, value]) => value !== undefined)) as CategoryPatch;
      if (Object.keys(changes).length === 0) return false;
      if (patch.kind !== undefined) {
        const existing = await db.select({ kind: categories.kind }).from(categories).where(eq(categories.id, id)).get();
        if (!existing) return false;
        if (existing.kind !== patch.kind && await db.select({ id: transactions.id }).from(transactions)
          .where(eq(transactions.categoryId, id)).get()) {
          throw new RangeError('Cannot change the kind of a category used by transactions');
        }
      }
      return db.update(categories).set(changes).where(eq(categories.id, id))
        .returning({ id: categories.id }).all().then((rows) => rows.length > 0);
    },
    async deleteCategory(id: string): Promise<boolean> {
      assertId(id);
      const deleted = await db.delete(categories).where(and(
        eq(categories.id, id),
        eq(categories.isSystem, false),
        notExists(db.select({ id: transactions.id }).from(transactions).where(eq(transactions.categoryId, id))),
        notExists(db.select({ id: budgets.id }).from(budgets).where(eq(budgets.categoryId, id))),
        notExists(db.select({ id: categories.id }).from(categories).where(eq(categories.parentId, id))),
      )).returning({ id: categories.id }).all();
      if (deleted.length > 0) return true;
      const category = await db.select({ isSystem: categories.isSystem }).from(categories).where(eq(categories.id, id)).get();
      if (!category) return false;
      if (category.isSystem) throw new RangeError('System categories cannot be deleted');
      throw new RangeError('Category is still referenced');
    },
    async createTransaction(input: NewTransaction): Promise<void> {
      assertRecord(input, 'transaction');
      if (input.source !== 'manual') throw new TypeError('createTransaction only accepts manual transactions');
      assertValidTransactionValues(input, { statusOptional: true });
      assertValidDate(input.createdAt, 'createdAt', true);
      assertValidDate(input.updatedAt, 'updatedAt', true);
      await assertTransactionReferences(input);
      await assertTransactionSemantics(input);
      const createdAt = input.createdAt ?? now();
      const updatedAt = input.updatedAt ?? createdAt;
      await db.insert(transactions).values({
        id: input.id,
        amountPaise: input.amountPaise,
        direction: input.direction,
        kind: input.kind,
        status: input.status,
        accountId: input.accountId,
        counterparty: input.counterparty,
        merchantId: input.merchantId,
        categoryId: input.categoryId,
        occurredAt: input.occurredAt,
        note: input.note,
        source: 'manual',
        upiRef: input.upiRef,
        linkedTxnId: input.linkedTxnId,
        excludeFromStats: input.excludeFromStats,
        createdAt,
        updatedAt,
        deletedAt: null,
        userEdited: true,
      }).run();
    },
    async editTransaction(id: string, patch: TransactionPatch): Promise<boolean> {
      assertId(id);
      assertRecord(patch, 'patch');
      if (patch.amountPaise !== undefined) assertValidAmountPaise(patch.amountPaise);
      if (patch.direction !== undefined) assertEnum(patch.direction, transactionDirections, 'direction');
      if (patch.kind !== undefined) assertEnum(patch.kind, transactionKinds, 'kind');
      if (patch.status !== undefined) assertEnum(patch.status, transactionStatuses, 'status');
      if (patch.occurredAt !== undefined) assertValidDate(patch.occurredAt, 'occurredAt');
      const values = patch as Record<string, unknown>;
      assertValidTextFields(values);
      await assertTransactionReferences(values);
      const changes = Object.fromEntries(Object.entries({
        amountPaise: patch.amountPaise,
        direction: patch.direction,
        kind: patch.kind,
        status: patch.status,
        accountId: patch.accountId,
        counterparty: patch.counterparty,
        merchantId: patch.merchantId,
        categoryId: patch.categoryId,
        occurredAt: patch.occurredAt,
        note: patch.note,
        upiRef: patch.upiRef,
        linkedTxnId: patch.linkedTxnId,
        excludeFromStats: patch.excludeFromStats,
      }).filter(([, value]) => value !== undefined)) as TransactionPatch;
      if (Object.keys(changes).length === 0) return false;
      const existing = await db.select({
        direction: transactions.direction,
        kind: transactions.kind,
        categoryId: transactions.categoryId,
      }).from(transactions).where(and(eq(transactions.id, id), isNull(transactions.deletedAt))).get();
      if (!existing) return false;
      await assertTransactionSemantics({ ...existing, ...changes });
      return db.update(transactions)
        .set({ ...changes, userEdited: true, updatedAt: now() })
        .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)))
        .returning({ id: transactions.id }).all().then((rows) => rows.length > 0);
    },
    async softDeleteTransaction(id: string, deletedAt = now()): Promise<boolean> {
      assertId(id);
      assertValidDate(deletedAt, 'deletedAt');
      return db.update(transactions)
        .set({ deletedAt, updatedAt: deletedAt })
        .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)))
        .returning({ id: transactions.id }).all().then((rows) => rows.length > 0);
    },
    async findPasteCollision(id: string) {
      assertId(id);
      return db.select({ occurredAt: transactions.occurredAt, deletedAt: transactions.deletedAt })
        .from(transactions)
        .where(and(eq(transactions.id, id), eq(transactions.source, 'paste')))
        .get();
    },
    async upsertImportedTransaction(input: ImportedTransaction): Promise<boolean> {
      assertRecord(input, 'transaction');
      assertValidTransactionValues(input, { imported: true });
      await assertTransactionReferences(input);
      await assertTransactionSemantics(input);
      const createdAt = now();
      const updatedAt = createdAt;
      const updates = {
        amountPaise: input.amountPaise,
        direction: input.direction,
        kind: input.kind,
        status: input.status,
        accountId: input.accountId,
        counterparty: input.counterparty,
        merchantId: input.merchantId,
        categoryId: input.categoryId,
        occurredAt: input.occurredAt,
        note: input.note,
        source: input.source,
        smsRefId: input.smsRefId,
        upiRef: input.upiRef,
        dedupeKey: input.dedupeKey,
        bodyHash: input.bodyHash,
        ruleId: input.ruleId,
        ruleVersion: input.ruleVersion,
        linkedTxnId: input.linkedTxnId,
        excludeFromStats: input.excludeFromStats,
        updatedAt,
      };
      return db.insert(transactions)
        .values({ ...updates, id: input.id, createdAt, deletedAt: null, userEdited: false })
        .onConflictDoUpdate({
          target: transactions.id,
          set: updates,
          where: and(
            eq(transactions.userEdited, false),
            isNull(transactions.deletedAt),
            sql`${transactions.source} <> 'manual'`,
          ),
        })
        .returning({ id: transactions.id }).all().then((rows) => rows.length > 0);
    },
    async insertReviewedPaste(input: ReviewedPasteTransaction): Promise<boolean> {
      assertValidReviewedPaste(input);
      await assertTransactionReferences(input);
      await assertTransactionSemantics(input);
      const createdAt = now();
      return db.insert(transactions).values({
        id: input.id,
        amountPaise: input.amountPaise,
        direction: input.direction,
        kind: input.kind,
        status: input.status,
        accountId: input.accountId,
        counterparty: input.counterparty,
        merchantId: input.merchantId,
        categoryId: input.categoryId,
        occurredAt: input.occurredAt,
        note: input.note,
        source: 'paste',
        upiRef: input.upiRef,
        dedupeKey: input.dedupeKey,
        bodyHash: input.bodyHash,
        ruleId: input.ruleId,
        ruleVersion: input.ruleVersion,
        linkedTxnId: input.linkedTxnId,
        excludeFromStats: input.excludeFromStats ?? false,
        userEdited: true,
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
      }).onConflictDoNothing()
        .returning({ id: transactions.id }).all().then((rows) => rows.length > 0);
    },
  };
}

export type Ledger = ReturnType<typeof createLedger>;
