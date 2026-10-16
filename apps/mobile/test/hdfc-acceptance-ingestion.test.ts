/// <reference types="node" />

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseSms, type ParseResult } from '@finance-bro/sms-parser';
import { createDataLayer } from '../src/db/service';
import type { LedgerSQLiteTransactionRunner } from '../src/db/ledger';
import { smsImportRefs, transactions } from '../src/db/schema';
import type { FingerprintKeyProvider } from '../src/imports/fingerprint';
import { ledgerMigrations, openTestLedger } from './helpers/ledger';

type HdfcAcceptanceCase = {
  name: string;
  source: 'user-observed-shape' | 'synthetic';
  label: 'hdfc-high' | 'not-hdfc-high';
  expectedClassification: string;
  sender: string;
  body: string;
  receivedAt: string;
  expectedTxn?: {
    amountPaise: number;
    accountLast4: string;
    vpa: string;
    upiRef: string;
  };
  expectedOccurredAt?: string;
};

type HdfcAcceptanceCorpus = {
  corpus: 'hdfc-credit-v1';
  ruleId: 'hdfc.upi.credit';
  ruleVersion: 1;
  cases: HdfcAcceptanceCase[];
};

const acceptanceCorpus = JSON.parse(readFileSync(
  join(process.cwd(), '../../packages/sms-parser/fixtures/acceptance/hdfc-credit-v1.json'),
  'utf8',
)) as HdfcAcceptanceCorpus;
const fictionalKey = 'fictional-hdfc-acceptance-fingerprint-key-v1';
const keyId = createHmac('sha256', fictionalKey).update('fictional-key-id').digest('hex');
const fingerprints: FingerprintKeyProvider = async () => ({
  keyId,
  fingerprint: async (value) => createHmac('sha256', fictionalKey).update(value).digest('hex'),
});

function parsedAccountLast4(parsed: ParseResult): string | null {
  if (parsed.kind === 'transaction') return parsed.txn.accountLast4;
  if (parsed.kind === 'review') return parsed.candidate?.accountLast4 ?? null;
  return null;
}

describe('frozen HDFC v1 acceptance corpus through SMS ingestion', () => {
  it('keeps the frozen corpus at six high labels and 47 negative labels', () => {
    assert.equal(acceptanceCorpus.corpus, 'hdfc-credit-v1');
    assert.equal(acceptanceCorpus.ruleId, 'hdfc.upi.credit');
    assert.equal(acceptanceCorpus.ruleVersion, 1);
    assert.equal(acceptanceCorpus.cases.length, 53);
    assert.equal(acceptanceCorpus.cases.filter((entry) => entry.label === 'hdfc-high').length, 6);
    assert.equal(acceptanceCorpus.cases.filter((entry) => entry.label === 'not-hdfc-high').length, 47);
  });

  for (const [index, acceptanceCase] of acceptanceCorpus.cases.entries()) {
    it(`${String(index + 1).padStart(2, '0')}: ${acceptanceCase.name}`, async () => {
      const fixture = openTestLedger();
      try {
        const runTransaction: LedgerSQLiteTransactionRunner = (task) =>
          fixture.client.withTransactionAsync(() => task(fixture.client));
        const api = createDataLayer(fixture.client, ledgerMigrations, fingerprints, runTransaction);
        await api.migrateLedger();

        const receivedAt = Date.parse(acceptanceCase.receivedAt);
        assert.ok(Number.isSafeInteger(receivedAt) && receivedAt > 0, `${acceptanceCase.name}: fixture receipt time`);
        const source = {
          sender: acceptanceCase.sender,
          body: acceptanceCase.body,
          receivedAt,
        };
        const parsed = parseSms(source);
        const extractedLast4 = parsedAccountLast4(parsed);
        const bodyAccountMatch = /A\/c XX(\d{4})\b/.exec(acceptanceCase.body);
        const bodyLast4 = bodyAccountMatch?.[1] ?? null;

        if (acceptanceCase.expectedTxn) {
          assert.ok(bodyLast4, `${acceptanceCase.name}: expected account suffix in source body`);
          assert.equal(bodyLast4, acceptanceCase.expectedTxn.accountLast4, `${acceptanceCase.name}: fixture account suffix`);
          assert.equal(extractedLast4, acceptanceCase.expectedTxn.accountLast4, `${acceptanceCase.name}: parsed account suffix`);
        }

        const seededLast4s = new Set<string>();
        const addFictionalBank = async (last4: string) => {
          if (!/^\d{4}$/.test(last4) || seededLast4s.has(last4)) return;
          seededLast4s.add(last4);
          await api.createAccount({
            id: `hdfc-acceptance-${index + 1}-${last4}`,
            name: `Fictional HDFC ${last4}`,
            institution: 'HDFC Bank',
            type: 'bank',
            last4,
          });
        };
        if (bodyLast4) await addFictionalBank(bodyLast4);
        if (extractedLast4) await addFictionalBank(extractedLast4);

        const row = { ...source, platformId: String(index + 1) };
        const imported = await api.importSmsBatch([row], null);
        assert.deepEqual(imported.cursor, { receivedAt, platformId: row.platformId }, acceptanceCase.name);
        const refRows = await fixture.ledger.db.select().from(smsImportRefs).all();
        const transactionRows = await fixture.ledger.db.select().from(transactions).all();
        const resultIsHigh = acceptanceCase.label === 'hdfc-high';

        if (resultIsHigh) {
          const expected = acceptanceCase.expectedTxn;
          assert.ok(expected, `${acceptanceCase.name}: high label requires frozen transaction expectations`);
          assert.equal(imported.inserted, 1, acceptanceCase.name);
          assert.equal(imported.duplicate, 0, acceptanceCase.name);
          assert.equal(imported.review, 0, acceptanceCase.name);
          assert.equal(imported.ignored, 0, acceptanceCase.name);
          assert.equal(refRows.length, 1, acceptanceCase.name);
          assert.equal(transactionRows.length, 1, acceptanceCase.name);

          const reference = refRows[0]!;
          const transaction = transactionRows[0]!;
          assert.equal(reference.status, 'saved', acceptanceCase.name);
          assert.equal(reference.reason, null, acceptanceCase.name);
          assert.equal(reference.ruleId, acceptanceCorpus.ruleId, acceptanceCase.name);
          assert.equal(reference.ruleVersion, acceptanceCorpus.ruleVersion, acceptanceCase.name);
          assert.equal(reference.platformId, row.platformId, acceptanceCase.name);
          assert.equal(reference.receivedAt, receivedAt, acceptanceCase.name);
          assert.equal(reference.transactionId, transaction.id, acceptanceCase.name);
          assert.equal(transaction.amountPaise, expected.amountPaise, acceptanceCase.name);
          assert.equal(transaction.direction, 'credit', acceptanceCase.name);
          assert.equal(transaction.kind, 'income', acceptanceCase.name);
          assert.equal(transaction.status, 'posted', acceptanceCase.name);
          assert.ok(acceptanceCase.expectedOccurredAt, `${acceptanceCase.name}: frozen transaction date`);
          assert.equal(transaction.occurredAt.getTime(), Date.parse(acceptanceCase.expectedOccurredAt), acceptanceCase.name);
          assert.equal(transaction.accountId, `hdfc-acceptance-${index + 1}-${expected.accountLast4}`, acceptanceCase.name);
          assert.equal(transaction.upiRef, expected.upiRef, acceptanceCase.name);
          assert.equal(transaction.smsRefId, `android-sms:${reference.referenceId}`, acceptanceCase.name);
          assert.equal(transaction.source, 'sms', acceptanceCase.name);
          assert.equal(transaction.ruleId, acceptanceCorpus.ruleId, acceptanceCase.name);
          assert.equal(transaction.ruleVersion, acceptanceCorpus.ruleVersion, acceptanceCase.name);
        } else {
          assert.equal(imported.inserted, 0, acceptanceCase.name);
          assert.equal(imported.duplicate, 0, acceptanceCase.name);
          assert.equal(imported.review + imported.ignored, 1, acceptanceCase.name);
          assert.equal(transactionRows.length, 0, acceptanceCase.name);
          if (imported.review === 1) {
            assert.equal(refRows.length, 1, acceptanceCase.name);
            assert.equal(refRows[0]?.status, 'review', acceptanceCase.name);
            assert.equal(refRows[0]?.transactionId, null, acceptanceCase.name);
          } else {
            assert.equal(refRows.length, 0, acceptanceCase.name);
          }
        }

        const referenceColumns = fixture.sqlite.prepare('PRAGMA table_info(sms_import_refs)').all() as { name: string }[];
        assert.equal(referenceColumns.some((column) => column.name === 'body'), false, `${acceptanceCase.name}: no raw body column`);
        assert.equal(referenceColumns.some((column) => column.name === 'sender'), false, `${acceptanceCase.name}: no raw sender column`);
        for (const reference of refRows) {
          assert.equal(Object.prototype.hasOwnProperty.call(reference, 'body'), false, `${acceptanceCase.name}: no raw body on reference`);
          assert.equal(Object.prototype.hasOwnProperty.call(reference, 'sender'), false, `${acceptanceCase.name}: no raw sender on reference`);
        }

        const replay = await api.importSmsBatch([row], imported.cursor, { replayAfter: null });
        assert.equal(replay.inserted, 0, `${acceptanceCase.name}: replay does not create a transaction`);
        assert.equal(replay.review, 0, `${acceptanceCase.name}: replay does not create another review`);
        if (resultIsHigh || imported.review === 1) {
          assert.equal(replay.duplicate, 1, `${acceptanceCase.name}: replay is linked to its original import`);
          assert.equal(replay.ignored, 0, `${acceptanceCase.name}: replay remains imported`);
        } else {
          assert.equal(replay.duplicate, 0, `${acceptanceCase.name}: ignored replay has no saved reference`);
          assert.equal(replay.ignored, 1, `${acceptanceCase.name}: ignored replay remains ignored`);
        }
        assert.equal((await fixture.ledger.db.select().from(smsImportRefs).all()).length, refRows.length, `${acceptanceCase.name}: replay keeps one reference`);
        assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, transactionRows.length, `${acceptanceCase.name}: replay keeps one ledger state`);
      } finally {
        fixture.sqlite.close();
      }
    });
  }
});