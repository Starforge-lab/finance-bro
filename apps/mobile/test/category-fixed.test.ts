import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createDataLayer } from '../src/db/service';
import { ledgerMigrations, openTestLedger } from './helpers/ledger';

it('stores whether a category is a fixed cost, defaulting to flexible', async () => {
  const fixture = openTestLedger();
  const ledger = createDataLayer(fixture.client, ledgerMigrations);
  try {
    await ledger.migrateLedger();
    await ledger.createCategory({ id: 'rent', name: 'Rent', kind: 'expense', isFixed: true });
    await ledger.createCategory({ id: 'food', name: 'Food', kind: 'expense' });
    const read = async () => Object.fromEntries((await ledger.listCategories()).map((row) => [row.id, row.isFixed]));
    assert.deepEqual(await read(), { rent: true, food: false });

    assert.equal(await ledger.updateCategory('food', { isFixed: true }), true);
    assert.equal(await ledger.updateCategory('rent', { isFixed: false }), true);
    assert.deepEqual(await read(), { rent: false, food: true });

    await assert.rejects(ledger.createCategory({ id: 'bad', name: 'Bad', kind: 'expense', isFixed: 'yes' as never }), /isFixed must be a boolean/);
    await assert.rejects(ledger.updateCategory('food', { isFixed: 1 as never }), /isFixed must be a boolean/);
  } finally { fixture.sqlite.close(); }
});

it('upgrades an existing ledger, leaving every category flexible', async () => {
  const fixture = openTestLedger();
  try {
    const before = { ...ledgerMigrations, journal: { ...ledgerMigrations.journal, entries: ledgerMigrations.journal.entries.slice(0, 5) } };
    await createDataLayer(fixture.client, before).migrateLedger();
    fixture.sqlite.exec("INSERT INTO categories (id, name, kind) VALUES ('old', 'Old', 'expense')");
    const ledger = createDataLayer(fixture.client, ledgerMigrations);
    await ledger.migrateLedger();
    assert.equal((await ledger.listCategories())[0]!.isFixed, false);
  } finally { fixture.sqlite.close(); }
});
