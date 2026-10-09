import { useFocusEffect, useRootNavigationState, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LedgerButton, MonthNavigation } from '@/components/ledger-controls';
import { MonthPaceChart } from '@/components/month-pace-chart';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Categories, Fonts, Radius, Shadow, Spacing, Type } from '@/constants/theme';
import { getLedger, type DataLayer } from '@/db';
import { useTheme } from '@/hooks/use-theme';
import { indiaDate, money } from '@/utils/display';
import { buildMonthPace, shiftMonth, topCategoryBars } from '@/utils/month-pace';
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
  const [entriesOpen, setEntriesOpen] = useState(false);
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
  const entriesY = useRef(0);
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
  function showEntries() {
    setEntriesOpen(true);
    requestAnimationFrame(() => scroll.current?.scrollTo({ y: entriesY.current, animated: false }));
  }
  return <ThemedView style={styles.container}><SafeAreaView style={styles.safe} edges={['top']}>
    <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      {selected ? <>
        <LedgerButton label="Back" disabled={deleting} onPress={() => { setSelected(undefined); setConfirmDelete(false); setError(''); }} />
        <View style={[styles.detail, printed, { backgroundColor: colors.backgroundElement, borderColor: colors.border }]}>
          <ThemedText style={Type.screenTitle}>{selected.counterparty ?? selected.categoryName ?? 'Entry'}</ThemedText>
          <ThemedText style={Type.amountHero} adjustsFontSizeToFit numberOfLines={1}>{money(selected.amountPaise)}</ThemedText>
          <ThemedText style={Type.body}>{selected.direction} · {selected.kind} · {selected.status}</ThemedText>
          <ThemedText style={Type.note}>{indiaDate(selected.occurredAt)} · {selected.source}{selected.userEdited && selected.source !== 'manual' ? ' · corrected' : ''}{selected.excludeFromStats ? ' · excluded from totals' : ''}</ThemedText>
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
          <View style={styles.headingWords}>
            <ThemedText style={Type.screenTitle}>Expense tracker</ThemedText>
            <ThemedText themeColor="textSecondary" style={Type.note}>Your money, on your phone.</ThemedText>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Add entry" accessibilityState={{ disabled: !ledger || loading }} disabled={!ledger || loading}
            onPress={() => setMode('entry')} style={({ pressed }) => [styles.add, printed, { backgroundColor: colors.accent, borderColor: colors.text, opacity: !ledger || loading ? 0.5 : 1, transform: [{ scale: pressed ? 0.96 : 1 }] }]}>
            <View style={[styles.plusHorizontal, { backgroundColor: colors.onAccent }]} /><View style={[styles.plusVertical, { backgroundColor: colors.onAccent }]} />
          </Pressable>
        </View>
        {!loading && !error && pulls.length ? <View style={styles.fan}>
          {[...pulls].reverse().map((row, reversedIndex) => {
            const index = pulls.length - 1 - reversedIndex;
            const newest = index === 0;
            return <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={`Review ${row.counterparty ?? row.categoryName ?? 'entry'}, ${money(row.amountPaise)}`}
              onPress={() => select(row)} style={[styles.pull, newest ? styles.front : index === 1 ? styles.left : styles.right,
                scheme === 'light' ? { boxShadow: newest ? Shadow.lifted : Shadow.card } : undefined,
                { backgroundColor: colors.backgroundElement, borderColor: scheme === 'dark' ? dot(row.categoryName) : colors.border }]}>
              <View style={[styles.stamp, { backgroundColor: dot(row.categoryName) }]}><ThemedText style={[Type.rowTitle, { color: scheme === 'light' ? '#FFFFFF' : colors.background }]}>{(row.categoryName ?? 'Entry').slice(0, 2)}</ThemedText></View>
              {newest ? <View style={[styles.newStamp, { backgroundColor: colors.accent, borderColor: colors.text }]}><ThemedText style={[Type.rowTitle, { color: colors.onAccent }]}>New</ThemedText></View> : null}
              <ThemedText style={styles.pullTitle} numberOfLines={2}>{row.counterparty ?? row.categoryName ?? (row.direction === 'debit' ? 'Expense' : 'Income')}</ThemedText>
              <ThemedText style={Type.amount} numberOfLines={1} adjustsFontSizeToFit>{money(row.amountPaise)}</ThemedText>
              {newest ? <ThemedText themeColor="textSecondary" style={Type.note} numberOfLines={2}>{row.categoryName ?? 'Uncategorized'} · {row.accountName ?? (row.source === 'manual' ? 'Manual' : 'Paste')}</ThemedText> : null}
            </Pressable>;
          })}
        </View> : !loading && !error ? <View style={[styles.empty, { borderColor: colors.textMuted }]}>
          <ThemedText style={Type.sectionTitle}>No entries today.</ThemedText>
          <ThemedText themeColor="textSecondary" style={Type.body}>Tap + to add an expense.</ThemedText>
          {!filters ? <LedgerButton label="Paste a message" disabled={!ledger} onPress={() => setMode('paste')} /> : null}
        </View> : null}
        {error ? <View style={styles.section}><ThemedText accessibilityRole="alert">{error}</ThemedText><LedgerButton label="Retry" onPress={() => setRevision((value) => value + 1)} /></View> : null}
        <View style={styles.section}>
          <View style={styles.binderHeading}>
            <View style={styles.headingWords}><ThemedText style={Type.sectionTitle}>{monthName} spending</ThemedText>
              {summary && !loading ? <ThemedText themeColor="textSecondary" style={Type.amountSmall}>{money(summary.expensePaise)} · {rows.length} {rows.length === 1 ? 'entry' : 'entries'}</ThemedText> : null}
            </View>
            <View style={[styles.segment, { borderColor: colors.border }]}>
              {(['Cards', 'Chart'] as const).map((name) => <Pressable key={name} accessibilityRole="button" aria-pressed={view === name} accessibilityState={{ selected: view === name }}
                onPress={() => setView(name)} style={[styles.segmentItem, { backgroundColor: view === name ? colors.fill : 'transparent' }]}>
                <ThemedText style={[Type.rowTitle, { color: view === name ? colors.background : colors.text }]}>{name}</ThemedText></Pressable>)}
            </View>
          </View>
          {!loading && !error && stamps.length ? view === 'Cards' ? <View style={styles.tiles}>
            {stamps.map((stamp) => <Pressable key={stamp.categoryId ?? 'uncategorized'} accessibilityRole="button" aria-pressed={categoryId === stamp.categoryId} accessibilityState={{ selected: categoryId === stamp.categoryId }}
              accessibilityLabel={`Filter ${stamp.categoryName ?? 'Uncategorized'}, spending ${money(stamp.expensePaise)}`}
              onPress={() => { setCategoryId(categoryId === stamp.categoryId ? undefined : stamp.categoryId); showEntries(); }}
              style={[styles.tile, { backgroundColor: colors.backgroundElement, borderColor: categoryId === stamp.categoryId ? colors.fill : colors.border }]}>
              <View style={styles.tileHeading}><ThemedText style={[Type.rowTitle, { flex: 1 }]} numberOfLines={1}>{stamp.categoryName ?? 'Uncategorized'}</ThemedText><View style={[styles.dot, { backgroundColor: dot(stamp.categoryName) }]} /></View>
              <View style={styles.row}><ThemedText style={[Type.amountSmall, { flex: 1 }]} adjustsFontSizeToFit numberOfLines={1}>{money(stamp.expensePaise)}</ThemedText>
                <ThemedText themeColor="textSecondary" style={Type.amountSmall}>×{spendingRows.filter((row) => row.categoryId === stamp.categoryId).length}</ThemedText></View>
            </Pressable>)}
          </View> : <View style={[styles.chart, { backgroundColor: colors.backgroundElement, borderColor: colors.border }]}>
            <MonthPaceChart
              pace={buildMonthPace({ month, today: indiaDate(), rows, previousRows, categories })}
              bars={topCategoryBars({ spending: stamps, budgets, categories })}
              monthName={monthName} previousName={previousMonthName} hasFixed={categories.some((category) => category.isFixed)}
              selectedCategoryId={categoryId}
              onSelectCategory={(id) => { setCategoryId(id); if (id !== undefined) showEntries(); }}
            />
          </View> : !loading && !error ? <ThemedText themeColor="textSecondary">No spending recorded this month.</ThemedText> : null}
        </View>
        <View style={styles.toolbar}>
          <MonthNavigation month={month} onChange={(value) => { setMonth(value); setCategoryId(undefined); }} />
          <LedgerButton label="More" expanded={filters} onPress={() => setFilters(!filters)} />
        </View>
        {filters ? <View style={styles.section}>
          <LedgerButton label="Paste a message" disabled={!ledger || loading} onPress={() => setMode('paste')} />
          <ThemedText style={Type.rowTitle}>Filter entries</ThemedText>
          <View style={styles.toolbar}>{(['all', 'debit', 'credit'] as const).map((value) => <LedgerButton key={value} label={value === 'all' ? 'All entries' : value === 'debit' ? 'Debits' : 'Credits'} selected={value === 'all' ? !direction : value === direction} onPress={() => setDirection(value === 'all' ? undefined : value)} />)}</View>
          <View style={styles.toolbar}><LedgerButton label="All categories" selected={categoryId === undefined} onPress={() => setCategoryId(undefined)} />{categories.map((category) => <LedgerButton key={category.id} label={category.name} selected={categoryId === category.id} onPress={() => setCategoryId(category.id)} />)}</View>
          <View style={styles.toolbar}><LedgerButton label="All accounts" selected={!accountId} onPress={() => setAccountId(undefined)} />{accounts.map((account) => <LedgerButton key={account.id} label={account.name} selected={accountId === account.id} onPress={() => setAccountId(account.id)} />)}</View>
        </View> : null}
        {!loading && !error ? <View style={styles.section} onLayout={(event) => { entriesY.current = event.nativeEvent.layout.y; }}>
          <LedgerButton label={entriesOpen ? 'Hide entries' : `View entries (${rows.length})`} expanded={entriesOpen} onPress={() => entriesOpen ? setEntriesOpen(false) : showEntries()} />
          {entriesOpen ? <>
          {visibleRows.length === 0 ? <ThemedText themeColor="textSecondary">No entries match this month and these filters.</ThemedText> : visibleRows.map((row, index) => <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={`Review ${row.direction} ${money(row.amountPaise)}, ${row.counterparty ?? row.categoryName ?? 'entry'}, ${row.status}`}
            onPress={() => select(row)} style={[styles.entryRow, index > 0 ? { borderTopWidth: 1.5, borderColor: colors.rule } : undefined]}>
            <View style={[styles.dateTile, { backgroundColor: colors.backgroundElement, borderColor: colors.border }]}><ThemedText style={Type.amountSmall}>{indiaDate(row.occurredAt).slice(8)}</ThemedText><ThemedText style={Type.label}>{monthName.slice(0, 3)}</ThemedText></View>
            <View style={styles.headingWords}><ThemedText style={Type.rowTitle}>{row.counterparty ?? row.categoryName ?? (row.direction === 'debit' ? 'Expense' : 'Income')}</ThemedText><ThemedText themeColor="textSecondary" style={Type.note}>{row.categoryName ?? 'Uncategorized'}{row.status !== 'posted' ? ` · ${row.status}` : ''}{row.excludeFromStats ? ' · excluded' : ''}</ThemedText></View>
            <ThemedText style={Type.amountSmall}>{row.direction === 'debit' ? '−' : '+'}{money(row.amountPaise)}</ThemedText>
          </Pressable>)}
          </> : null}
        </View> : null}
      </>}
    </ScrollView>
  </SafeAreaView></ThemedView>;
}
const styles = StyleSheet.create({
  container: { flex: 1 }, safe: { flex: 1 },
  content: { paddingHorizontal: Spacing.gutter, paddingTop: 52, paddingBottom: Spacing.tabBarClearance, gap: Spacing.section, width: '100%', maxWidth: 520, alignSelf: 'center' },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, headingWords: { flex: 1, gap: 6, minWidth: 0 },
  add: { width: 52, height: 52, borderRadius: Radius.card, borderWidth: 2, justifyContent: 'center', alignItems: 'center' },
  plusHorizontal: { width: 18, height: 3, borderRadius: 2 }, plusVertical: { position: 'absolute', height: 18, width: 3, borderRadius: 2 },
  fan: { height: 222, position: 'relative', marginBottom: 8 },
  pull: { position: 'absolute', top: 20, width: 148, height: 194, padding: 14, borderWidth: 2, borderRadius: Radius.card, gap: 5 },
  front: { top: 0, left: '50%', marginLeft: -83, width: 166, height: 216, transform: [{ rotate: '-1deg' }], zIndex: 3 },
  left: { left: 4, transform: [{ rotate: '-8deg' }], zIndex: 1 }, right: { right: 4, transform: [{ rotate: '7deg' }], zIndex: 2 },
  stamp: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  newStamp: { position: 'absolute', right: -9, top: 13, borderWidth: 2, borderRadius: Radius.pill, paddingHorizontal: 10, paddingVertical: 2, transform: [{ rotate: '-8deg' }] },
  pullTitle: { fontFamily: Fonts.sansHeavy, fontSize: 28, lineHeight: 31, letterSpacing: -1, flex: 1, textAlignVertical: 'center', marginTop: 20 },
  binderHeading: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  segment: { borderWidth: 2, borderRadius: Radius.pill, flexDirection: 'row', padding: 2 }, segmentItem: { minHeight: 38, paddingHorizontal: 12, borderRadius: Radius.pill, justifyContent: 'center' },
  section: { gap: 12 }, toolbar: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, tile: { width: '31%', minWidth: 95, borderWidth: 2, borderRadius: Radius.control, padding: 10, gap: 8 },
  tileHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 4 }, dot: { width: 10, height: 10, borderRadius: 5 },
  chart: { borderWidth: 2, borderRadius: Radius.card, padding: 16, gap: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  entryRow: { paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }, dateTile: { width: 44, height: 44, borderWidth: 2, borderRadius: Radius.tile, justifyContent: 'center', alignItems: 'center' },
  empty: { padding: 16, borderWidth: 2, borderStyle: 'dashed', borderRadius: Radius.card, gap: 12, minHeight: 216, justifyContent: 'center' },
  detail: { borderWidth: 2, borderRadius: Radius.card, padding: 22, gap: 16 }, textAction: { minHeight: 44, justifyContent: 'center' },
});
