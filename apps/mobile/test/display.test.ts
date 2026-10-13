import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amountInput, exactMoney, indiaDate, indiaTime, money, parseIndiaDate, parseIndiaDateTime } from '../src/utils/display';

test('exact money keeps every paise, display money drops only zero paise, and dates use the India calendar', () => {
  assert.equal(amountInput(Number.MAX_SAFE_INTEGER), '90071992547409.91');
  assert.equal(money(Number.MAX_SAFE_INTEGER), '₹9,00,71,99,25,47,409.91');
  assert.equal(money(-1), '−₹0.01');
  assert.equal(money(0), '₹0');
  assert.equal(money(1_113_400), '₹11,134');
  assert.equal(money(13_950), '₹139.50');
  assert.equal(money(-50_000), '−₹500');
  assert.equal(exactMoney(0), '₹0.00');
  assert.equal(exactMoney(1_113_400), '₹11,134.00');
  assert.throws(() => money(0.1), RangeError);
  assert.equal(indiaDate(new Date('2026-09-30T18:30:00Z')), '2026-10-01');
  assert.equal(parseIndiaDate('2024-02-29').toISOString(), '2024-02-28T18:30:00.000Z');
  assert.equal(parseIndiaDate('2026-10-02', new Date('2026-10-01T10:20:30.123Z')).toISOString(), '2026-10-02T10:20:30.123Z');
  assert.equal(indiaTime(new Date('2026-10-07T10:00:45.000Z')), '15:30:45');
  assert.equal(parseIndiaDateTime('2026-10-07', '15:30:45').toISOString(), '2026-10-07T10:00:45.000Z');
  assert.throws(() => parseIndiaDateTime('2026-10-07', '24:00:00'), TypeError);
  assert.throws(() => parseIndiaDateTime('2026-02-29', '10:00:00'), TypeError);
  assert.throws(() => parseIndiaDate('2026-02-29'), TypeError);
  assert.throws(() => parseIndiaDate('0000-01-01'), TypeError);
});
