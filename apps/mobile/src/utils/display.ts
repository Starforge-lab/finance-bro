const indiaOffset = 330 * 60 * 1000;
const rupees = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export function amountInput(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new RangeError('Amount must be safe integer paise');
  const value = BigInt(paise);
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

/** Every paise, always: entry detail, forms and anywhere the exact amount is the point. */
export function exactMoney(paise: number): string {
  const [whole, fraction] = amountInput(paise).split('.');
  // Whole rupees fit a safe Number; Hermes Intl does not accept BigInt.
  return `${paise < 0 ? '−' : ''}₹${rupees.format(Number(whole!.replace('-', '')))}.${fraction}`;
}

/** Display money: whole rupees, with paise only when there are some (₹236, ₹139.50). */
export function money(paise: number): string {
  const exact = exactMoney(paise);
  return exact.endsWith('.00') ? exact.slice(0, -3) : exact;
}

export function indiaDate(date: Date = new Date()): string {
  return new Date(date.getTime() + indiaOffset).toISOString().slice(0, 10);
}

export function indiaTime(date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError('Time is invalid');
  return new Date(date.getTime() + indiaOffset).toISOString().slice(11, 19);
}

export function parseIndiaDateTime(dateText: string, timeText: string): Date {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(timeText)) {
    throw new TypeError('Enter the time as HH:MM:SS');
  }
  const date = parseIndiaDate(dateText);
  const [hours, minutes, seconds] = timeText.split(':').map(Number);
  return new Date(date.getTime() + (hours! * 60 * 60 + minutes! * 60 + seconds!) * 1_000);
}

export function parseIndiaDate(input: string, preserveTimeFrom?: Date): Date {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(input)) throw new TypeError('Enter a date as YYYY-MM-DD');
  const date = new Date(`${input}T00:00:00+05:30`);
  if (!Number.isFinite(date.getTime()) || indiaDate(date) !== input) throw new TypeError('Enter a valid calendar date');
  if (!preserveTimeFrom) return date;
  const source = preserveTimeFrom.getTime();
  if (!Number.isFinite(source)) throw new TypeError('Original time is invalid');
  const day = 24 * 60 * 60 * 1000;
  const clock = ((source + indiaOffset) % day + day) % day;
  return new Date(date.getTime() + clock);
}
