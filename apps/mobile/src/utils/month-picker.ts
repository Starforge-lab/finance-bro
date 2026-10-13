export type MonthPickerRow = { month: string; expensePaise: number; entryCount: number };

export function monthPickerRows(rows: readonly MonthPickerRow[], currentMonth: string, selectedMonth: string): MonthPickerRow[] {
  const byMonth = new Map(rows.map((row) => [row.month, row]));
  for (const month of [currentMonth, selectedMonth]) {
    if (!byMonth.has(month)) byMonth.set(month, { month, expensePaise: 0, entryCount: 0 });
  }
  return [...byMonth.values()].sort((left, right) => (left.month < right.month ? 1 : -1));
}
