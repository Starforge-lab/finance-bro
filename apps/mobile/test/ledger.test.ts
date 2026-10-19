/// <reference types="node" />

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { after, before, describe, it } from 'node:test';
import {
  createLedger,
  migrateLedger,
  type AccountPatch,
  type ImportedTransaction,
  type LedgerMigrations,
  type LedgerSQLiteClient,
  type NewAccount,
  type NewCategory,
  type NewTransaction,
  type ReviewedPasteTransaction,
  type TransactionPatch,
} from '../src/db/ledger';
import { accounts, budgets, categories, transactions } from '../src/db/schema';
import type { Fingerprinter } from '../src/imports/fingerprint';
import { preparePastedSms, saveReviewedPaste } from '../src/imports/paste';

const testFingerprinter: Fingerprinter = {
  keyId: 'a'.repeat(64),
  async fingerprint(value) {
    return createHmac('sha256', 'fictional-ledger-test-key').update(value).digest('hex');
  },
};

const migrationsDirectory = resolve(process.cwd(), 'drizzle');
const journal: LedgerMigrations['journal'] = JSON.parse(readFileSync(join(migrationsDirectory, 'meta/_journal.json'), 'utf8'));
const migrations: LedgerMigrations = {
  journal,
  migrations: Object.fromEntries(journal.entries.map((entry) => [
    `m${String(entry.idx).padStart(4, '0')}`,
    readFileSync(join(migrationsDirectory, `${entry.tag}.sql`), 'utf8'),
  ])),
};

function openLedger(filename: string) {
  const sqlite = new DatabaseSync(filename);
  const client = {
    execAsync: async (source: string) => { sqlite.exec(source); },
    getFirstAsync: async <T>(source: string, ...params: unknown[]) =>
      (sqlite.prepare(source).get(...params as never[]) as T | undefined) ?? null,
    withTransactionAsync: async (task: () => Promise<void>) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        await task();
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    prepareAsync: async (source: string) => {
      const statement = sqlite.prepare(source);
      return {
        executeForRawResultAsync: async (params: unknown[]) => {
          const names = statement.columns().map(({ name }) => name);
          const rows = statement.all(...params as never[]).map((row) => names.map((name) => row[name]));
          return { getAllAsync: async () => rows };
        },
        finalizeAsync: async () => {},
      };
    },
  } as unknown as LedgerSQLiteClient;

  return { sqlite, client, ledger: createLedger(client, migrations) };
}

function temporaryFile() {
  const directory = mkdtempSync(join(tmpdir(), 'finance-bro-ledger-'));
  return { directory, filename: join(directory, 'ledger.sqlite') };
}

function removeTemporaryFile(directory: string, filename: string) {
  rmSync(filename, { force: true });
  rmdirSync(directory);
}

function transaction(id: string, overrides: Partial<NewTransaction> = {}): NewTransaction {
  return {
    id,
    amountPaise: 45600,
    direction: 'debit',
    kind: 'expense',
    status: 'posted',
    source: 'manual',
    occurredAt: new Date('2026-10-06T12:00:00.000Z'),
    ...overrides,
  };
}

function importedTransaction(id: string, overrides: Partial<ImportedTransaction> = {}): ImportedTransaction {
  return { ...transaction(id), source: 'paste', dedupeKey: `dedupe:${id}`, bodyHash: `body:${id}`, ...overrides };
}

async function findTransaction(ledger: ReturnType<typeof createLedger>, id: string) {
  return ledger.db.select().from(transactions).where(eq(transactions.id, id)).get();
}

describe('ledger', () => {
  let directory: string;
  let filename: string;

  before(() => {
    ({ directory, filename } = temporaryFile());
  });

  after(() => removeTemporaryFile(directory, filename));

  it('prepares VPA failure words as posted while preserving explicit failures for review', async () => {
    for (const [suffix, status] of [['', 'posted'], ['. Transaction failed.', 'failed']] as const) {
      const raw = {
        sender: 'VM-HDFCBK-S',
        body: `Credit Alert! Rs.250.75 credited to HDFC Bank A/c XX1234 on 27-09-26 from VPA failed@examplebank (UPI 567890123456)${suffix}`,
        receivedAt: Date.parse('2026-09-27T10:00:00+05:30'),
      };
      const prepared = await preparePastedSms(raw, testFingerprinter);
      assert.equal(prepared.kind, 'needs-review');
      if (prepared.kind !== 'needs-review') throw new Error('Expected review');
      assert.equal(prepared.candidate?.status, status);
      assert.equal(prepared.ruleId, 'hdfc.upi.credit');
      assert.equal(prepared.ruleVersion, 2);
      assert.equal(JSON.stringify(prepared).includes(raw.body), false);
    }
  });

  it('keeps corrected and deleted legacy paste identities protected after a parser status change', async () => {
    const fixture = openLedger(':memory:');
    try {
      await fixture.ledger.migrateLedger();
      const raw = {
        sender: 'VM-HDFCBK-S',
        body: 'INR 250.75 credited to A/c XX1234 from VPA failed@examplebank (UPI Ref No 567890123456)',
        receivedAt: Date.parse('2026-09-27T10:00:00+05:30'),
      };
      const prepared = await preparePastedSms(raw, testFingerprinter);
      if (prepared.kind !== 'needs-review' || !prepared.candidate) throw new Error('Expected review candidate');
      assert.equal(prepared.candidate.upiRef, '567890123456');
      const legacyDedupeKey = `upi:${await testFingerprinter.fingerprint(JSON.stringify(['upi', '567890123456', 'credit', 'failed', 'income']))}`;
      const legacy = {
        ...prepared,
        candidate: { ...prepared.candidate, status: 'failed' as const },
        ruleVersion: 3,
        identity: { ...prepared.identity, id: `paste:${legacyDedupeKey}`, dedupeKey: legacyDedupeKey },
      };
      assert.notEqual(prepared.identity.id, legacy.identity.id);
      assert.equal(await saveReviewedPaste(fixture.ledger, legacy, { status: 'posted', amountPaise: 25100 }), 'inserted');
      assert.deepEqual(await Promise.all([
        saveReviewedPaste(fixture.ledger, prepared),
        saveReviewedPaste(fixture.ledger, prepared),
      ]), ['duplicate', 'duplicate']);
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 1);
      assert.equal((await findTransaction(fixture.ledger, legacy.identity.id))?.amountPaise, 25100);
      await fixture.ledger.softDeleteTransaction(legacy.identity.id);
      assert.equal(await saveReviewedPaste(fixture.ledger, prepared), 'duplicate');
      assert.ok((await findTransaction(fixture.ledger, legacy.identity.id))?.deletedAt);
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 1);
    } finally {
      fixture.sqlite.close();
    }
  });

  for (const deleted of [false, true]) {
    it(`preserves a weak-identity paste when a parser update adds its UPI reference (deleted=${deleted})`, async () => {
      const fixture = openLedger(':memory:');
      try {
        await fixture.ledger.migrateLedger();
        const raw = {
          sender: 'VM-HDFCBK-S',
          body: 'Credit Alert! Rs.250.75 credited to HDFC Bank A/c XX1234 on 27-09-26 from VPA payer@examplebank (UPI 123456789012)',
          receivedAt: Date.parse('2026-09-27T10:00:00+05:30'),
        };
        const prepared = await preparePastedSms(raw, testFingerprinter);
        if (prepared.kind !== 'needs-review' || !prepared.identity.dedupeKey.startsWith('upi:')) {
          throw new Error('Expected the current parser to extract a UPI reference');
        }
        const legacyWeakKey = `body:${await testFingerprinter.fingerprint(JSON.stringify([
          'sms', raw.sender.trim().toUpperCase(), raw.body,
        ]))}`;
        const legacy = {
          ...prepared,
          identity: { ...prepared.identity, id: `paste:${legacyWeakKey}`, dedupeKey: legacyWeakKey },
        };
        assert.equal(await saveReviewedPaste(fixture.ledger, legacy, { amountPaise: 24_999 }), 'inserted');
        if (deleted) await fixture.ledger.softDeleteTransaction(legacy.identity.id);

        assert.equal(await saveReviewedPaste(fixture.ledger, prepared), 'duplicate');
        const stored = await findTransaction(fixture.ledger, legacy.identity.id);
        assert.equal(stored?.amountPaise, 24_999);
        assert.equal(Boolean(stored?.deletedAt), deleted);
        assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 1);
      } finally {
        fixture.sqlite.close();
      }
    });
  }

  it('requires review for a body-identical weak paste from another sender', async () => {
    const fixture = openLedger(':memory:');
    try {
      await fixture.ledger.migrateLedger();
      const raw = {
        sender: 'VM-HDFCBK-S',
        body: 'Credit Alert! Rs.250.75 credited to HDFC Bank A/c XX1234 on 27-09-26 from VPA payer@examplebank (UPI 123456789012)',
        receivedAt: Date.parse('2026-09-27T10:00:00+05:30'),
      };
      const prepared = await preparePastedSms(raw, testFingerprinter);
      if (prepared.kind !== 'needs-review' || !prepared.identity.dedupeKey.startsWith('upi:')) {
        throw new Error('Expected the current parser to extract a UPI reference');
      }
      const otherSenderWeakKey = `body:${await testFingerprinter.fingerprint(JSON.stringify([
        'sms', 'AD-HDFCBK-S', raw.body,
      ]))}`;
      const legacy = {
        ...prepared,
        identity: {
          ...prepared.identity,
          id: `paste:${otherSenderWeakKey}`,
          dedupeKey: otherSenderWeakKey,
          weakDedupeKey: otherSenderWeakKey,
        },
      };
      assert.equal(await saveReviewedPaste(fixture.ledger, legacy), 'inserted');

      await assert.rejects(saveReviewedPaste(fixture.ledger, prepared), /weak-identity paste requires review/);
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 1);
      assert.ok(await findTransaction(fixture.ledger, legacy.identity.id));
    } finally {
      fixture.sqlite.close();
    }
  });

  it('requires review when a weak paste and a strong UPI transaction both match', async () => {
    const fixture = openLedger(':memory:');
    try {
      await fixture.ledger.migrateLedger();
      const raw = {
        sender: 'VM-HDFCBK-S',
        body: 'Credit Alert! Rs.250.75 credited to HDFC Bank A/c XX1234 on 27-09-26 from VPA payer@examplebank (UPI 123456789012)',
        receivedAt: Date.parse('2026-09-27T10:00:00+05:30'),
      };
      const prepared = await preparePastedSms(raw, testFingerprinter);
      if (prepared.kind !== 'needs-review' || !prepared.candidate?.upiRef || !prepared.ruleId || !prepared.ruleVersion) {
        throw new Error('Expected the current parser to extract a UPI reference');
      }
      const weakKey = `body:${await testFingerprinter.fingerprint(JSON.stringify([
        'sms', raw.sender.trim().toUpperCase(), raw.body,
      ]))}`;
      const legacy = {
        ...prepared,
        identity: { ...prepared.identity, id: `paste:${weakKey}`, dedupeKey: weakKey },
      };
      assert.equal(await saveReviewedPaste(fixture.ledger, legacy, { amountPaise: 24_999 }), 'inserted');
      await fixture.ledger.db.insert(transactions).values({
        id: 'sms:strong-match',
        amountPaise: prepared.candidate.amountPaise,
        direction: prepared.candidate.direction,
        kind: prepared.candidate.kind,
        status: prepared.candidate.status,
        occurredAt: new Date(prepared.candidate.occurredAt),
        source: 'sms',
        smsRefId: 'reference:strong-match',
        upiRef: prepared.candidate.upiRef,
        dedupeKey: prepared.identity.dedupeKey,
        bodyHash: prepared.identity.bodyHash,
        ruleId: prepared.ruleId,
        ruleVersion: prepared.ruleVersion,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }).run();

      await assert.rejects(saveReviewedPaste(fixture.ledger, prepared), /weak-identity paste requires review/);
      assert.equal((await findTransaction(fixture.ledger, legacy.identity.id))?.amountPaise, 24_999);
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 2);
    } finally {
      fixture.sqlite.close();
    }
  });

  it('keeps distinct failed and posted source alerts with the same UPI reference separate', async () => {
    const fixture = openLedger(':memory:');
    try {
      await fixture.ledger.migrateLedger();
      for (const suffix of ['. Transaction failed.', '']) {
        const prepared = await preparePastedSms({
          sender: 'VM-HDFCBK-S',
          body: `INR 12.34 debited from A/c XX1234 to merchant@examplebank (UPI Ref No 567890123456)${suffix}`,
          receivedAt: Date.parse('2026-09-27T10:00:00+05:30'),
        }, testFingerprinter);
        assert.equal(await saveReviewedPaste(fixture.ledger, prepared), 'inserted');
      }
      const rows = await fixture.ledger.db.select().from(transactions).all();
      assert.deepEqual(rows.map((row) => row.status).sort(), ['failed', 'posted']);
    } finally {
      fixture.sqlite.close();
    }
  });

  it('upgrades the original ledger without losing corrections or tombstones', async () => {
    const fixture = openLedger(':memory:');
    try {
      await migrateLedger(fixture.client, {
        journal: { entries: journal.entries.slice(0, 1) },
        migrations: { m0000: migrations.migrations.m0000! },
      });
      fixture.sqlite.exec(`
        INSERT INTO transactions (id, amount_paise, direction, kind, occurred_at, source, user_edited, created_at, updated_at, deleted_at)
        VALUES ('old-corrected', 45000, 'debit', 'expense', 1, 'paste', 1, 1, 1, NULL),
               ('old-deleted', 75000, 'debit', 'expense', 1, 'paste', 0, 1, 1, 2);
      `);
      await fixture.ledger.migrateLedger();
      const corrected = await findTransaction(fixture.ledger, 'old-corrected');
      const deleted = await findTransaction(fixture.ledger, 'old-deleted');
      assert.equal(corrected?.amountPaise, 45000);
      assert.equal(corrected?.userEdited, true);
      assert.equal(corrected?.ruleId, null);
      assert.equal(deleted?.deletedAt?.getTime(), 2);
    } finally {
      fixture.sqlite.close();
    }
  });

  it('requires review, persists provenance, and protects corrected and deleted paste replays', async () => {
    const fixture = openLedger(':memory:');
    const sms = {
      sender: 'VM-HDFCBK-S',
      body: 'INR 450.00 debited from A/c XX1234 to VPA fictional@axisbank (UPI Ref No 612345678901).',
      receivedAt: Date.parse('2026-10-07T10:00:00Z'),
    };
    try {
      await fixture.ledger.migrateLedger();
      const prepared = await preparePastedSms(sms, testFingerprinter);
      assert.equal(prepared.kind, 'needs-review');
      if (prepared.kind !== 'needs-review') throw new Error('Expected review');
      assert.ok(prepared.candidate);
      assert.equal(JSON.stringify(prepared).includes(sms.body), false);
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 0);
      assert.equal(await saveReviewedPaste(fixture.ledger, prepared, { amountPaise: 47000 }), 'inserted');
      let row = await findTransaction(fixture.ledger, prepared.identity.id);
      assert.equal(row?.amountPaise, 47000);
      assert.equal(row?.userEdited, true);
      assert.equal(row?.ruleId, prepared.ruleId);
      assert.equal(row?.ruleVersion, prepared.ruleVersion);
      assert.equal(row?.source, 'paste');

      const replay = await preparePastedSms({ ...sms, receivedAt: sms.receivedAt + 86_400_000 }, testFingerprinter);
      assert.equal(await saveReviewedPaste(fixture.ledger, replay, {}), 'duplicate');
      const alternateAlert = await preparePastedSms({ ...sms, sender: 'AD-ICICIB-S', body: sms.body.replace('450.00', '450') }, testFingerprinter);
      await assert.rejects(saveReviewedPaste(fixture.ledger, alternateAlert, {}), /conflicting details; review it/);
      assert.equal((await findTransaction(fixture.ledger, prepared.identity.id))?.amountPaise, 47000);
      await fixture.ledger.editTransaction(prepared.identity.id, { amountPaise: 49000 });
      assert.equal(await saveReviewedPaste(fixture.ledger, replay, {}), 'duplicate');
      await fixture.ledger.softDeleteTransaction(prepared.identity.id);
      assert.equal(await saveReviewedPaste(fixture.ledger, replay, {}), 'duplicate');
      row = await findTransaction(fixture.ledger, prepared.identity.id);
      assert.equal(row?.amountPaise, 49000);
      assert.ok(row?.deletedAt);
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 1);
    } finally {
      fixture.sqlite.close();
    }
  });

  it('handles ambiguous and ignored pastes, validates corrections, and atomically deduplicates concurrent saves', async () => {
    const fixture = openLedger(':memory:');
    const raw = { sender: 'PASTE', receivedAt: Date.parse('2026-10-07T12:00:00Z'), body: 'Your A/c XX1234 INR 750 txn 612345678901' };
    try {
      await fixture.ledger.migrateLedger();
      const unknown = await preparePastedSms(raw, testFingerprinter);
      assert.equal(unknown.kind, 'needs-review');
      if (unknown.kind !== 'needs-review') throw new Error('Expected review');
      assert.equal(unknown.candidate, null);
      await assert.rejects(saveReviewedPaste(fixture.ledger, unknown, {}));
      const values = { amountPaise: 75000, direction: 'debit' as const, kind: 'expense' as const, status: 'posted' as const, occurredAt: new Date(raw.receivedAt) };
      for (const amountPaise of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(saveReviewedPaste(fixture.ledger, unknown, { ...values, amountPaise }));
      }
      await assert.rejects(saveReviewedPaste(fixture.ledger, unknown, { ...values, occurredAt: new Date(NaN) }));
      await assert.rejects(saveReviewedPaste(fixture.ledger, unknown, { ...values, accountId: 'missing' }));
      const outcomes = await Promise.all([
        saveReviewedPaste(fixture.ledger, unknown, values),
        saveReviewedPaste(fixture.ledger, unknown, values),
      ]);
      assert.deepEqual(outcomes.sort(), ['duplicate', 'inserted']);
      const replay = await preparePastedSms({ ...raw, receivedAt: raw.receivedAt + 86_400_000 }, testFingerprinter);
      assert.equal(await saveReviewedPaste(fixture.ledger, replay, values), 'duplicate');
      const ignored = await preparePastedSms({ ...raw, body: '123456 is your OTP for INR 450. Do not share.' }, testFingerprinter);
      assert.equal(ignored.kind, 'ignored');
      await assert.rejects(saveReviewedPaste(fixture.ledger, ignored, values));
      const ambiguous = await preparePastedSms({ ...raw, body: 'Paid you Rs 500 for dinner' }, testFingerprinter);
      assert.equal(ambiguous.kind, 'needs-review');
      if (ambiguous.kind !== 'needs-review') throw new Error('Expected review');
      assert.ok(ambiguous.candidate);
      assert.equal(await saveReviewedPaste(fixture.ledger, ambiguous, { direction: 'credit', kind: 'income' }), 'inserted');
    } finally {
      fixture.sqlite.close();
    }
  });

  it('keeps opposite UPI movements separate and ignores injected correction metadata', async () => {
    const fixture = openLedger(':memory:');
    const sms = { sender: 'PASTE', body: 'INR 450 debited from A/c XX1234 (UPI Ref No 612345678901).', receivedAt: Date.parse('2026-10-07T10:00:00Z') };
    try {
      await fixture.ledger.migrateLedger();
      const debit = await preparePastedSms(sms, testFingerprinter);
      const credit = await preparePastedSms({ ...sms, body: sms.body.replace('debited from', 'credited to') }, testFingerprinter);
      if (debit.kind !== 'needs-review' || credit.kind !== 'needs-review') throw new Error('Expected review');
      assert.notEqual(debit.identity.id, credit.identity.id);
      const injected = { id: 'forged', source: 'manual', ruleId: 'forged', body: sms.body, userEdited: false, deletedAt: new Date(1) };
      assert.equal(await saveReviewedPaste(fixture.ledger, debit, injected as Parameters<typeof saveReviewedPaste>[2]), 'inserted');
      assert.equal(await saveReviewedPaste(fixture.ledger, credit, {}), 'inserted');
      const row = await findTransaction(fixture.ledger, debit.identity.id);
      assert.equal(row?.source, 'paste');
      assert.equal(row?.ruleId, debit.ruleId);
      assert.equal(row?.userEdited, true);
      assert.equal(row?.deletedAt, null);
      assert.equal(await findTransaction(fixture.ledger, 'forged'), undefined);
      assert.equal(JSON.stringify(await fixture.ledger.db.select().from(transactions).all()).includes(sms.body), false);
    } finally {
      fixture.sqlite.close();
    }
  });

  it('migrates, persists, reopens, and ignores runtime-only metadata', async () => {
    let fixture = openLedger(filename);
    await fixture.ledger.migrateLedger();
    await fixture.ledger.db.insert(accounts).values({ id: 'cash', name: 'Fictional cash', type: 'cash' }).run();
    await fixture.ledger.db.insert(categories).values({ id: 'food', name: 'Fictional food', kind: 'expense' }).run();

    const note = `Fictional note ${'x'.repeat(400)}`;
    const injected = {
      ...transaction('persisted', { accountId: 'cash', categoryId: 'food', note }),
      smsRefId: 'forged-sms-ref',
      dedupeKey: 'forged-dedupe-key',
      bodyHash: 'forged-body-hash',
      ruleId: 'forged-rule',
      ruleVersion: 99,
      userEdited: false,
      deletedAt: new Date('2026-10-05T00:00:00.000Z'),
    } as NewTransaction;
    await fixture.ledger.createTransaction(injected);
    const original = await findTransaction(fixture.ledger, 'persisted');
    assert.ok(original);
    assert.equal(original.userEdited, true);
    assert.equal(original.deletedAt, null);
    assert.equal(original.smsRefId, null);
    assert.equal(original.dedupeKey, null);
    assert.equal(original.bodyHash, null);
    assert.equal(original.ruleId, null);
    assert.equal(original.ruleVersion, null);
    assert.equal(original.note, note);
    fixture.sqlite.close();

    fixture = openLedger(filename);
    await fixture.ledger.migrateLedger();
    const reopened = await findTransaction(fixture.ledger, 'persisted');
    assert.ok(reopened);
    assert.equal(reopened.amountPaise, 45600);
    assert.equal(reopened.accountId, 'cash');
    assert.equal(reopened.categoryId, 'food');
    assert.equal(reopened.note, note);
    assert.equal(reopened.deletedAt, null);
    fixture.sqlite.close();
  });

  it('restores an archived account without changing its identity or transactions', async () => {
    const fixture = openLedger(':memory:');
    try {
      await fixture.ledger.migrateLedger();
      await fixture.ledger.createAccount({ id: 'card', name: 'Fictional card', type: 'credit_card' });
      await fixture.ledger.createTransaction(transaction('card-purchase', { accountId: 'card' }));
      const original = await findTransaction(fixture.ledger, 'card-purchase');
      await fixture.ledger.archiveAccount('card');
      assert.deepEqual(await fixture.ledger.listAccounts(), []);
      await assert.rejects(fixture.ledger.restoreAccount(' '), TypeError);
      assert.equal(await fixture.ledger.restoreAccount('missing'), false);
      assert.equal(await fixture.ledger.restoreAccount('card'), true);
      const [restored] = await fixture.ledger.listAccounts();
      assert.equal(restored.id, 'card');
      assert.equal(restored.name, 'Fictional card');
      assert.equal(restored.archived, false);
      assert.deepEqual(await findTransaction(fixture.ledger, 'card-purchase'), original);
    } finally {
      fixture.sqlite.close();
    }
  });

  it('validates manual/import/review writes and keeps account/category setup safe', async () => {
    const fixture = openLedger(':memory:');
    try {
      await fixture.ledger.migrateLedger();

      const injectedAccount = { id: 'cash', name: ' Cash ', type: 'cash', archived: true } as NewAccount;
      await fixture.ledger.createAccount(injectedAccount);
      let account = await fixture.ledger.db.select().from(accounts).where(eq(accounts.id, 'cash')).get();
      assert.equal(account?.name, 'Cash');
      assert.equal(account?.archived, false);
      await fixture.ledger.updateAccount('cash', { name: ' Main cash ', institution: null, isOwn: false });
      account = await fixture.ledger.db.select().from(accounts).where(eq(accounts.id, 'cash')).get();
      assert.equal(account?.name, 'Main cash');
      assert.equal(account?.institution, null);
      assert.equal(account?.isOwn, false);
      await assert.rejects(fixture.ledger.createAccount({ id: 'bad-account', name: '  ', type: 'cash' }));
      await assert.rejects(fixture.ledger.createAccount({ id: '  ', name: 'Cash', type: 'cash' }));
      await assert.rejects(fixture.ledger.createAccount({ id: 'bad-account', name: 'Cash', type: 'cheque' } as unknown as NewAccount));
      await assert.rejects(fixture.ledger.createAccount({ id: 'bad-account', name: 'Cash', type: 'cash', institution: 1 } as unknown as NewAccount));
      await assert.rejects(fixture.ledger.updateAccount('cash', { isOwn: 'yes' } as unknown as AccountPatch));
      await assert.rejects(fixture.ledger.archiveAccount(' '));
      assert.equal(await fixture.ledger.updateAccount('cash', { archived: true } as AccountPatch), false);
      assert.equal(await fixture.ledger.archiveAccount('cash'), true);
      assert.equal((await fixture.ledger.listAccounts()).length, 0);
      assert.equal((await fixture.ledger.listAccounts(true))[0]?.archived, true);

      const injectedCategory = { id: 'food', name: ' Food ', kind: 'expense', isSystem: true, parentId: 'missing' } as NewCategory;
      await fixture.ledger.createCategory(injectedCategory);
      let category = await fixture.ledger.db.select().from(categories).where(eq(categories.id, 'food')).get();
      assert.equal(category?.name, 'Food');
      assert.equal(category?.isSystem, false);
      assert.equal(category?.parentId, null);
      await fixture.ledger.updateCategory('food', { name: ' Dining ', icon: null, sortOrder: 10 });
      category = await fixture.ledger.db.select().from(categories).where(eq(categories.id, 'food')).get();
      assert.equal(category?.name, 'Dining');
      assert.equal(category?.sortOrder, 10);
      await assert.rejects(fixture.ledger.createCategory({ id: 'bad-category', name: 'Food', kind: 'other' } as unknown as NewCategory));
      await assert.rejects(fixture.ledger.createCategory({ id: ' ', name: 'Food', kind: 'expense' }));
      await assert.rejects(fixture.ledger.createCategory({ id: 'bad-category', name: 'Food', kind: 'expense', icon: false } as unknown as NewCategory));
      await assert.rejects(fixture.ledger.updateCategory('food', { color: 12 } as never));
      await assert.rejects(fixture.ledger.updateCategory('food', { sortOrder: 1.5 }));

      await fixture.ledger.db.insert(budgets).values({ id: 'food-budget', categoryId: 'food', month: '2026-10', amountPaise: 10_000 }).run();
      await assert.rejects(fixture.ledger.updateCategory('food', { kind: 'income' }));
      await assert.rejects(fixture.ledger.deleteCategory('food'), RangeError);
      await fixture.ledger.db.delete(budgets).where(eq(budgets.id, 'food-budget')).run();
      await fixture.ledger.createTransaction(transaction('category-reference', { accountId: 'cash', categoryId: 'food' }));
      await assert.rejects(fixture.ledger.deleteCategory('food'), RangeError);
      await assert.rejects(fixture.ledger.updateCategory('food', { kind: 'income' }), RangeError);
      await fixture.ledger.softDeleteTransaction('category-reference');
      await assert.rejects(fixture.ledger.deleteCategory('food'), RangeError);
      await assert.rejects(fixture.ledger.updateCategory('food', { kind: 'income' }), RangeError);

      await fixture.ledger.createCategory({ id: 'unused', name: 'Unused', kind: 'income' });
      assert.deepEqual((await fixture.ledger.listCategories('income')).map(({ id }) => id), ['unused']);
      assert.equal(await fixture.ledger.deleteCategory('unused'), true);
      assert.equal(await fixture.ledger.deleteCategory('unused'), false);
      await fixture.ledger.createCategory({ id: 'salary', name: 'Salary', kind: 'income' });
      await fixture.ledger.createCategory({ id: 'parent', name: 'Parent', kind: 'expense' });
      await fixture.ledger.db.insert(categories).values({ id: 'child', name: 'Child', kind: 'expense', parentId: 'parent' }).run();
      await assert.rejects(fixture.ledger.deleteCategory('parent'), RangeError);
      await fixture.ledger.db.delete(categories).where(eq(categories.id, 'child')).run();
      assert.equal(await fixture.ledger.deleteCategory('parent'), true);
      await fixture.ledger.db.insert(categories).values({ id: 'system', name: 'System', kind: 'expense', isSystem: true }).run();
      await assert.rejects(fixture.ledger.deleteCategory('system'), RangeError);
      await assert.rejects(fixture.ledger.deleteCategory(' '));

      const invalidManuals = [
        { ...transaction('bad-id'), id: '  ' },
        { ...transaction('bad-direction'), direction: 'wire' },
        { ...transaction('bad-kind'), kind: 'subscription' },
        { ...transaction('bad-status'), status: 'queued' },
        { ...transaction('expense-credit'), direction: 'credit' },
        { ...transaction('income-debit'), kind: 'income' },
        { ...transaction('income-wrong-category'), direction: 'credit', kind: 'income', categoryId: 'food' },
        { ...transaction('bad-source'), source: 'sms' },
        { ...transaction('bad-date'), occurredAt: new Date(Number.NaN) },
        { ...transaction('bad-created-at'), createdAt: new Date(Number.NaN) },
        { ...transaction('bad-note'), note: 42 },
        { ...transaction('bad-flag'), excludeFromStats: 'false' },
        { ...transaction('missing-account'), accountId: 'missing' },
      ];
      for (const input of invalidManuals) {
        await assert.rejects(fixture.ledger.createTransaction(input as unknown as NewTransaction));
      }
      await assert.rejects(fixture.ledger.createTransaction(transaction('refund-wrong-category', {
        direction: 'credit', kind: 'refund', categoryId: 'salary',
      })));
      await assert.rejects(fixture.ledger.createTransaction(transaction('reversal-wrong-category', {
        direction: 'credit', kind: 'reversal', categoryId: 'salary',
      })));
      await fixture.ledger.createTransaction(transaction('refund-valid', {
        direction: 'credit', kind: 'refund', categoryId: 'food',
      }));
      await fixture.ledger.createTransaction(transaction('transfer-category', {
        direction: 'credit', kind: 'transfer', categoryId: 'salary',
      }));
      await fixture.ledger.createTransaction(transaction('edit-row', { accountId: 'cash', categoryId: 'food' }));
      for (const patch of [
        { direction: 'wire' },
        { kind: 'subscription' },
        { status: 'queued' },
        { direction: 'credit' },
        { kind: 'income' },
        { categoryId: 'salary' },
        { occurredAt: new Date(Number.NaN) },
        { note: 42 },
        { excludeFromStats: 'false' },
        { linkedTxnId: 'missing' },
      ]) {
        await assert.rejects(fixture.ledger.editTransaction('edit-row', patch as unknown as TransactionPatch));
      }
      assert.equal(await fixture.ledger.editTransaction('edit-row', { note: 'Corrected note', excludeFromStats: true }), true);
      const corrected = await findTransaction(fixture.ledger, 'edit-row');
      assert.equal(corrected?.note, 'Corrected note');
      assert.equal(corrected?.excludeFromStats, true);
      assert.equal(corrected?.userEdited, true);
      assert.equal(await fixture.ledger.editTransaction('edit-row', {
        direction: 'credit', kind: 'income', categoryId: 'salary',
      }), true);
      const reclassified = await findTransaction(fixture.ledger, 'edit-row');
      assert.equal(reclassified?.direction, 'credit');
      assert.equal(reclassified?.kind, 'income');
      assert.equal(reclassified?.categoryId, 'salary');

      const invalidImports = [
        { ...importedTransaction('bad-import-id'), id: '' },
        { ...importedTransaction('bad-import-direction'), direction: 'wire' },
        { ...importedTransaction('bad-import-kind'), kind: 'subscription' },
        { ...importedTransaction('bad-import-status'), status: 'queued' },
        { ...importedTransaction('bad-import-pair'), direction: 'debit', kind: 'income' },
        { ...importedTransaction('bad-import-category'), direction: 'credit', kind: 'income', categoryId: 'food' },
        { ...importedTransaction('bad-import-refund-category'), direction: 'credit', kind: 'refund', categoryId: 'salary' },
        { ...importedTransaction('bad-import-reversal-category'), direction: 'credit', kind: 'reversal', categoryId: 'salary' },
        { ...importedTransaction('bad-import-source'), source: 'email' },
        { ...importedTransaction('bad-import-date'), occurredAt: new Date(Number.NaN) },
        { ...importedTransaction('bad-import-text'), note: false },
        { ...importedTransaction('bad-import-flag'), excludeFromStats: 0 },
        { ...importedTransaction('bad-import-ref'), categoryId: 'missing' },
        { ...importedTransaction('bad-import-provenance'), ruleId: 'rule', ruleVersion: null },
      ];
      for (const input of invalidImports) {
        await assert.rejects(fixture.ledger.upsertImportedTransaction(input as unknown as ImportedTransaction));
      }
      const imported = importedTransaction('sms-import', { source: 'sms', smsRefId: 'sms-row', ruleId: 'test.rule', ruleVersion: 1 });
      assert.equal(await fixture.ledger.upsertImportedTransaction(imported), true);
      const importedRow = await findTransaction(fixture.ledger, 'sms-import');
      assert.equal(importedRow?.smsRefId, 'sms-row');
      assert.equal(importedRow?.ruleVersion, 1);
      await assert.rejects(
        fixture.ledger.upsertImportedTransaction(importedTransaction('bad-sms-provenance', { source: 'sms' })),
        TypeError,
      );

      const reviewedPaste: ReviewedPasteTransaction = {
        id: 'reviewed-valid',
        amountPaise: 25_000,
        direction: 'debit',
        kind: 'expense',
        status: 'posted',
        occurredAt: new Date('2026-10-06T12:00:00.000Z'),
        dedupeKey: 'review-dedupe',
        bodyHash: 'review-body',
        weakDedupeKey: `body:${'a'.repeat(64)}`,
        ruleId: null,
        ruleVersion: null,
      };
      await assert.rejects(fixture.ledger.insertReviewedPaste({ ...reviewedPaste, id: '' }));
      await assert.rejects(fixture.ledger.insertReviewedPaste({ ...reviewedPaste, direction: 'wire' } as unknown as ReviewedPasteTransaction));
      await assert.rejects(fixture.ledger.insertReviewedPaste({ ...reviewedPaste, direction: 'credit' }));
      await assert.rejects(fixture.ledger.insertReviewedPaste({ ...reviewedPaste, categoryId: 'salary' }));
      await assert.rejects(fixture.ledger.insertReviewedPaste({
        ...reviewedPaste, direction: 'credit', kind: 'income', categoryId: 'food',
      }));
      await assert.rejects(fixture.ledger.insertReviewedPaste({ ...reviewedPaste, ruleVersion: 1 }));
      await assert.rejects(fixture.ledger.insertReviewedPaste({ ...reviewedPaste, bodyHash: '' }));
      await fixture.ledger.insertReviewedPaste(reviewedPaste);
    } finally {
      fixture.sqlite.close();
    }
  });

  it('updates only untouched imports and preserves edits, tombstones, and manual rows', async () => {
    const fixture = openLedger(filename);
    try {
      await fixture.ledger.migrateLedger();
      const imported = importedTransaction('import-update');
      const injected = {
        ...imported,
        createdAt: new Date(1),
        updatedAt: new Date(1),
        deletedAt: new Date(1),
        userEdited: true,
      } as ImportedTransaction;
      assert.equal(await fixture.ledger.upsertImportedTransaction(injected), true);
      let row = await findTransaction(fixture.ledger, 'import-update');
      assert.equal(row?.userEdited, false);
      assert.equal(row?.deletedAt, null);
      assert.notEqual(row?.createdAt.getTime(), 1);

      fixture.sqlite.prepare('UPDATE transactions SET created_at = 123456 WHERE id = ?').run('import-update');
      assert.equal(await fixture.ledger.upsertImportedTransaction({ ...imported, amountPaise: 50000 }), true);
      row = await findTransaction(fixture.ledger, 'import-update');
      assert.equal(row?.amountPaise, 50000);
      assert.equal(row?.createdAt.getTime(), 123456);

      const injectedPatch = {
        amountPaise: 51000,
        id: 'forged-id',
        source: 'manual',
        userEdited: false,
        deletedAt: new Date(1),
      } as TransactionPatch;
      assert.equal(await fixture.ledger.editTransaction('import-update', injectedPatch), true);
      assert.equal(await fixture.ledger.upsertImportedTransaction({ ...imported, amountPaise: 52000 }), false);
      row = await findTransaction(fixture.ledger, 'import-update');
      assert.equal(row?.amountPaise, 51000);
      assert.equal(row?.userEdited, true);
      assert.equal(row?.deletedAt, null);
      assert.equal(row?.source, 'paste');
      assert.equal(await findTransaction(fixture.ledger, 'forged-id'), undefined);

      const deleted = importedTransaction('import-deleted');
      await fixture.ledger.upsertImportedTransaction(deleted);
      assert.equal(await fixture.ledger.softDeleteTransaction('import-deleted'), true);
      assert.equal(await fixture.ledger.upsertImportedTransaction({ ...deleted, amountPaise: 52000 }), false);
      row = await findTransaction(fixture.ledger, 'import-deleted');
      assert.ok(row?.deletedAt);
      assert.equal(row.amountPaise, 45600);

      await fixture.ledger.createTransaction(transaction('manual-row', { source: 'manual' }));
      fixture.sqlite.prepare('UPDATE transactions SET user_edited = 0 WHERE id = ?').run('manual-row');
      assert.equal(await fixture.ledger.upsertImportedTransaction(importedTransaction('manual-row')), false);
      row = await findTransaction(fixture.ledger, 'manual-row');
      assert.equal(row?.source, 'manual');
      assert.equal(row?.userEdited, false);
      await assert.rejects(
        fixture.ledger.upsertImportedTransaction(transaction('bad-import') as unknown as ImportedTransaction),
        TypeError,
      );
    } finally {
      fixture.sqlite.close();
    }
  });

  it('rejects unsafe money in the API and invalid money, enum, and foreign-key values in SQLite', async () => {
    const fixture = openLedger(filename);
    try {
      await fixture.ledger.migrateLedger();
      const invalidAmounts = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
      for (const amountPaise of invalidAmounts) {
        await assert.rejects(fixture.ledger.createTransaction(transaction(`bad-${String(amountPaise)}`, { amountPaise })));
      }
      await assert.rejects(fixture.ledger.editTransaction('absent', { amountPaise: 1.5 }));
      await assert.rejects(fixture.ledger.upsertImportedTransaction(importedTransaction('bad-import', { amountPaise: 0 })));
      await fixture.ledger.createTransaction(transaction('max-safe', { amountPaise: Number.MAX_SAFE_INTEGER }));

      const insert = fixture.sqlite.prepare(`
        INSERT INTO transactions (id, amount_paise, direction, kind, account_id, occurred_at, source, created_at, updated_at)
        VALUES (?, ?, ?, 'expense', ?, 1, 'paste', 1, 1)
      `);
      for (const amountPaise of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => insert.run(`sql-bad-${String(amountPaise)}`, amountPaise, 'debit', null));
      }
      assert.throws(() => insert.run('sql-bad-direction', 10, 'wire', null));
      assert.throws(() => insert.run('sql-bad-account', 10, 'debit', 'missing-account'));
    } finally {
      fixture.sqlite.close();
    }
  });

  it('applies new migrations without losing rows, rejects newer schemas, and rolls failures back', async () => {
    const fixture = openLedger(filename);
    try {
      await fixture.ledger.migrateLedger();
      await fixture.ledger.db.insert(accounts).values({ id: 'kept', name: 'Fictional account', type: 'cash' }).run();
      await fixture.ledger.createTransaction(transaction('migration-edited', { source: 'manual', amountPaise: 12000 }));
      await fixture.ledger.editTransaction('migration-edited', { amountPaise: 13000 });
      await fixture.ledger.createTransaction(transaction('migration-deleted'));
      await fixture.ledger.softDeleteTransaction('migration-deleted', new Date('2026-10-06T13:00:00.000Z'));

      const nextMigrations: LedgerMigrations = {
        journal: {
          entries: [...migrations.journal.entries, { idx: journal.entries.length, when: 1, tag: 'test_column', breakpoints: true }],
        },
        migrations: {
          ...migrations.migrations,
          [`m${String(journal.entries.length).padStart(4, '0')}`]: `ALTER TABLE accounts ADD COLUMN migration_marker TEXT NOT NULL DEFAULT 'preserved'`,
        },
      };
      await migrateLedger(fixture.client, nextMigrations);
      const account = fixture.sqlite.prepare('SELECT id, migration_marker FROM accounts WHERE id = ?').get('kept') as
        | { id: string; migration_marker: string }
        | undefined;
      assert.equal(account?.id, 'kept');
      assert.equal(account?.migration_marker, 'preserved');
      assert.equal((fixture.sqlite.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, journal.entries.length + 1);
      const edited = await findTransaction(fixture.ledger, 'migration-edited');
      assert.equal(edited?.amountPaise, 13000);
      assert.equal(edited?.userEdited, true);
      const deleted = await findTransaction(fixture.ledger, 'migration-deleted');
      assert.equal(deleted?.amountPaise, 45600);
      assert.equal(deleted?.deletedAt?.toISOString(), '2026-10-06T13:00:00.000Z');
      await assert.rejects(migrateLedger(fixture.client, migrations), /newer than this app supports/);
    } finally {
      fixture.sqlite.close();
    }

    const failed = temporaryFile();
    const failedFixture = openLedger(failed.filename);
    try {
      await failedFixture.ledger.migrateLedger();
      await failedFixture.ledger.db.insert(accounts).values({ id: 'kept', name: 'Fictional account', type: 'cash' }).run();
      const brokenMigrations: LedgerMigrations = {
        journal: {
          entries: [...migrations.journal.entries, { idx: journal.entries.length, when: 1, tag: 'broken', breakpoints: true }],
        },
        migrations: {
          ...migrations.migrations,
          [`m${String(journal.entries.length).padStart(4, '0')}`]: 'CREATE TABLE rollback_probe (id TEXT);--> statement-breakpoint SELECT * FROM missing_table',
        },
      };
      await assert.rejects(migrateLedger(failedFixture.client, brokenMigrations));
      assert.equal((failedFixture.sqlite.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, journal.entries.length);
      assert.equal(
        (failedFixture.sqlite.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'rollback_probe'").get() as { count: number }).count,
        0,
      );
      assert.equal((failedFixture.sqlite.prepare('SELECT count(*) AS count FROM accounts WHERE id = ?').get('kept') as { count: number }).count, 1);
    } finally {
      failedFixture.sqlite.close();
      removeTemporaryFile(failed.directory, failed.filename);
    }
  });
});
