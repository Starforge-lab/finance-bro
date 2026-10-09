import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createDataLayer } from '../src/db/service';
import { ledgerMigrations, openTestLedger } from './helpers/ledger';

it('remembers the theme choice, follows the system by default, and rejects unknown values', async () => {
  const fixture = openTestLedger();
  const ledger = createDataLayer(fixture.client, ledgerMigrations);
  try {
    await ledger.migrateLedger();
    assert.equal(await ledger.getThemePreference(), 'system');
    await ledger.setThemePreference('dark');
    await ledger.setThemePreference('light');
    assert.equal(await ledger.getThemePreference(), 'light');
    await assert.rejects(ledger.setThemePreference('sepia' as never), /theme must be one of/);
    // A value written by some other build is ignored rather than trusted.
    fixture.sqlite.exec("UPDATE preferences SET value = 'sepia' WHERE key = 'theme'");
    assert.equal(await ledger.getThemePreference(), 'system');
  } finally { fixture.sqlite.close(); }
});
