import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { it } from 'node:test';
import { createDataLayer } from '../src/db/service';
import { DuplicateReviewRequiredError, getFingerprintKeyPolicy } from '../src/imports/key-state';
import { ledgerMigrations, openTestLedger } from './helpers/ledger';
import { FingerprintKeyUnavailableError, type FingerprintKeyProvider, type Fingerprinter } from '../src/imports/fingerprint';
import { importKeyState, smsImportRefs, smsImportState, transactions } from '../src/db/schema';
import { saveManualEntry } from '../src/db/manual';

function signer(key: string): Fingerprinter {
  return {
    keyId: createHmac('sha256', key).update('fixture-key-id').digest('hex'),
    fingerprint: async (text) => createHmac('sha256', key).update(text).digest('hex'),
  };
}
const sms = { sender: 'VM-HDFCBK-S', body: 'INR 450.00 debited from A/c XX1234 to VPA fictional@axisbank (UPI Ref No 612345678901).', receivedAt: Date.parse('2026-10-07T10:00:00Z') };

it('detects key loss, requires duplicate review and preserves corrected/deleted old records', async () => {
  const fixture = openTestLedger();
  let current = signer('fictional-first-key');
  const api = createDataLayer(fixture.client, ledgerMigrations, async () => current);
  try {
    await api.migrateLedger();
    const original = await api.preparePaste(sms);
    assert.equal(original.kind, 'needs-review');
    if (original.kind !== 'needs-review') throw new Error('Review required');
    assert.equal(original.duplicateReviewRequired, false);
    assert.equal(await api.saveReviewedPaste(original), 'inserted');
    await api.editTransaction(original.identity.id, { amountPaise: 47000 });
    assert.equal(await api.saveReviewedPaste(original), 'duplicate');
    await api.softDeleteTransaction(original.identity.id);
    current = signer('fictional-replacement-key');
    const recovered = await api.preparePaste(sms);
    if (recovered.kind !== 'needs-review') throw new Error('Review required');
    assert.equal(recovered.duplicateReviewRequired, true);
    assert.notEqual(recovered.identity.id, original.identity.id);
    current = signer('fictional-third-key');
    await assert.rejects(api.saveReviewedPaste(recovered, {}, { acknowledgeDuplicateRisk: true }), DuplicateReviewRequiredError);
    current = signer('fictional-replacement-key');
    await assert.rejects(api.saveReviewedPaste(recovered), DuplicateReviewRequiredError);
    assert.equal((await api.listTransactions()).length, 0);
    assert.equal(await api.saveReviewedPaste(recovered, {}, { acknowledgeDuplicateRisk: true }), 'inserted');
    await assert.rejects(api.saveReviewedPaste(recovered), DuplicateReviewRequiredError);
    assert.equal(await api.saveReviewedPaste(recovered, {}, { acknowledgeDuplicateRisk: true }), 'duplicate');
    assert.equal((await api.listTransactions()).length, 1);
    assert.equal(await api.getTransaction(original.identity.id), undefined);
  } finally { fixture.sqlite.close(); }
});

it('permits first-use key creation only before any fingerprinted history exists', async () => {
  const cases = ['fresh', 'manual', 'key-state', 'sms-cursor', 'sms-reference', 'imported-tombstone'] as const;
  for (const kind of cases) {
    const fixture = openTestLedger();
    try {
      await fixture.ledger.migrateLedger();
      if (kind === 'manual') {
        await saveManualEntry(fixture.ledger, {
          id: 'manual-only', amountInr: '1.00', direction: 'debit',
          occurredAt: new Date(1_700_000_000_000),
        });
      } else if (kind === 'key-state') {
        await fixture.ledger.db.insert(importKeyState).values({ id: 1, keyId: 'legacy' }).run();
      } else if (kind === 'sms-cursor') {
        await fixture.ledger.db.insert(smsImportState).values({ id: 1, cursorReceivedAt: null, cursorPlatformId: null, keyId: 'legacy' }).run();
      } else if (kind === 'sms-reference') {
        await fixture.ledger.db.insert(smsImportRefs).values({
          referenceId: 'legacy:legacy',
          platformId: 'legacy', receivedAt: 1, senderHash: 'a'.repeat(64), dedupeKey: `body:${'b'.repeat(64)}`,
          bodyHash: 'c'.repeat(64), keyId: 'legacy', status: 'review', reason: 'unknown_format',
          ruleId: null, ruleVersion: null, transactionId: null, createdAt: 1,
        }).run();
      } else if (kind === 'imported-tombstone') {
        await fixture.ledger.db.insert(transactions).values({
          id: 'deleted-import', amountPaise: 100, direction: 'debit', kind: 'expense', status: 'posted',
          occurredAt: new Date(1_700_000_000_000), source: 'sms', deletedAt: new Date(1_700_000_001_000),
          createdAt: new Date(1_700_000_000_000), updatedAt: new Date(1_700_000_000_000),
        }).run();
      }

      assert.deepEqual(await getFingerprintKeyPolicy(fixture.ledger), {
        allowCreate: kind === 'fresh' || kind === 'manual',
      }, `${kind} policy`);
    } finally { fixture.sqlite.close(); }
  }
});

it('fails a save after key loss without replacing the key or blocking manual entry', async () => {
  const fixture = openTestLedger();
  let available = true;
  const seenPolicies: boolean[] = [];
  const key = signer('fictional-first-key');
  const provider: FingerprintKeyProvider = async (policy) => {
    seenPolicies.push(policy?.allowCreate ?? false);
    if (!available) throw new FingerprintKeyUnavailableError();
    return key;
  };
  const api = createDataLayer(fixture.client, ledgerMigrations, provider);
  try {
    await api.migrateLedger();
    const prepared = await api.preparePaste(sms);
    if (prepared.kind !== 'needs-review') throw new Error('Review required');
    assert.deepEqual(seenPolicies, [true]);

    available = false;
    await assert.rejects(api.saveReviewedPaste(prepared, {}, { acknowledgeDuplicateRisk: true }), FingerprintKeyUnavailableError);
    assert.deepEqual(seenPolicies, [true, false]);
    assert.equal((await api.listTransactions()).length, 0);

    await api.saveManualEntry({
      id: 'manual-without-import-key', amountInr: '1.25', direction: 'debit',
      occurredAt: new Date(1_700_000_000_000),
    });
    assert.equal((await api.listTransactions()).length, 1);
  } finally { fixture.sqlite.close(); }
});

it('legacy pasted records require manual duplicate review and key errors never fall back to weak fingerprints', async () => {
  const fixture = openTestLedger();
  try {
    await fixture.ledger.migrateLedger();
    fixture.sqlite.exec("INSERT INTO transactions(id,amount_paise,direction,kind,source,occurred_at,created_at,updated_at) VALUES('legacy',100,'debit','expense','paste',1,1,1)");
    const api = createDataLayer(fixture.client, ledgerMigrations, async () => signer('fictional-key'));
    const prepared = await api.preparePaste(sms);
    if (prepared.kind !== 'needs-review') throw new Error('Review required');
    assert.equal(prepared.duplicateReviewRequired, true);
    await assert.rejects(api.saveReviewedPaste(prepared), DuplicateReviewRequiredError);
    const unavailable = createDataLayer(fixture.client, ledgerMigrations, async () => { throw new Error('Key store unavailable'); });
    await assert.rejects(unavailable.preparePaste(sms), /Key store unavailable/);
    assert.equal((await api.listTransactions()).length, 1);
  } finally { fixture.sqlite.close(); }
});
