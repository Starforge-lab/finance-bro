import assert from 'node:assert/strict';
import { it } from 'node:test';
import { emptyInbox, finishLinked, LINKED_SMS_LIMIT, receiveLinked } from '../src/utils/linked-sms';

it('refuses an oversized linked message instead of trimming it', () => {
  // A failure note past the limit must not be cut off and leave a message that reads as a completed payment.
  const body = `INR 450.00 debited from A/c XX1234.${' '.repeat(LINKED_SMS_LIMIT)}Transaction failed`;
  const inbox = receiveLinked(emptyInbox, body, false);
  assert.strictEqual(inbox.rejected, true);
  assert.strictEqual(inbox.open, undefined);
  assert.deepStrictEqual(inbox.queue, []);
});

it('opens a linked message unaltered when no form is open', () => {
  const body = 'x'.repeat(LINKED_SMS_LIMIT);
  assert.strictEqual(receiveLinked(emptyInbox, body, false).open, body);
});

it('queues a message that arrives while a form is open and shows it after the form closes', () => {
  const reviewing = receiveLinked(emptyInbox, 'first', false);
  const waiting = receiveLinked(receiveLinked(reviewing, 'second', true), 'third', true);
  assert.strictEqual(waiting.open, 'first');
  assert.strictEqual(waiting.seq, reviewing.seq);
  const next = finishLinked(waiting);
  assert.strictEqual(next.open, 'second');
  assert.notStrictEqual(next.seq, waiting.seq);
  assert.strictEqual(finishLinked(next).open, 'third');
  assert.strictEqual(finishLinked(finishLinked(next)).open, undefined);
});
