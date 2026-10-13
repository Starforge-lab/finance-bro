import assert from 'node:assert/strict';
import { it } from 'node:test';
import { monthPickerRows } from '../src/utils/month-picker';
import { shiftMonth } from '../src/utils/month-pace';

it('keeps the current and viewed empty months selectable alongside entry months', () => {
  assert.deepEqual(monthPickerRows([
    { month: '2026-09', expensePaise: 1_200, entryCount: 2 },
  ], '2026-10', '2026-08'), [
    { month: '2026-10', expensePaise: 0, entryCount: 0 },
    { month: '2026-09', expensePaise: 1_200, entryCount: 2 },
    { month: '2026-08', expensePaise: 0, entryCount: 0 },
  ]);
});

it('steps across year and lower supported year boundaries', () => {
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('0001-02', -1), '0001-01');
});
