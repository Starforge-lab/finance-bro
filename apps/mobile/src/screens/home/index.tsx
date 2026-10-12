import { useFocusEffect, useRootNavigationState, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useColorScheme } from '@/hooks/appearance';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { Keyframe, useReducedMotion } from 'react-native-reanimated';
import { Icon, accountIcon, categoryIcon, type IconName } from '@/components/icon';
import { LedgerButton, MonthPicker, Segmented } from '@/components/ledger-controls';
import { MonthPaceChart } from '@/components/month-pace-chart';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Categories, Fonts, Motion, Radius, Shadow, Spacing, Type } from '@/constants/theme';
import { getLedger, type DataLayer } from '@/db';
import { useTheme } from '@/hooks/use-theme';
import { exactMoney, indiaDate, money } from '@/utils/display';
import { buildMonthPace, shiftMonth, topCategoryBars } from '@/utils/month-pace';
import { ease, fadeIn } from '@/utils/motion';
import { EntryForm } from './entry-form';
import { PasteForm } from './paste-form';

type Row = Awaited<ReturnType<DataLayer['listTransactions']>>[number];
type Summary = Awaited<ReturnType<DataLayer['getMonthlySummary']>>;
type Category = Awaited<ReturnType<DataLayer['listCategories']>>[number];
type Account = Awaited<ReturnType<DataLayer['listAccounts']>>[number];
type Budget = Awaited<ReturnType<DataLayer['getBudgetSummary']>>[number];

export function Home() {
  const colors = useTheme();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const printed = scheme === 'light' ? { boxShadow: Shadow.card } : undefined;
  const [ledger, setLedger] = useState<DataLayer>();
  const [month, setMonth] = useState(() => indiaDate().slice(0, 7));
  const [rows, setRows] = useState<Row[]>([]);
  const [previousRows, setPreviousRows] = useState<Row[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [summary, setSummary] = useState<Summary>();
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>();
  const [accountId, setAccountId] = useState<string>();
  const [direction, setDirection] = useState<'debit' | 'credit'>();
  const [view, setView] = useState<'Cards' | 'Chart'>('Cards');
  const [filters, setFilters] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const reduceMotion = useReducedMotion();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [mode, setMode] = useState<'feed' | 'entry' | 'paste'>('feed');
  const router = useRouter();
  const navigationState = useRootNavigationState();
  useEffect(() => {
    if (Platform.OS !== 'android' || !navigationState?.key) return;
    router.setParams({ _entryOpen: mode === 'feed' ? '0' : '1' });
  }, [mode, navigationState?.key, router]);
  const [selected, setSelected] = useState<Row>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteGuard = useRef(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true); setError('');
    void getLedger().then(async (data) => {
      const [entries, totals, stamps, bankAccounts, lastMonth, limits] = await Promise.all([
        data.listTransactions({ month }), data.getMonthlySummary(month), data.listCategories(), data.listAccounts(true),
        data.listTransactions({ month: shiftMonth(month, -1) }), data.getBudgetSummary(month),
      ]);
      if (!active) return;
      setLedger(data); setRows(entries); setSummary(totals); setCategories(stamps); setAccounts(bankAccounts);
      setPreviousRows(lastMonth); setBudgets(limits);
    }).catch(() => {
      if (active) setError('Couldn’t load your entries. Try again.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
    // A retry must reload even when the month is unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, revision]));
  function finish() {
    setMode('feed'); setSelected(undefined); setConfirmDelete(false); setError('');
    setRevision((value) => value + 1);
  }
  async function remove() {
    if (!ledger || !selected || deleteGuard.current) return;
    deleteGuard.current = true; setDeleting(true); setError('');
    try {
      if (!await ledger.softDeleteTransaction(selected.id)) throw new Error('Entry unavailable');
      finish();
    } catch { setError('The entry could not be deleted. It is still saved; try again.'); }
    finally { deleteGuard.current = false; setDeleting(false); }
  }
  if (mode !== 'feed' && ledger) {
    return mode === 'entry'
      ? <EntryForm ledger={ledger} transaction={selected} onSaved={finish} onCancel={finish} />
      : <PasteForm ledger={ledger} onSaved={finish} onCancel={finish} />;
  }
  const today = rows.filter((row) => indiaDate(row.occurredAt) === indiaDate());
  const pulls = today.slice(0, 3);
  const visibleRows = rows.filter((row) => (categoryId === undefined || row.categoryId === categoryId)
    && (!direction || row.direction === direction) && (!accountId || row.accountId === accountId));
  const monthName = new Intl.DateTimeFormat('en-IN', { month: 'long', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
  const previousMonthName = new Intl.DateTimeFormat('en-IN', { month: 'long', timeZone: 'UTC' }).format(new Date(`${shiftMonth(month, -1)}-01T00:00:00Z`));
  const spendingRows = rows.filter((row) => row.status === 'posted' && !row.excludeFromStats
    && (row.direction === 'debit' && row.kind === 'expense' || row.direction === 'credit' && (row.kind === 'refund' || row.kind === 'reversal')));
  const stampOrder = ['food', 'rent', 'groceries', 'shopping', 'travel', 'bills'];
  const stamps = (summary?.categories ?? []).filter((stamp) => spendingRows.some((row) => row.categoryId === stamp.categoryId))
    .sort((left, right) => {
      const rank = (name: string | null) => { const index = stampOrder.indexOf((name ?? '').toLowerCase()); return index < 0 ? stampOrder.length : index; };
      return rank(left.categoryName) - rank(right.categoryName);
    });
  function dot(name: string | null) {
    const known = Categories[scheme][(name ?? '').toLowerCase() as keyof typeof Categories.light];
    return known?.dot ?? categories.find((category) => category.name === name)?.color ?? colors.textMuted;
  }
  function select(row: Row) {
    setSelected(row); setConfirmDelete(false); setError('');
    requestAnimationFrame(() => scroll.current?.scrollTo({ y: 0, animated: false }));
  }
  const isCurrentMonth = month === indiaDate().slice(0, 7);
  const budgetTotal = budgets.reduce((sum, budget) => sum + budget.amountPaise, 0);
  const activeFilters = categoryId !== undefined || direction !== undefined || accountId !== undefined;
  const shownRows = showAll ? visibleRows : visibleRows.slice(0, ENTRY_PAGE);
  const hiddenCount = visibleRows.length - shownRows.length;
  const groups = groupByDay(shownRows);
  const deal = dealKeyframes();
  return <ThemedView style={styles.container}><SafeAreaView style={styles.safe} edges={['top']}>
    <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      {selected ? <>
        <LedgerButton label="Back" icon="back" disabled={deleting} onPress={() => { setSelected(undefined); setConfirmDelete(false); setError(''); }} />
        <View style={[styles.detail, printed, { backgroundColor: colors.backgroundElement, borderColor: colors.border }]}>
          <ThemedText style={Type.screenTitle}>{selected.counterparty ?? selected.categoryName ?? 'Entry'}</ThemedText>
          <ThemedText style={Type.amountHero} adjustsFontSizeToFit numberOfLines={1}>{exactMoney(selected.amountPaise)}</ThemedText>
          <ThemedText style={Type.body}>{selected.direction} · {selected.kind} · {selected.status}</ThemedText>
          <ThemedText style={Type.note}><Text style={{ fontFamily: Fonts.monoBold }}>{indiaDate(selected.occurredAt)}</Text> · {selected.source}{selected.userEdited && selected.source !== 'manual' ? ' · corrected' : ''}{selected.excludeFromStats ? ' · excluded from totals' : ''}</ThemedText>
          <ThemedText style={Type.body}>{selected.categoryName ?? 'Uncategorized'} · {selected.accountName ?? 'No account'}</ThemedText>
          {selected.note ? <ThemedText style={Type.body}>{selected.note}</ThemedText> : null}
          <LedgerButton label="Edit entry" disabled={deleting} onPress={() => setMode('entry')} />
          {confirmDelete ? <>
            <ThemedText style={Type.body}>Delete this entry? A deleted paste stays protected from replay.</ThemedText>
            <LedgerButton label={deleting ? 'Deleting…' : 'Confirm delete'} disabled={deleting} onPress={() => { void remove(); }} />
            <LedgerButton label="Keep entry" disabled={deleting} onPress={() => setConfirmDelete(false)} />
          </> : <Pressable accessibilityRole="button" onPress={() => setConfirmDelete(true)} style={styles.textAction}><ThemedText style={[Type.body, { color: colors.over }]}>Delete entry</ThemedText></Pressable>}
          {error ? <ThemedText accessibilityRole="alert" style={Type.note}>{error}</ThemedText> : null}
        </View>
      </> : <>
        <View style={styles.heading}>
          <MonthPicker variant="title" month={month} onChange={(value) => { setMonth(value); setCategoryId(undefined); setShowAll(false); }} />
          <View style={styles.headerActions}>
            <LedgerButton label="Paste a message" icon="paste" iconOnly disabled={!ledger || loading} onPress={() => setMode('paste')} />
            <Pressable accessibilityRole="button" accessibilityLabel="Add entry" accessibilityState={{ disabled: !ledger || loading }} disabled={!ledger || loading}
              onPress={() => setMode('entry')} style={({ pressed }) => [styles.add, printed, { backgroundColor: colors.accent, borderColor: colors.text, opacity: !ledger || loading ? 0.5 : pressed && reduceMotion ? 0.72 : 1, transform: [{ scale: pressed && !reduceMotion ? 0.96 : 1 }] }]}>
              <Icon name="add" size={28} color={colors.onAccent} />
            </Pressable>
          </View>
        </View>
        {summary && !loading && !error ? <Animated.View key={`hero-${month}`} entering={fadeIn()} style={styles.hero}>
          <ThemedText style={styles.heroAmount} adjustsFontSizeToFit numberOfLines={1}>{money(summary.expensePaise)}</ThemedText>
          <ThemedText themeColor="textSecondary" style={Type.note}>
            spent{budgetTotal ? ` of ${money(budgetTotal)}` : ''} · <Text style={{ fontFamily: Fonts.monoBold }}>{rows.length}</Text> {rows.length === 1 ? 'entry' : 'entries'}
          </ThemedText>
        </Animated.View> : null}
        {error ? <View style={styles.section}><ThemedText accessibilityRole="alert">{error}</ThemedText><LedgerButton label="Retry" onPress={() => setRevision((value) => value + 1)} /></View> : null}

        {isCurrentMonth && !loading && !error ? <View style={styles.section}>
          <SectionHeading title="Today" count={pulls.length ? today.length : undefined} />
          {pulls.length ? <View style={styles.fan}>
            {[...pulls].reverse().map((row, reversedIndex) => {
              const index = pulls.length - 1 - reversedIndex;
              const newest = index === 0;
              const place = newest ? 'front' : index === 1 ? 'left' : 'right';
              return <Animated.View key={row.id} entering={reduceMotion ? fadeIn() : deal[place].delay(Motion.stagger * (pulls.length - 1 - index))}
                style={[styles.pull, styles[place], scheme === 'light' ? { boxShadow: newest ? Shadow.lifted : Shadow.card } : undefined,
                  { backgroundColor: colors.backgroundElement, borderColor: scheme === 'dark' ? dot(row.categoryName) : colors.border }]}>
                <Pressable accessibilityRole="button" accessibilityLabel={`Review ${row.counterparty ?? row.categoryName ?? 'entry'}, ${money(row.amountPaise)}`}
                  onPress={() => select(row)} style={[styles.pullBody, place === 'left' && styles.pullBodyLeft, place === 'right' && styles.pullBodyRight]}>
                  <View style={[styles.stamp, { backgroundColor: dot(row.categoryName) }]}><Icon name={categoryIcon(row.categoryName)} size={18} color={scheme === 'light' ? '#FFFFFF' : colors.background} /></View>
                  <ThemedText style={newest ? styles.pullTitle : styles.pullTitleBack} numberOfLines={2}>{row.counterparty ?? row.categoryName ?? (row.direction === 'debit' ? 'Expense' : 'Income')}</ThemedText>
                  <ThemedText style={newest ? Type.amount : Type.amountSmall} numberOfLines={1} adjustsFontSizeToFit>{money(row.amountPaise)}</ThemedText>
                  {newest ? <ThemedText themeColor="textSecondary" style={Type.label} numberOfLines={1}>{row.categoryName ?? 'Uncategorized'}{row.accountName ? ` · ${row.accountName}` : ''}</ThemedText> : null}
                </Pressable>
                {newest ? <View style={[styles.newStamp, { backgroundColor: colors.accent, borderColor: colors.text }]}><ThemedText style={[Type.label, { color: colors.onAccent }]}>New</ThemedText></View> : null}
              </Animated.View>;
            })}
          </View> : <View style={[styles.empty, { borderColor: colors.textMuted }]}>
            <ThemedText style={Type.rowTitle}>Nothing logged today</ThemedText>
            <ThemedText themeColor="textSecondary" style={Type.note}>Tap + to add, or paste a bank message.</ThemedText>
          </View>}
        </View> : null}

        {!loading && !error ? <Animated.View key={`spend-${month}`} entering={fadeIn()} style={styles.section}>
          <View style={styles.sectionRow}>
            <ThemedText style={[Type.sectionTitle, styles.grow]} accessibilityRole="header">Spending</ThemedText>
            {stamps.length ? <View style={styles.viewToggle}><Segmented label="Spending view" value={view} onChange={setView}
              options={[{ value: 'Cards', label: 'Cards' }, { value: 'Chart', label: 'Chart' }]} /></View> : null}
          </View>
          {stamps.length ? view === 'Cards' ? <View style={styles.tiles}>
            {stamps.map((stamp, index) => {
              const on = categoryId === stamp.categoryId;
              const count = spendingRows.filter((row) => row.categoryId === stamp.categoryId).length;
              return <Animated.View key={stamp.categoryId ?? 'uncategorized'} entering={fadeIn(Math.min(index, 8) * 30)} style={styles.tileCell}>
                <Pressable accessibilityRole="button" aria-pressed={on} accessibilityState={{ selected: on }}
                  accessibilityLabel={`${stamp.categoryName ?? 'Uncategorized'}, ${money(stamp.expensePaise)}, ${count} ${count === 1 ? 'entry' : 'entries'}. ${on ? 'Showing only these entries.' : 'Show only these entries.'}`}
                  onPress={() => setCategoryId(on ? undefined : stamp.categoryId)}
                  style={({ pressed }) => [styles.tile, { backgroundColor: on ? colors.fill : colors.backgroundElement, borderColor: colors.border, opacity: pressed && reduceMotion ? 0.72 : 1, transform: [{ scale: pressed && !reduceMotion ? 0.96 : 1 }] }]}>
                  <View style={[styles.tileGlyph, { backgroundColor: dot(stamp.categoryName) }]}><Icon name={categoryIcon(stamp.categoryName)} size={16} color={scheme === 'light' ? '#FFFFFF' : colors.background} /></View>
                  <ThemedText style={[Type.label, { color: on ? colors.background : colors.textSecondary }]} numberOfLines={1}>{stamp.categoryName ?? 'Uncategorized'}</ThemedText>
                  <ThemedText style={[Type.amountSmall, { color: on ? colors.background : colors.text }]} adjustsFontSizeToFit numberOfLines={1}>{money(stamp.expensePaise)}</ThemedText>
                </Pressable>
              </Animated.View>;
            })}
          </View> : <View style={[styles.chart, { backgroundColor: colors.backgroundElement, borderColor: colors.border }]}>
            <MonthPaceChart
              pace={buildMonthPace({ month, today: indiaDate(), rows, previousRows, categories })}
              bars={topCategoryBars({ spending: stamps, budgets, categories })}
              monthName={monthName} previousName={previousMonthName} hasFixed={categories.some((category) => category.isFixed)}
              selectedCategoryId={categoryId}
              onSelectCategory={(id) => setCategoryId(id)}
            />
          </View> : <ThemedText themeColor="textSecondary" style={Type.note}>No spending recorded in {monthName}.</ThemedText>}
        </Animated.View> : null}

        {!loading && !error ? <View style={styles.section}>
          <View style={styles.sectionRow}>
            <View style={styles.grow}>
              <ThemedText style={Type.sectionTitle} accessibilityRole="header">Entries</ThemedText>
              <ThemedText themeColor="textSecondary" style={Type.label}>{activeFilters ? <><Text style={{ fontFamily: Fonts.monoBold }}>{visibleRows.length}</Text> of <Text style={{ fontFamily: Fonts.monoBold }}>{rows.length}</Text> · filtered</> : <><Text style={{ fontFamily: Fonts.monoBold }}>{rows.length}</Text> this month</>}</ThemedText>
            </View>
            {activeFilters ? <LedgerButton label="Clear filters" icon="close" iconOnly onPress={() => { setCategoryId(undefined); setDirection(undefined); setAccountId(undefined); }} /> : null}
            <LedgerButton label={filters ? 'Hide filters' : 'Filter entries'} icon="filter" iconOnly selected={filters} expanded={filters} onPress={() => setFilters(!filters)} />
          </View>
          {filters ? <Animated.View entering={fadeIn()} style={[styles.filters, { borderColor: colors.rule }]}>
            <Segmented label="Direction" value={direction ?? 'all'} onChange={(value) => setDirection(value === 'all' ? undefined : value)}
              options={[{ value: 'all', label: 'All' }, { value: 'debit', label: 'Out' }, { value: 'credit', label: 'In' }]} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {[...categories].sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'expense' ? -1 : 1)).map((category) => <LedgerButton key={category.id} label={category.name} icon={categoryIcon(category.name)} selected={categoryId === category.id} onPress={() => setCategoryId(categoryId === category.id ? undefined : category.id)} />)}
            </ScrollView>
            {accounts.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {accounts.map((account) => <LedgerButton key={account.id} label={account.name} icon={accountIcon(account.type)} selected={accountId === account.id} onPress={() => setAccountId(accountId === account.id ? undefined : account.id)} />)}
            </ScrollView> : null}
          </Animated.View> : null}
          {visibleRows.length === 0 ? <ThemedText themeColor="textSecondary" style={Type.note}>{rows.length ? 'No entries match these filters.' : `Nothing recorded in ${monthName} yet.`}</ThemedText>
            : groups.map((group) => <View key={group.date} style={styles.group}>
              <DayLabel label={group.label} />
              {group.rows.map((row, index) => <Pressable key={row.id} accessibilityRole="button"
                accessibilityLabel={`${row.counterparty ?? row.categoryName ?? 'Entry'}, ${row.direction === 'debit' ? 'spent' : 'received'} ${money(row.amountPaise)}${row.status !== 'posted' ? `, ${row.status}` : ''}${row.excludeFromStats ? ', not counted' : ''}`}
                onPress={() => select(row)} style={({ pressed }) => [styles.entryRow, index > 0 ? { borderTopWidth: 1.5, borderColor: colors.rule } : undefined, { opacity: pressed ? 0.6 : 1 }]}>
                <View style={[styles.entryGlyph, { borderColor: colors.border, backgroundColor: colors.backgroundElement }]}><Icon name={entryIcon(row)} size={18} color={colors.text} /></View>
                <View style={styles.grow}>
                  <ThemedText style={Type.rowTitle} numberOfLines={1}>{row.counterparty ?? row.categoryName ?? (row.direction === 'debit' ? 'Expense' : 'Income')}</ThemedText>
                  <ThemedText themeColor="textSecondary" style={Type.label} numberOfLines={1}>{[entryKind(row), row.status !== 'posted' ? row.status : null, row.excludeFromStats ? 'not counted' : null].filter(Boolean).join(' · ')}</ThemedText>
                </View>
                <ThemedText style={[Type.amountSmall, { color: row.status === 'posted' && !isMovement(row) ? colors.text : colors.textMuted }, row.status === 'failed' && styles.struck]}>{isMovement(row) ? '' : row.direction === 'debit' ? '−' : '+'}{money(row.amountPaise)}</ThemedText>
              </Pressable>)}
            </View>)}
          {hiddenCount > 0 ? <LedgerButton label={`Show ${hiddenCount} more`} onPress={() => setShowAll(true)} /> : null}
        </View> : null}
      </>}
    </ScrollView>
  </SafeAreaView></ThemedView>;
}
const ENTRY_PAGE = 12;

/** Today's cards deal in from below and settle into the fan; each keyframe ends on its card's rotation. */
function dealKeyframes() {
  const from = (rotate: string) => new Keyframe({
    0: { opacity: 0, transform: [{ translateY: 90 }, { rotate: '0deg' }] },
    100: { opacity: 1, transform: [{ translateY: 0 }, { rotate }], easing: ease },
  }).duration(Motion.deal);
  return { front: from('-1deg'), left: from('-8deg'), right: from('7deg') };
}

function groupByDay(rows: Row[]) {
  const today = indiaDate();
  const yesterday = indiaDate(new Date(Date.now() - 86_400_000));
  const label = (date: string) => date === today ? 'Today' : date === yesterday ? 'Yesterday'
    : new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
  const groups: { date: string; label: string; rows: Row[] }[] = [];
  for (const row of rows) {
    const date = indiaDate(row.occurredAt);
    if (groups.at(-1)?.date !== date) groups.push({ date, label: label(date), rows: [] });
    groups.at(-1)!.rows.push(row);
  }
  return groups;
}

/** Money moved between your own accounts or into cash: neither spending nor income. */
function isMovement(row: Row) {
  return row.kind === 'transfer' || row.kind === 'cash_withdrawal';
}

function entryKind(row: Row): string {
  if (row.kind === 'transfer') return 'Transfer';
  if (row.kind === 'cash_withdrawal') return 'Cash withdrawal';
  if (row.kind === 'refund' || row.kind === 'reversal') return `${row.kind === 'refund' ? 'Refund' : 'Reversal'}${row.categoryName ? ` · ${row.categoryName}` : ''}`;
  return row.categoryName ?? (row.kind === 'income' ? 'Income' : 'Uncategorized');
}

function entryIcon(row: Row): IconName {
  if (row.kind === 'transfer') return 'transfer';
  if (row.kind === 'cash_withdrawal') return 'withdrawal';
  if (row.kind === 'refund' || row.kind === 'reversal') return 'refund';
  return categoryIcon(row.categoryName);
}

function SectionHeading({ title, count }: { title: string; count?: number }) {
  return <View style={styles.sectionRow}>
    <ThemedText style={[Type.sectionTitle, styles.grow]} accessibilityRole="header">{title}</ThemedText>
    {count !== undefined ? <ThemedText themeColor="textSecondary" style={Type.label}><Text style={{ fontFamily: Fonts.monoBold }}>{count}</Text> {count === 1 ? 'entry' : 'entries'}</ThemedText> : null}
  </View>;
}

function DayLabel({ label }: { label: string }) {
  const match = /^(\D*)(\d+)(.*)$/.exec(label);
  return <ThemedText themeColor="textSecondary" style={[Type.label, styles.groupLabel]} accessibilityRole="header">
    {match ? <>{match[1]}<Text style={{ fontFamily: Fonts.monoBold }}>{match[2]}</Text>{match[3]}</> : label}
  </ThemedText>;
}

const styles = StyleSheet.create({
  container: { flex: 1 }, safe: { flex: 1 },
  content: { paddingHorizontal: Spacing.gutter, paddingTop: 40, paddingBottom: Spacing.tabBarClearance, gap: Spacing.section, width: '100%', maxWidth: 520, alignSelf: 'center' },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headingWords: { flex: 1, gap: 6, minWidth: 0 }, grow: { flex: 1, minWidth: 0 },
  add: { width: 52, height: 52, borderRadius: Radius.card, borderWidth: 2, justifyContent: 'center', alignItems: 'center' },
  hero: { gap: 2, marginTop: -18 },
  heroAmount: { fontFamily: Fonts.monoBold, fontSize: 40, lineHeight: 46, letterSpacing: -1.6 },
  section: { gap: 12 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  viewToggle: { width: 168 },
  fan: { height: 226, position: 'relative' },
  pull: { position: 'absolute', top: 18, width: 148, height: 196, borderWidth: 2, borderRadius: Radius.card },
  front: { top: 0, left: '50%', marginLeft: -83, width: 166, height: 216, transform: [{ rotate: '-1deg' }], zIndex: 3 },
  left: { left: 4, transform: [{ rotate: '-8deg' }], zIndex: 1 }, right: { right: 4, transform: [{ rotate: '7deg' }], zIndex: 2 },
  pullBody: { flex: 1, padding: 14, gap: 6 },
  // The back cards are half hidden by the front one; keep their words in the part that shows.
  pullBodyLeft: { paddingRight: 70 }, pullBodyRight: { paddingLeft: 74, alignItems: 'flex-end' },
  stamp: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  newStamp: { position: 'absolute', right: -9, top: 13, borderWidth: 2, borderRadius: Radius.pill, paddingHorizontal: 10, paddingVertical: 2, transform: [{ rotate: '-8deg' }] },
  pullTitle: { fontFamily: Fonts.sansHeavy, fontSize: 26, lineHeight: 29, letterSpacing: -1, flex: 1, textAlignVertical: 'center', marginTop: 14 },
  pullTitleBack: { fontFamily: Fonts.sansHeavy, fontSize: 17, lineHeight: 20, flex: 1, textAlignVertical: 'center', marginTop: 14 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -5 },
  tileCell: { width: '33.333%', padding: 5 },
  tile: { borderWidth: 2, borderRadius: Radius.control, padding: 10, gap: 6 },
  tileGlyph: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  chart: { borderWidth: 2, borderRadius: Radius.card, padding: 16, gap: 16 },
  filters: { gap: 10, paddingBottom: 12, borderBottomWidth: 1.5 },
  chips: { gap: 8, paddingRight: 8 },
  group: { gap: 0 },
  groupLabel: { paddingTop: 6, paddingBottom: 2, textTransform: 'none' },
  entryRow: { minHeight: 60, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12 },
  entryGlyph: { width: 40, height: 40, borderWidth: 2, borderRadius: Radius.tile, justifyContent: 'center', alignItems: 'center' },
  struck: { textDecorationLine: 'line-through' },
  empty: { padding: 16, borderWidth: 2, borderStyle: 'dashed', borderRadius: Radius.card, gap: 4 },
  detail: { borderWidth: 2, borderRadius: Radius.card, padding: 22, gap: 16 }, textAction: { minHeight: 44, justifyContent: 'center' },
});
