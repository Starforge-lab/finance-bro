import assert from 'node:assert/strict';
import { it } from 'node:test';
import { toggleCategoryFilter } from '../src/utils/category-filter';

it('distinguishes the uncategorized filter from all categories and clears it on a second tap', () => {
  const uncategorized = toggleCategoryFilter(undefined, null);
  assert.strictEqual(uncategorized, null);
  assert.strictEqual(toggleCategoryFilter(uncategorized, null), undefined);
});
