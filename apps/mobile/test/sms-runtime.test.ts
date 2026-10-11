import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { it } from 'node:test';
import { ledgerMigrations, openTestLedger } from './helpers/ledger';
import { runSmsRuntimeCheck } from './sms-runtime-check';

it('hands a fictional SMS bridge record through the parser to correction-safe SQLite', async () => {
  const fixture = openTestLedger();
  try {
    const report = await runSmsRuntimeCheck(fixture.client, ledgerMigrations, {
      keyId: 'a'.repeat(64),
      async fingerprint(value) {
        return createHmac('sha256', 'fictional-sms-probe-key').update(value).digest('hex');
      },
    });
    assert.equal(report.passed, true);
    assert.equal(report.checks.length, 7);
  } finally {
    fixture.sqlite.close();
  }
});
