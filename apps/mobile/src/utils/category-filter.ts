export type CategoryFilter = string | null | undefined;

/** Undefined means all categories; null is the uncategorized category. */
export function toggleCategoryFilter(current: CategoryFilter, categoryId: string | null): CategoryFilter {
  return current === categoryId ? undefined : categoryId;
}
