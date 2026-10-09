import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useColorScheme } from '@/hooks/appearance';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon, categoryIcon } from '@/components/icon';
import { MonthPicker } from '@/components/ledger-controls';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Fonts, Radius, Spacing, Stroke, Type } from '@/constants/theme';
import { getLedger, type DataLayer } from '@/db';
import { useTheme } from '@/hooks/use-theme';
import { indiaDate, money, parseIndiaDate } from '@/utils/display';

type Summary = Awaited<ReturnType<DataLayer['getMonthlySummary']>>;
type Transaction = Awaited<ReturnType<DataLayer['listTransactions']>>[number];
type Bill = Awaited<ReturnType<DataLayer['listBills']>>[number];
type Merchant = { key: string; name: string; amountPaise: bigint; count: number };

const monthNames = new Intl.DateTimeFormat('en-IN', { month: 'long', timeZone: 'Asia/Kolkata' });
const shortMonthNames = new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'Asia/Kolkata' });

function shiftMonth(value: string, offset: number): string | null {
  const [year, month] = value.split('-').map(Number);
  const index = (year! - 1) * 12 + month! - 1 + offset;
  const nextYear = Math.floor(index / 12) + 1;
  if (nextYear < 1 || nextYear > 9999) return null;
  return `${String(nextYear).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`;
}

function monthDate(value: string) {
  return parseIndiaDate(`${value}-01`);
}

function monthLabel(value: string) {
  return monthNames.format(monthDate(value));
}

/** Short rupees for chart labels (₹840, ₹21.9k, ₹1.2L). Hermes has no compact Intl notation, so it's done by hand. */
function compactMoney(paise: number) {
  const rupees = Math.abs(paise) / 100;
  const sign = paise < 0 ? '−' : '';
  const short = (value: number, unit: string) => `${Number(value.toFixed(value < 10 ? 1 : 0))}${unit}`;
  if (rupees >= 100_000) return `${sign}₹${short(rupees / 100_000, 'L')}`;
  if (rupees >= 1_000) return `${sign}₹${short(rupees / 1_000, 'k')}`;
  return `${sign}₹${Math.round(rupees)}`;
}

/** Display money for bigint totals: whole rupees, paise only when there are some. */
function bigMoney(paise: bigint) {
  const absolute = paise < 0n ? -paise : paise;
  const whole = (absolute / 100n).toString();
  const grouped = whole.length <= 3
    ? whole
    : `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}`;
  const fraction = absolute % 100n;
  return `${paise < 0n ? '−' : ''}₹${grouped}${fraction ? `.${String(fraction).padStart(2, '0')}` : ''}`;
}

function merchantRows(rows: Transaction[]): Merchant[] {
  const groups = new Map<string, Merchant>();
  for (const row of rows) {
    if (row.status !== 'posted' || row.excludeFromStats) continue;
    const sign = row.direction === 'debit' && row.kind === 'expense'
      ? 1n
      : row.direction === 'credit' && (row.kind === 'refund' || row.kind === 'reversal') ? -1n : 0n;
    const name = row.counterparty?.trim();
    if (sign === 0n || !name) continue;
    const key = row.merchantId ? `id:${row.merchantId}` : `name:${name.toLocaleLowerCase('en-IN')}`;
    const merchant = groups.get(key) ?? { key, name, amountPaise: 0n, count: 0 };
    merchant.amountPaise += sign * BigInt(row.amountPaise);
    merchant.count++;
    groups.set(key, merchant);
  }
  return [...groups.values()]
    .filter((merchant) => merchant.amountPaise > 0n)
    .sort((left, right) => left.amountPaise === right.amountPaise ? left.name.localeCompare(right.name)
      : left.amountPaise > right.amountPaise ? -1 : 1)
    .slice(0, 5);
}

function dueLabel(value: string) {
  const date = parseIndiaDate(value);
  return {
    day: new Intl.DateTimeFormat('en-IN', { day: 'numeric', timeZone: 'Asia/Kolkata' }).format(date),
    month: shortMonthNames.format(date),
    full: new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(date),
  };
}

export function Insights() {
  const colors = useTheme();
  const dark = useColorScheme() === 'dark';
  const [month, setMonth] = useState(() => indiaDate().slice(0, 7));
  const [history, setHistory] = useState<Summary[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [totalsOpen, setTotalsOpen] = useState(false);

  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    void getLedger().then(async (ledger) => {
      const months = Array.from({ length: 6 }, (_, index) => shiftMonth(month, index - 5))
        .filter((value): value is string => value !== null);
      const [summaries, entries, upcoming] = await Promise.all([
        Promise.all(months.map((value) => ledger.getMonthlySummary(value))),
        ledger.listTransactions({ month }),
        ledger.listBills(indiaDate()),
      ]);
      if (!active) return;
      setHistory(summaries);
      setTransactions(entries);
      setBills(upcoming.filter((bill) => bill.status === 'upcoming'));
    }).catch(() => {
      if (active) setFailed(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
    // Retry reloads the currently selected period.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, revision]));

  const summary = history.find((item) => item.month === month);
  const merchants = useMemo(() => merchantRows(transactions), [transactions]);
  const maxMerchant = merchants[0]?.amountPaise ?? 1n;
  const largestCategory = summary?.categories
    .filter((category) => category.expensePaise > 0)
    .sort((left, right) => right.expensePaise - left.expensePaise)[0];
  const previousMonth = history.length > 1 ? history[history.length - 2] : undefined;
  // Months before the ledger has any spending would drag the average toward zero.
  const recorded = history.filter((item) => item.expensePaise !== 0);
  const historyTotal = recorded.reduce((total, item) => total + BigInt(item.expensePaise), 0n);
  const divisor = BigInt(Math.max(1, recorded.length));
  const averagePaise = Number((historyTotal + (historyTotal < 0n ? -divisor / 2n : divisor / 2n)) / divisor);
  const averageY = averagePosition(history, averagePaise);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.header}>
            <ThemedText style={Type.screenTitle}>Insights</ThemedText>
            <MonthPicker month={month} onChange={setMonth} />
          </View>

          {loading ? (
            <View accessibilityRole="progressbar" accessibilityLabel="Loading recorded insights" style={styles.state}>
              <ThemedText style={Type.body}>Loading your recorded month…</ThemedText>
            </View>
          ) : failed || !summary ? (
            <View accessibilityLiveRegion="polite" style={styles.state}>
              <ThemedText style={Type.body}>Your recorded insights could not be loaded. Your ledger has not been reset.</ThemedText>
              <Pressable accessibilityRole="button" onPress={() => setRevision((value) => value + 1)}
                style={[styles.pill, { backgroundColor: colors.backgroundElement, borderColor: colors.border }]}>
                <ThemedText style={[Type.body, { fontFamily: Fonts.sansSemiBold }]}>Retry summary</ThemedText>
              </Pressable>
            </View>
          ) : (
            <>
              <View style={[styles.hero, { backgroundColor: colors.heroBackground }]}>
                <ThemedText style={[Type.body, { color: colors.heroText }]}>
                  {summary.expensePaise < 0 ? 'Refunds exceed spending by' : 'You’ve spent'}
                </ThemedText>
                <ThemedText adjustsFontSizeToFit minimumFontScale={0.7} numberOfLines={1}
                  style={[Type.amountHero, styles.heroAmount, { color: colors.heroText }]}>
                  {money(Math.abs(summary.expensePaise))}
                </ThemedText>
                <View style={[styles.heroStats, { borderColor: colors.heroRule }]}>
                  <HeroStat label="In" amount={money(summary.incomePaise)} colors={colors} />
                  <HeroStat label="Out" amount={money(summary.expensePaise)} colors={colors} />
                  <HeroStat label={summary.netPaise < 0 ? 'Net' : 'Kept'} amount={money(summary.netPaise)} colors={colors} highlight dark={dark} />
                </View>
              </View>

              <>
                <View style={styles.section}>
                  <View style={styles.sectionHeading}>
                    <ThemedText style={Type.sectionTitle}>Six months</ThemedText>
                    <ThemedText style={Type.amountSmall}>avg {compactMoney(averagePaise)}</ThemedText>
                  </View>
                  <View style={styles.chart} accessibilityLabel="Recorded monthly spending over the last six months">
                    <View pointerEvents="none" style={[styles.averageRule, { top: averageY, borderColor: colors.textMuted }]} />
                    {history.map((item) => (
                      <MonthBar key={item.month} summary={item} selected={item.month === month}
                        colors={colors} dark={dark} positiveScale={Math.max(1, ...history.map((value) => value.expensePaise))}
                        negativeScale={Math.max(1, ...history.map((value) => -value.expensePaise))} />
                    ))}
                  </View>
                </View>

                <View style={styles.section}>
                  <ThemedText style={Type.sectionTitle}>Worth knowing</ThemedText>
                  {largestCategory ? <View style={[styles.insightCard, cardDepth(dark, colors.shadow), { backgroundColor: colors.backgroundElement, borderColor: colors.border }]}>
                    <View style={styles.insightTitle}>
                      <Icon name={categoryIcon(largestCategory.categoryName)} size={22} color={colors.text} />
                      <ThemedText style={[Type.rowTitle, styles.grow]}>{largestCategory.categoryName ?? 'Uncategorized'} leads</ThemedText>
                      <ThemedText style={Type.amountSmall}>{money(largestCategory.expensePaise)}</ThemedText>
                    </View>
                    <ThemedText style={[Type.note, { color: colors.textSecondary }]}>
                      {previousMonth ? `${monthLabel(previousMonth.month)}: ${money(previousMonth.categories.find((item) => item.categoryId === largestCategory.categoryId)?.expensePaise ?? 0)}` : 'No earlier month to compare'}
                    </ThemedText>
                  </View> : <ThemedText style={[Type.body, { color: colors.textSecondary }]}>No posted category spending to compare.</ThemedText>}
                </View>

                <View style={styles.section}>
                  <ThemedText style={Type.sectionTitle}>Top merchants</ThemedText>
                  {merchants.length ? merchants.map((merchant, index) => (
                    <View key={merchant.key} style={[styles.merchantRow, index > 0 && { borderTopColor: colors.rule, borderTopWidth: Stroke.hairline }]}>
                      <ThemedText style={[Type.amount, styles.rank, { color: index === 0 ? colors.text : colors.textMuted }]}>{index + 1}</ThemedText>
                      <View style={styles.merchantInfo}>
                        <View style={styles.merchantHeading}>
                          <ThemedText numberOfLines={1} style={[Type.rowTitle, styles.merchantName]}>{merchant.name}</ThemedText>
                          <ThemedText style={[Type.label, { color: colors.textSecondary }]}>×{merchant.count}</ThemedText>
                        </View>
                        <View style={[styles.merchantTrack, { backgroundColor: colors.track }]}>
                          <View style={[styles.merchantFill, { width: `${Number(merchant.amountPaise * 100n / maxMerchant)}%`, backgroundColor: colors.fill }]} />
                        </View>
                      </View>
                      <ThemedText adjustsFontSizeToFit minimumFontScale={0.7} numberOfLines={1} style={Type.amountSmall}>{bigMoney(merchant.amountPaise)}</ThemedText>
                    </View>
                  )) : <ThemedText style={[Type.body, { color: colors.textSecondary }]}>No named merchants in this month’s posted spending.</ThemedText>}
                </View>

                <View style={styles.section}>
                  <View style={styles.sectionHeading}>
                    <ThemedText style={Type.sectionTitle}>Coming up</ThemedText>
                    <ThemedText style={Type.amountSmall}>{bills.length} {bills.length === 1 ? 'reminder' : 'reminders'}</ThemedText>
                  </View>
                  {bills.length ? bills.map((bill, index) => (
                    <BillRow key={bill.id} bill={bill} colors={colors} first={index === 0} />
                  )) : <ThemedText style={[Type.body, { color: colors.textSecondary }]}>No unpaid future bill reminders.</ThemedText>}
                </View>
              </>

              <Disclosure label="How totals work" expanded={totalsOpen} onPress={() => setTotalsOpen((open) => !open)} colors={colors} />
              {totalsOpen && <ThemedText style={[Type.note, styles.rules, { color: colors.textSecondary }]}>
                India calendar months. Posted debit expenses count as spending and posted credit income as income. A posted credit refund or reversal reduces spending in its receipt month. Transfers, cash withdrawals, pending, failed, deleted, and excluded entries are omitted. These totals show recorded cash flow, not balance or forecast.
              </ThemedText>}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

function Disclosure({ label, expanded, onPress, colors }: {
  label: string; expanded: boolean; onPress: () => void; colors: ReturnType<typeof useTheme>;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded }} aria-expanded={expanded} onPress={onPress}
      style={({ pressed }) => [styles.disclosure, { borderColor: colors.rule, opacity: pressed ? 0.7 : 1 }]}>
      <ThemedText style={Type.rowTitle}>{label}</ThemedText>
      <View style={[styles.chevron, { borderColor: colors.text }, expanded && styles.chevronOpen]} />
    </Pressable>
  );
}

function HeroStat({ label, amount, colors, highlight = false, dark = false }: {
  label: string; amount: string; colors: ReturnType<typeof useTheme>; highlight?: boolean; dark?: boolean;
}) {
  const highlightedText = highlight ? dark ? colors.onAccent : colors.accent : colors.heroText;
  return (
    <View style={styles.heroStat}>
      <ThemedText style={[Type.label, { color: highlight && !dark ? colors.accent : colors.heroTextSecondary }]}>{label}</ThemedText>
      <ThemedText adjustsFontSizeToFit minimumFontScale={0.72} numberOfLines={1}
        style={[Type.amountSmall, styles.heroStatAmount, { color: highlightedText }, highlight && dark && styles.keptChip, highlight && dark && { backgroundColor: colors.accent }]}>
        {amount}
      </ThemedText>
    </View>
  );
}

function MonthBar({ summary, selected, colors, dark, positiveScale, negativeScale }: {
  summary: Summary; selected: boolean; colors: ReturnType<typeof useTheme>; dark: boolean; positiveScale: number; negativeScale: number;
}) {
  const historyValue = summary.expensePaise;
  const baseline = 91;
  const positiveHeight = historyValue > 0 ? Math.max(3, historyValue / positiveScale * 72) : 3;
  const negativeHeight = historyValue < 0 ? Math.max(3, -historyValue / negativeScale * 14) : 0;
  const monthValue = parseInt(summary.month.slice(5), 10);
  const date = monthDate(summary.month);
  const label = monthNames.format(date);
  const currentYear = summary.month.slice(0, 4);
  const monthText = `${shortMonthNames.format(date)}${monthValue === 1 ? ` ${currentYear}` : ''}`;
  const barHeight = historyValue < 0 ? negativeHeight : positiveHeight;
  const barTop = historyValue < 0 ? baseline : baseline - barHeight;
  const valueTop = historyValue < 0 ? baseline + negativeHeight + 1 : Math.max(0, barTop - 17);
  return <View accessible accessibilityLabel={`${label} ${currentYear}: ${money(historyValue)} recorded net spending`} style={styles.monthColumn}>
    <ThemedText numberOfLines={1} style={[Type.amountSmall, styles.chartValue, { top: valueTop, color: colors.textSecondary }]}>{compactMoney(historyValue)}</ThemedText>
    <View style={[styles.bar, {
      top: barTop,
      height: barHeight,
      backgroundColor: selected ? colors.accent : dark ? colors.backgroundSelected : colors.backgroundElement,
      borderColor: colors.border,
    }]} />
    <ThemedText numberOfLines={1} style={[Type.label, styles.monthName, selected && { fontFamily: Fonts.sansHeavy, color: colors.text }]}>{monthText}</ThemedText>
  </View>;
}

function averagePosition(history: Summary[], averagePaise: number) {
  const positiveMax = Math.max(1, ...history.map((item) => item.expensePaise));
  const negativeMax = Math.max(1, ...history.map((item) => -item.expensePaise));
  return averagePaise < 0
    ? 91 + Math.min(1, -averagePaise / negativeMax) * 14
    : 91 - Math.min(1, averagePaise / positiveMax) * 72;
}

function cardDepth(dark: boolean, shadow: string) {
  return dark ? {} : { shadowColor: shadow, shadowOffset: { width: 3, height: 4 }, shadowOpacity: 1, shadowRadius: 0, elevation: 0 };
}

function BillRow({ bill, colors, first }: { bill: Bill; colors: ReturnType<typeof useTheme>; first: boolean }) {
  const due = dueLabel(bill.dueDate);
  return (
    <View style={[styles.billRow, !first && { borderTopColor: colors.rule, borderTopWidth: Stroke.hairline }]}>
      <View style={[styles.dateTile, { borderColor: colors.border, backgroundColor: colors.backgroundElement }]}>
        <ThemedText style={[Type.amountSmall, styles.dateDay]}>{due.day}</ThemedText>
        <ThemedText style={Type.label}>{due.month}</ThemedText>
      </View>
      <View style={styles.billDescription}>
        <ThemedText numberOfLines={1} style={Type.rowTitle}>{bill.label}</ThemedText>
        <ThemedText style={[Type.note, { color: colors.textSecondary }]}>{due.full}</ThemedText>
      </View>
      <ThemedText style={Type.amountSmall}>{money(bill.amountPaise)}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 }, safe: { flex: 1 },
  content: { paddingHorizontal: Spacing.gutter, paddingTop: 52, paddingBottom: Spacing.tabBarClearance, gap: Spacing.section, width: '100%', maxWidth: 520, alignSelf: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: Spacing.two },
  state: { gap: Spacing.three }, pill: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: Spacing.three, borderWidth: Stroke.ink, borderRadius: Radius.pill },
  hero: { padding: 22, borderRadius: Radius.hero, gap: Spacing.two },
  heroAmount: { marginTop: 2 },
  heroStats: { flexDirection: 'row', marginTop: Spacing.two, paddingTop: Spacing.three, borderTopWidth: Stroke.hairline, gap: Spacing.two },
  heroStat: { flex: 1, minWidth: 0, gap: Spacing.two },
  heroStatAmount: { flexShrink: 1 }, keptChip: { alignSelf: 'flex-start', paddingHorizontal: 4, borderRadius: 4 },
  section: { gap: 12 }, sectionHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: Spacing.two },
  chart: { height: 132, flexDirection: 'row', alignItems: 'stretch', gap: Spacing.one, position: 'relative' },
  averageRule: { position: 'absolute', left: 0, right: 0, borderTopWidth: 1.5, borderStyle: 'dashed', zIndex: 1 },
  monthColumn: { flex: 1, minWidth: 0, position: 'relative', alignItems: 'center' },
  chartValue: { position: 'absolute', left: -4, right: -4, fontSize: 10, lineHeight: 13, textAlign: 'center', zIndex: 2 },
  bar: { position: 'absolute', left: 0, right: 0, borderWidth: Stroke.ink, borderRadius: Radius.bar },
  monthName: { position: 'absolute', bottom: 0, left: -4, right: -4, textAlign: 'center', fontSize: 10, lineHeight: 13, color: '#8B8E98' },
  disclosure: { minHeight: 52, paddingVertical: Spacing.two, borderTopWidth: Stroke.hairline, borderBottomWidth: Stroke.hairline, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chevron: { width: 9, height: 9, marginRight: 4, borderRightWidth: 2, borderBottomWidth: 2, transform: [{ rotate: '45deg' }] },
  chevronOpen: { transform: [{ rotate: '225deg' }] },
  insightCard: { padding: Spacing.three, borderWidth: Stroke.ink, borderRadius: Radius.card, gap: Spacing.two },
  insightTitle: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grow: { flex: 1, minWidth: 0 },
  rules: { lineHeight: 20 },
  merchantRow: { minHeight: 76, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  rank: { width: 28 }, merchantInfo: { flex: 1, minWidth: 0, gap: Spacing.two },
  merchantHeading: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two }, merchantName: { flex: 1, minWidth: 0 },
  merchantTrack: { height: 5, overflow: 'hidden', borderRadius: Radius.bar }, merchantFill: { height: '100%', borderRadius: Radius.bar },
  billRow: { minHeight: 68, paddingVertical: Spacing.two, flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  dateTile: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderWidth: Stroke.ink, borderRadius: Radius.tile },
  dateDay: { lineHeight: 17 }, billDescription: { flex: 1, minWidth: 0, gap: Spacing.one },
});
