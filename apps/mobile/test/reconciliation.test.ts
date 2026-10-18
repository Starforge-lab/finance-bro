/// <reference types="node" />
import assert from 'node:assert/strict';
import { rmSync, rmdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createReconciliation } from '../src/db/reconciliation';
import { migrateLedger } from '../src/db/ledger';
import { ledgerMigrations, openTestLedger, temporaryFile } from './helpers/ledger';

const start = new Date('2026-10-01T00:00:00Z');
const later = new Date('2026-10-02T00:00:00Z');
const now = new Date('2026-10-03T00:00:00Z');
async function fixture() {
  const f = openTestLedger();
  await f.ledger.migrateLedger();
  await f.ledger.createAccount({ id: 'bank', name: 'Fictional bank', type: 'bank' });
  await f.ledger.createAccount({ id: 'card', name: 'Fictional card', type: 'credit_card' });
  return { ...f, reconciliation: createReconciliation(f.client, ledgerMigrations) };
}
function add(f: Awaited<ReturnType<typeof fixture>>, id: string, accountId: string, direction: 'debit' | 'credit', amountPaise: number, extra = '') {
  f.sqlite.prepare(`INSERT INTO transactions (id,account_id,amount_paise,direction,kind,status,occurred_at,source,created_at,updated_at,exclude_from_stats) VALUES (?,?,?,?,'transfer','posted',?,'manual',?,?,1)`).run(id, accountId, amountPaise, direction, later.getTime(), later.getTime(), later.getTime());
  if (extra) f.sqlite.exec(`UPDATE transactions SET ${extra} WHERE id='${id}'`);
}
describe('account reconciliation', () => {
  it('does not infer balances without checkpoints; applies all posted account movements with card liability signs', async () => {
    const f = await fixture();
    try {
      assert.equal((await f.reconciliation.getAccountBalances(now))[0]?.calculatedPaise, null);
      await f.reconciliation.setAccountBalance({ accountId: 'bank', balancePaise: 10000, asOf: start }, now);
      await f.reconciliation.setAccountBalance({ accountId: 'card', balancePaise: 5000, asOf: start }, now);
      add(f, 'debit', 'bank', 'debit', 1000);
      add(f, 'credit', 'bank', 'credit', 200);
      add(f, 'purchase', 'card', 'debit', 800);
      add(f, 'repayment', 'card', 'credit', 1000);
      add(f, 'pending', 'bank', 'debit', 999, "status='pending'");
      add(f, 'failed', 'bank', 'debit', 999, "status='failed'");
      add(f, 'deleted', 'bank', 'debit', 999, `deleted_at=${later.getTime()}`);
      add(f, 'future', 'bank', 'debit', 999, `occurred_at=${now.getTime() + 1}`);
      add(f, 'at-cutoff', 'bank', 'debit', 999, `occurred_at=${start.getTime()}`);
      const rows = await f.reconciliation.getAccountBalances(now);
      assert.equal(rows.find(r => r.accountId === 'bank')?.calculatedPaise, 9200);
      assert.equal(rows.find(r => r.accountId === 'card')?.calculatedPaise, 4800);
      await f.reconciliation.setAccountBalance({ accountId: 'bank', balancePaise: 9000, asOf: now }, now);
      const bank = (await f.reconciliation.getAccountBalances(now)).find(r => r.accountId === 'bank')!;
      assert.equal(bank.calculatedPaise, 9000);
      assert.equal(bank.reconciliationDeltaPaise, -200);
      assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM transactions').get()?.n, 9);
      f.sqlite.exec("UPDATE accounts SET type='cash' WHERE id='bank'");
      assert.equal((await f.reconciliation.getAccountBalances(now)).find(r => r.accountId === 'bank')?.calculatedPaise, null);
    } finally { f.sqlite.close(); }
  });
  it('rejects invalid inputs, non-own/archived/missing accounts and backdates while accepting signed balances', async () => {
    const f = await fixture();
    try {
      for (const balancePaise of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(f.reconciliation.setAccountBalance({ accountId: 'bank', balancePaise, asOf: start }, now));
      }
      for (const accountId of ['', ' ', 'missing']) await assert.rejects(f.reconciliation.setAccountBalance({ accountId, balancePaise: 0, asOf: start }, now));
      await assert.rejects(f.reconciliation.getAccountBalances(new Date(NaN)));
      await assert.rejects(f.reconciliation.setAccountBalance({ accountId: 'bank', balancePaise: 0, asOf: new Date(NaN) }, now));
      await assert.rejects(f.reconciliation.setAccountBalance({ accountId: 'bank', balancePaise: 0, asOf: now }, later));
      for (const flag of ['is_own=0', 'archived=1']) {
        f.sqlite.exec(`UPDATE accounts SET ${flag} WHERE id='bank'`);
        await assert.rejects(f.reconciliation.setAccountBalance({ accountId: 'bank', balancePaise: 0, asOf: start }, now));
        f.sqlite.exec("UPDATE accounts SET is_own=1, archived=0 WHERE id='bank'");
      }
      await f.reconciliation.setAccountBalance({ accountId: 'bank', balancePaise: -100, asOf: later }, now);
      await f.reconciliation.setAccountBalance({ accountId: 'card', balancePaise: -200, asOf: later }, now);
      await assert.rejects(f.reconciliation.setAccountBalance({ accountId: 'bank', balancePaise: 0, asOf: start }, now));
      assert.equal((await f.reconciliation.getAccountBalances(start))[0]?.calculatedPaise, null);
      assert.equal((await f.reconciliation.getAccountBalances(now)).find(r => r.accountId === 'card')?.calculatedPaise, -200);
    } finally { f.sqlite.close(); }
  });
  it('rejects overflow and corrupt database money without replacing the checkpoint', async () => {
    const f = await fixture();
    try {
      await f.reconciliation.setAccountBalance({ accountId: 'bank', balancePaise: Number.MAX_SAFE_INTEGER, asOf: start }, now);
      add(f, 'overflow', 'bank', 'credit', 1);
      await assert.rejects(f.reconciliation.getAccountBalances(now), /safe integer/);
      await assert.rejects(f.reconciliation.setAccountBalance({ accountId: 'bank', balancePaise: 0, asOf: now }, now));
      f.sqlite.exec("DELETE FROM transactions; PRAGMA ignore_check_constraints=ON; UPDATE account_balance_checkpoints SET balance_paise=1.5 WHERE account_id='bank'");
      await assert.rejects(f.reconciliation.getAccountBalances(now), /safe integer/);
      assert.equal(f.sqlite.prepare("SELECT as_of FROM account_balance_checkpoints WHERE account_id='bank'").get()?.as_of, start.getTime());
    } finally { f.sqlite.close(); }
  });
  it('rejects corrupt movement money and overflowing reconciliation differences', async () => {
    const f = await fixture();
    try {
      await f.reconciliation.setAccountBalance({ accountId: 'bank', balancePaise: Number.MIN_SAFE_INTEGER, asOf: start }, now);
      await assert.rejects(f.reconciliation.setAccountBalance({ accountId: 'bank', balancePaise: Number.MAX_SAFE_INTEGER, asOf: now }, now), /safe integer/);
      add(f, 'corrupt', 'bank', 'credit', 1);
      f.sqlite.exec("PRAGMA ignore_check_constraints=ON; UPDATE transactions SET amount_paise=1.5 WHERE id='corrupt'");
      await assert.rejects(f.reconciliation.getAccountBalances(now), /safe integer/);
      assert.equal(f.sqlite.prepare("SELECT balance_paise FROM account_balance_checkpoints WHERE account_id='bank'").get()?.balance_paise, Number.MIN_SAFE_INTEGER);
    } finally { f.sqlite.close(); }
  });
  it('uses the supplied transaction runner and rolls back a failed checkpoint write', async () => {
    const f = await fixture();
    try {
      let runs = 0;
      const reconciliation = createReconciliation(f.client, ledgerMigrations, async task => {
        runs += 1;
        await f.client.withTransactionAsync(() => task(f.client));
      });
      await reconciliation.setAccountBalance({ accountId: 'bank', balancePaise: 500, asOf: start }, now);
      assert.equal((await reconciliation.getAccountBalances(now)).find(r => r.accountId === 'bank')?.calculatedPaise, 500);
      assert.equal(runs, 2);
      f.sqlite.exec("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON account_balance_checkpoints BEGIN SELECT RAISE(ABORT, 'fictional failure'); END");
      await assert.rejects(reconciliation.setAccountBalance({ accountId: 'bank', balancePaise: 600, asOf: later }, now), (error: Error) => {
        assert.match(String(error.cause), /fictional failure/);
        return true;
      });
      assert.equal((await reconciliation.getAccountBalances(now)).find(r => r.accountId === 'bank')?.calculatedPaise, 500);
      assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM transactions').get()?.n, 0);
    } finally { f.sqlite.close(); }
  });
  it('upgrades a seeded ledger and persists checkpoints across reopening', async () => {
    const { directory, filename } = temporaryFile();
    const f = openTestLedger(filename);
    try {
      await migrateLedger(f.client, { journal: { entries: ledgerMigrations.journal.entries.slice(0, 9) }, migrations: ledgerMigrations.migrations });
      await f.ledger.createAccount({ id: 'saved', name: 'Fictional savings', type: 'bank' });
      await f.ledger.migrateLedger();
      await createReconciliation(f.client, ledgerMigrations).setAccountBalance({ accountId: 'saved', balancePaise: 25000, asOf: start }, now);
    } finally { f.sqlite.close(); }
    const reopened = openTestLedger(filename);
    try {
      await reopened.ledger.migrateLedger();
      const rows = await createReconciliation(reopened.client, ledgerMigrations).getAccountBalances(now);
      assert.equal(rows[0]?.calculatedPaise, 25000);
      assert.deepEqual(rows[0]?.lastVerifiedAt, start);
      assert.equal(rows[0]?.reconciliationDeltaPaise, null);
      for (const value of ['1.5', '9007199254740992', "'bad'"]) {
        assert.throws(() => reopened.sqlite.exec(`UPDATE account_balance_checkpoints SET balance_paise=${value}`));
      }
    } finally { reopened.sqlite.close(); rmSync(filename, { force: true }); rmdirSync(directory); }
  });
});
