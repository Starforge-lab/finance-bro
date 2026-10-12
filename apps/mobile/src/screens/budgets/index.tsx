import * as Crypto from 'expo-crypto';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useColorScheme } from '@/hooks/appearance';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LedgerButton, MonthPicker } from '@/components/ledger-controls';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Categories, Fonts, Radius, Spacing, Stroke, Type } from '@/constants/theme';
import { getLedger, parseInrAmount, type DataLayer } from '@/db';
import { amountInput, indiaDate, money, parseIndiaDate } from '@/utils/display';
import { useTheme } from '@/hooks/use-theme';
import { confirmSave } from '@/utils/confirm-save';

type BudgetRows = Awaited<ReturnType<DataLayer['getBudgetSummary']>>;
type BillRows = Awaited<ReturnType<DataLayer['listBills']>>;
type CategoryRows = Awaited<ReturnType<DataLayer['listCategories']>>;
type Summary = Awaited<ReturnType<DataLayer['getMonthlySummary']>>;
type ActionArea = 'budget' | 'bill';

const STEP_PAISE = 50_000;

function currentMonth() {
  return indiaDate().slice(0, 7);
}

function isMonth(value: string) {
  return /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function monthLabel(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata',
  }).format(parseIndiaDate(`${value}-01`));
}

function billDateLabel(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  }).format(parseIndiaDate(value));
}

/** Display money for bigint totals: whole rupees, paise only when there are some. */
function bigMoney(paise: bigint) {
  const negative = paise < 0n;
  const value = negative ? -paise : paise;
  const rupees = (value / 100n).toString();
  const grouped = rupees.length <= 3
    ? rupees
    : `${rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${rupees.slice(-3)}`;
  const fraction = value % 100n;
  return `${negative ? '−' : ''}₹${grouped}${fraction ? `.${String(fraction).padStart(2, '0')}` : ''}`;
}

function errorMessage(error: unknown) {
  if (error instanceof TypeError || error instanceof RangeError) return error.message;
  return 'Could not save. Your details are still here. Try again.';
}

function categoryStamp(category: CategoryRows[number], stamps: typeof Categories.light | typeof Categories.dark, fallback: string) {
  const identity = `${category.id} ${category.name} ${category.icon ?? ''}`.toLowerCase();
  const key = (Object.keys(stamps) as (keyof typeof Categories.light)[]).find((name) => identity.includes(name));
  return category.color ?? (key ? stamps[key].dot : fallback);
}

function ErrorNotice({ message, colors }: { message: string; colors: ReturnType<typeof useTheme> }) {
  return <View accessibilityRole="alert" style={[styles.errorNotice, { borderColor: colors.over }]}>
    <ThemedText themeColor="over" style={Type.note}>{message}</ThemedText>
  </View>;
}

function Field({
  label, value, onChangeText, placeholder, colors, keyboardType = 'default', maxLength,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  colors: ReturnType<typeof useTheme>;
  keyboardType?: 'default' | 'decimal-pad' | 'numbers-and-punctuation';
  maxLength?: number;
}) {
  return <View style={styles.field}>
    <ThemedText style={Type.label}>{label}</ThemedText>
    <TextInput
      accessibilityLabel={label}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.textSecondary}
      keyboardType={keyboardType}
      maxLength={maxLength}
      style={[styles.input, { backgroundColor: colors.background, borderColor: colors.border, color: colors.text }]}
    />
  </View>;
}

function StepButton({ label, symbol, onPress, colors, disabled = false }: {
  label: string; symbol: '-' | '+'; onPress: () => void; colors: ReturnType<typeof useTheme>; disabled?: boolean;
}) {
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.stepButton, { backgroundColor: colors.backgroundElement, borderColor: colors.border, opacity: disabled ? 0.5 : pressed ? 0.72 : 1 }]}>
    <Text style={[styles.stepText, { color: colors.text }]}>{symbol}</Text>
  </Pressable>;
}

function PrintedPanel({ children, colors, dark }: {
  children: React.ReactNode; colors: ReturnType<typeof useTheme>; dark: boolean;
}) {
  return <View style={styles.printedPanelWrap}>
    {!dark && <View pointerEvents="none" style={[styles.printedShadow, { backgroundColor: colors.shadow }]} />}
    <View style={[styles.printedPanel, { backgroundColor: colors.backgroundElement, borderColor: colors.border }]}>{children}</View>
  </View>;
}

export function Budgets() {
  const colors = useTheme();
  const dark = useColorScheme() === 'dark';
  const stamps = Categories[dark ? 'dark' : 'light'];
  const router = useRouter();
  const [month, setMonth] = useState(currentMonth);
  const [categories, setCategories] = useState<CategoryRows>([]);
  const [budgets, setBudgets] = useState<BudgetRows>([]);
  const [bills, setBills] = useState<BillRows>([]);
  const [summary, setSummary] = useState<Summary>();
  const [loadedMonth, setLoadedMonth] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState('');
  const [actionIssue, setActionIssue] = useState<{ area: ActionArea; message: string } | null>(null);

  const [createBudgetOpen, setCreateBudgetOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [budgetAmount, setBudgetAmount] = useState('');
  const [editingBudget, setEditingBudget] = useState('');
  const [editBudgetAmount, setEditBudgetAmount] = useState('');
  const [confirmBudgetDelete, setConfirmBudgetDelete] = useState('');

  const [createBillOpen, setCreateBillOpen] = useState(false);
  const [billLabel, setBillLabel] = useState('');
  const [billAmount, setBillAmount] = useState('');
  const [billDueDate, setBillDueDate] = useState(indiaDate());
  const [editingBill, setEditingBill] = useState('');
  const [editBillLabel, setEditBillLabel] = useState('');
  const [editBillAmount, setEditBillAmount] = useState('');
  const [editBillDueDate, setEditBillDueDate] = useState('');
  const [confirmBillDelete, setConfirmBillDelete] = useState('');

  const requestId = useRef(0);
  const isFocused = useRef(false);
  const pendingRef = useRef(false);
  const budgetCreateId = useRef<string | null>(null);
  const billCreateId = useRef<string | null>(null);

  const load = useCallback(async () => {
    const request = ++requestId.current;
    setLoading(true);
    setLoadError(false);
    setActionIssue(null);
    try {
      const ledger = await getLedger();
      const [nextCategories, nextBudgets, nextBills, nextSummary] = await Promise.all([
        ledger.listCategories('expense'),
        ledger.getBudgetSummary(month),
        ledger.listBills(indiaDate()),
        ledger.getMonthlySummary(month),
      ]);
      if (!isFocused.current || request !== requestId.current) return;
      setCategories(nextCategories);
      setBudgets(nextBudgets);
      setBills(nextBills);
      setSummary(nextSummary);
      setLoadedMonth(month);
    } catch {
      if (!isFocused.current || request !== requestId.current) return;
      setLoadError(true);
    } finally {
      if (isFocused.current && request === requestId.current) setLoading(false);
    }
  }, [month]);

  useFocusEffect(useCallback(() => {
    isFocused.current = true;
    void load();
    return () => {
      isFocused.current = false;
      requestId.current += 1;
    };
  }, [load]));

  const runWrite = useCallback(async (
    area: ActionArea,
    key: string,
    write: (ledger: DataLayer) => Promise<unknown>,
  ) => {
    if (pendingRef.current || loading || loadedMonth !== month || loadError) return false;
    pendingRef.current = true;
    setPending(key);
    setActionIssue(null);
    try {
      const result = await write(await getLedger());
      if (result === false) {
        await load();
        throw new RangeError('This item is no longer available. The list has been refreshed.');
      }
      void confirmSave();
      await load();
      return true;
    } catch (error) {
      setActionIssue({ area, message: errorMessage(error) });
      return false;
    } finally {
      pendingRef.current = false;
      setPending('');
    }
  }, [load, loadError, loadedMonth, loading, month]);

  const selectMonth = (value: string) => {
    if (!isMonth(value)) return;
    setMonth(value);
    setActionIssue(null);
  };

  const currentBudgets = loadedMonth === month ? budgets : [];
  const summaryReady = loadedMonth === month && !!summary;
  const currentBills = summaryReady ? bills : [];
  const budgetRows = [...currentBudgets].sort((a, b) => {
    const first = categories.find((item) => item.id === a.categoryId);
    const second = categories.find((item) => item.id === b.categoryId);
    return (first?.sortOrder ?? 0) - (second?.sortOrder ?? 0)
      || (first?.name ?? '').localeCompare(second?.name ?? '');
  });
  const availableCategories = summaryReady
    ? categories.filter((category) => !currentBudgets.some((budget) => budget.categoryId === category.id))
    : [];
  const selectedAvailable = availableCategories.find((category) => category.id === selectedCategory);
  const createCategory = selectedAvailable ?? availableCategories[0];
  const createCategoryId = createCategory?.id ?? '';
  const totalBudget = currentBudgets.reduce((sum, budget) => sum + BigInt(budget.amountPaise), 0n);
  const recordedSpend = summaryReady ? BigInt(summary!.expensePaise) : 0n;
  const totalRemaining = summaryReady && totalBudget > 0n ? totalBudget - recordedSpend : null;
  const heroFill = totalBudget > 0n
    ? Math.min(100, Number((BigInt(Math.max(0, summary?.expensePaise ?? 0)) * 10_000n) / totalBudget) / 100)
    : 0;
  const writesDisabled = !!pending || loading || loadedMonth !== month || loadError;

  const setMonthLimit = async () => {
    try {
      const amountPaise = parseInrAmount(budgetAmount);
      if (!createCategory) throw new TypeError('Add an expense category in Settings before setting a limit.');
      const id = budgetCreateId.current ?? Crypto.randomUUID();
      budgetCreateId.current = id;
      const saved = await runWrite('budget', 'budget-create', (ledger) => ledger.setBudget({
        id, categoryId: createCategory.id, month, amountPaise,
      }));
      if (saved) {
        budgetCreateId.current = null;
        setCreateBudgetOpen(false);
        setBudgetAmount('');
        setSelectedCategory('');
      }
    } catch (error) {
      setActionIssue({ area: 'budget', message: errorMessage(error) });
    }
  };

  const editAmount = async (id: string) => {
    try {
      const amountPaise = parseInrAmount(editBudgetAmount);
      const saved = await runWrite('budget', `budget-edit-${id}`, (ledger) => ledger.editBudget(id, { amountPaise }));
      if (saved) {
        setEditingBudget('');
        setEditBudgetAmount('');
      }
    } catch (error) {
      setActionIssue({ area: 'budget', message: errorMessage(error) });
    }
  };

  const stepAmount = (delta: number) => {
    try {
      const paise = parseInrAmount(editBudgetAmount) + delta * STEP_PAISE;
      if (paise <= 0) throw new RangeError('A category limit must be greater than zero.');
      setEditBudgetAmount(amountInput(paise));
      setActionIssue(null);
    } catch (error) {
      setActionIssue({ area: 'budget', message: errorMessage(error) });
    }
  };

  const saveBill = async () => {
    try {
      const label = billLabel.trim();
      if (!label) throw new TypeError('Enter a bill name.');
      const amountPaise = parseInrAmount(billAmount);
      const dueDate = indiaDate(parseIndiaDate(billDueDate.trim()));
      const id = billCreateId.current ?? Crypto.randomUUID();
      billCreateId.current = id;
      const saved = await runWrite('bill', 'bill-create', (ledger) => ledger.createBill({ id, label, amountPaise, dueDate }));
      if (saved) {
        billCreateId.current = null;
        setCreateBillOpen(false);
        setBillLabel('');
        setBillAmount('');
        setBillDueDate(indiaDate());
      }
    } catch (error) {
      setActionIssue({ area: 'bill', message: errorMessage(error) });
    }
  };

  const editBill = async (id: string) => {
    try {
      const label = editBillLabel.trim();
      if (!label) throw new TypeError('Enter a bill name.');
      const amountPaise = parseInrAmount(editBillAmount);
      const dueDate = indiaDate(parseIndiaDate(editBillDueDate.trim()));
      const saved = await runWrite('bill', `bill-edit-${id}`, (ledger) => ledger.editBill(id, { label, amountPaise, dueDate }));
      if (saved) setEditingBill('');
    } catch (error) {
      setActionIssue({ area: 'bill', message: errorMessage(error) });
    }
  };

  const openBudgetEditor = (id: string, amountPaise: number) => {
    setCreateBudgetOpen(false);
    setEditingBudget(id);
    setEditBudgetAmount(amountInput(amountPaise));
    setConfirmBudgetDelete('');
  };

  const closeBudgetEditor = () => {
    setEditingBudget('');
    setConfirmBudgetDelete('');
    setEditBudgetAmount('');
  };

  const closeBudgetCreate = () => {
    setCreateBudgetOpen(false);
    setBudgetAmount('');
    setSelectedCategory('');
    budgetCreateId.current = null;
  };

  const openBillEditor = (bill: BillRows[number]) => {
    setCreateBillOpen(false);
    setEditingBill(bill.id);
    setEditBillLabel(bill.label);
    setEditBillAmount(amountInput(bill.amountPaise));
    setEditBillDueDate(bill.dueDate);
    setConfirmBillDelete('');
  };

  const closeBillEditor = () => {
    setEditingBill('');
    setConfirmBillDelete('');
    setEditBillLabel('');
    setEditBillAmount('');
    setEditBillDueDate('');
  };

  const closeBillCreate = () => {
    setCreateBillOpen(false);
    setBillLabel('');
    setBillAmount('');
    setBillDueDate(indiaDate());
    billCreateId.current = null;
  };

  return <ThemedView style={styles.container}>
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <KeyboardAvoidingView style={styles.safeArea} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
          <View style={styles.header}>
            <ThemedText accessibilityRole="header" style={Type.screenTitle}>Budgets</ThemedText>
            <MonthPicker month={month} onChange={selectMonth} />
          </View>

          {summaryReady ? (
            <View style={[styles.hero, { backgroundColor: colors.heroBackground, borderColor: colors.heroBackground }]}>
              <View style={styles.heroLabelRow}>
                <ThemedText style={[Type.label, { color: colors.heroTextSecondary }]}>Left to spend</ThemedText>
                {totalRemaining !== null && totalRemaining < 0n && <View style={[styles.overBadge, { backgroundColor: colors.over }]}>
                  <Text style={[Type.label, { color: colors.heroText }]}>Over</Text>
                </View>}
              </View>
              <ThemedText
                style={[
                  styles.heroAmount,
                  Type.amountHero,
                  { color: colors.heroText },
                  String(totalRemaining === null ? 0 : bigMoney(totalRemaining)).length > 13 && styles.heroAmountCompact,
                ]}>
                {totalRemaining === null ? 'Set a limit' : bigMoney(totalRemaining)}
              </ThemedText>
              <ThemedText style={[Type.note, { color: colors.heroTextSecondary }]}>
                {totalRemaining === null
                  ? 'Add a category limit to start.'
                  : totalRemaining < 0n
                    ? `${bigMoney(-totalRemaining)} over · ${bigMoney(recordedSpend)} spent of ${bigMoney(totalBudget)}`
                    : `${bigMoney(recordedSpend)} spent of ${bigMoney(totalBudget)}`}
              </ThemedText>
              {totalBudget > 0n && <>
                <View accessibilityRole="progressbar" accessibilityLabel="Spending compared with combined category limits" accessibilityValue={{ min: 0, max: 100, now: heroFill }} aria-valuemin={0} aria-valuemax={100} aria-valuenow={heroFill} style={[styles.heroTrack, { backgroundColor: colors.heroRule }]}>
                  <View style={[styles.heroFill, { width: `${heroFill}%`, backgroundColor: colors.heroText }]} />
                </View>

              </>}
            </View>
          ) : loading ? (
            <View accessibilityRole="progressbar" accessibilityLabel="Loading budget totals" style={[styles.loadPanel, { borderColor: colors.rule }]}>
              <ActivityIndicator color={colors.text} />
              <ThemedText style={Type.note} themeColor="textSecondary">Opening your local ledger…</ThemedText>
            </View>
          ) : (
            <View style={[styles.loadPanel, { borderColor: colors.rule }]}>
              <ThemedText style={Type.body}>Monthly totals could not be loaded.</ThemedText>
              <LedgerButton label="Retry budgets" onPress={() => void load()} />
            </View>
          )}

          {loadError && summaryReady && <View style={[styles.refreshError, { borderColor: colors.over }]}>
            <ThemedText themeColor="textSecondary" style={Type.note}>The latest refresh failed. Showing the last loaded records.</ThemedText>
            <LedgerButton label="Retry loading" onPress={() => void load()} />
          </View>}

          <View style={styles.section}>
            <View style={styles.sectionHeading}>
              <ThemedText accessibilityRole="header" style={Type.sectionTitle}>Categories</ThemedText>
              {categories.length > 0 && <LedgerButton
                label={createBudgetOpen ? 'Cancel' : 'Add limit'}
                icon={createBudgetOpen ? 'close' : 'add'}
                primary={false}
                disabled={writesDisabled || (!createBudgetOpen && availableCategories.length === 0)}
                onPress={() => {
                  if (createBudgetOpen) closeBudgetCreate();
                  else { setEditingBudget(''); setCreateBudgetOpen(true); }
                }} />}
            </View>

            {actionIssue?.area === 'budget' && <ErrorNotice message={actionIssue.message} colors={colors} />}

            {budgetRows.length > 0 ? <View style={styles.categoryList}>
              {budgetRows.map((budget) => {
                const category = categories.find((item) => item.id === budget.categoryId);
                const name = category?.name ?? 'Unknown category';
                const over = budget.overBudget;
                const fill = Math.min(100, Math.max(0, budget.spentPaise / budget.amountPaise * 100));
                return <View key={budget.id} style={[styles.categoryRow, { borderBottomColor: colors.rule }]}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${name} monthly limit. ${money(budget.spentPaise)} recorded spending of ${money(budget.amountPaise)}.`}
                    accessibilityHint="Opens the amount editor."
                    accessibilityState={{ expanded: editingBudget === budget.id }}
                    aria-expanded={editingBudget === budget.id}
                    disabled={writesDisabled}
                    onPress={() => editingBudget === budget.id ? closeBudgetEditor() : openBudgetEditor(budget.id, budget.amountPaise)}
                    style={({ pressed }) => [styles.categoryButton, { opacity: writesDisabled ? 0.5 : pressed ? 0.72 : 1 }]}>
                    <View style={styles.categoryTitleRow}>
                      <View style={styles.categoryName}>
                        <View style={[styles.stamp, { backgroundColor: category ? categoryStamp(category, stamps, colors.text) : colors.text }]} />
                        <ThemedText style={Type.rowTitle} numberOfLines={1}>{name}</ThemedText>
                      </View>
                      <View style={styles.categoryAmounts}>
                        <ThemedText style={[Type.amountSmall, over && { color: colors.over }]}>{money(budget.spentPaise)}</ThemedText>
                        <ThemedText style={[Type.label, { color: colors.textSecondary }]}>/ {money(budget.amountPaise)}</ThemedText>
                      </View>
                    </View>
                    <View accessibilityRole="progressbar" accessibilityLabel={`${name} spending`} accessibilityValue={{ min: 0, max: budget.amountPaise, now: Math.min(budget.amountPaise, Math.max(0, budget.spentPaise)) }} aria-valuemin={0} aria-valuemax={budget.amountPaise} aria-valuenow={Math.min(budget.amountPaise, Math.max(0, budget.spentPaise))} style={[styles.categoryTrack, { backgroundColor: colors.track }]}>
                      <View style={[styles.categoryFill, { width: `${fill}%`, backgroundColor: over ? colors.over : colors.fill }]} />
                    </View>
                    <ThemedText style={[Type.label, { color: over ? colors.over : colors.textSecondary }]}>
                      {over ? `${money(-budget.remainingPaise)} over` : `${money(budget.remainingPaise)} left`}
                    </ThemedText>
                  </Pressable>

                  {editingBudget === budget.id && <PrintedPanel colors={colors} dark={dark}>
                    <ThemedText style={Type.rowTitle}>Edit monthly limit</ThemedText>
                    <View style={styles.stepper}>
                      <StepButton label={`Decrease ${name} limit by ₹500`} symbol="-" onPress={() => stepAmount(-1)} colors={colors} disabled={writesDisabled} />
                      <TextInput
                        accessibilityLabel={`${name} monthly limit in rupees`}
                        value={editBudgetAmount}
                        onChangeText={setEditBudgetAmount}
                        keyboardType="decimal-pad"
                        selectTextOnFocus
                        style={[styles.stepAmount, Type.amount, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]}
                      />
                      <StepButton label={`Increase ${name} limit by ₹500`} symbol="+" onPress={() => stepAmount(1)} colors={colors} disabled={writesDisabled} />
                    </View>
                    <ThemedText themeColor="textSecondary" style={[Type.note, styles.centerText]}>
                      Amount for {monthLabel(month)} · step ₹500
                    </ThemedText>
                    {confirmBudgetDelete === budget.id ? <>
                      <ThemedText style={Type.note}>Remove the {name} limit for {monthLabel(month)}?</ThemedText>
                      <View style={styles.actions}>
                        <LedgerButton label="Confirm remove" disabled={writesDisabled} onPress={() => void runWrite('budget', `budget-delete-${budget.id}`, (ledger) => ledger.removeBudget(budget.id)).then((removed) => removed && closeBudgetEditor())} />
                        <LedgerButton label="Keep limit" disabled={writesDisabled} onPress={() => setConfirmBudgetDelete('')} />
                      </View>
                    </> : <View style={styles.actions}>
                      <LedgerButton label={pending === `budget-edit-${budget.id}` ? 'Saving…' : 'Save limit'} primary disabled={writesDisabled} onPress={() => void editAmount(budget.id)} />
                      <LedgerButton label="Remove limit" disabled={writesDisabled} onPress={() => setConfirmBudgetDelete(budget.id)} />
                    </View>}
                  </PrintedPanel>}
                </View>;
              })}
            </View> : summaryReady ? <View style={[styles.emptyState, { borderColor: colors.textMuted }]}>
              <ThemedText style={Type.rowTitle}>{categories.length === 0 ? 'Add an expense category first.' : `No limits for ${monthLabel(month)} yet.`}</ThemedText>
              <ThemedText themeColor="textSecondary" style={Type.note}>
                {categories.length === 0
                  ? 'Choose an expense category in Settings, then give it a monthly limit.'
                  : 'Set category limits to compare this month’s recorded spending.'}
              </ThemedText>
              {categories.length === 0
                ? <LedgerButton label="Open Settings" primary onPress={() => router.navigate('/settings')} />
                : <LedgerButton label="Set a limit" primary disabled={writesDisabled || !availableCategories.length} onPress={() => setCreateBudgetOpen(true)} />}
            </View> : loading ? <ThemedText themeColor="textSecondary" style={Type.note}>Updating category limits…</ThemedText> : null}

            {createBudgetOpen && <PrintedPanel colors={colors} dark={dark}>
              <ThemedText style={Type.rowTitle}>Set a category limit</ThemedText>
              {availableCategories.length > 0 ? <>
                <View style={styles.categoryChoices}>
                  {availableCategories.map((category) => <LedgerButton
                    key={category.id}
                    label={category.id === createCategoryId ? `Selected: ${category.name}` : category.name}
                    selected={category.id === createCategoryId}
                    disabled={writesDisabled}
                    onPress={() => setSelectedCategory(category.id)} />)}
                </View>
                <Field label="Monthly limit in rupees" value={budgetAmount} onChangeText={setBudgetAmount} placeholder="For example, 5000" colors={colors} keyboardType="decimal-pad" />
                <View style={styles.actions}>
                  <LedgerButton label={pending === 'budget-create' ? 'Saving…' : 'Save limit'} primary disabled={writesDisabled || !budgetAmount.trim()} onPress={() => void setMonthLimit()} />
                  <LedgerButton label="Cancel" disabled={!!pending} onPress={closeBudgetCreate} />
                </View>
              </> : <>
                <ThemedText themeColor="textSecondary" style={Type.note}>Every expense category already has a limit for this month.</ThemedText>
                <LedgerButton label="Close" disabled={!!pending} onPress={closeBudgetCreate} />
              </>}
            </PrintedPanel>}
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHeading}>
              <ThemedText accessibilityRole="header" style={Type.sectionTitle}>Coming up</ThemedText>
              <LedgerButton label={createBillOpen ? 'Cancel' : 'Add bill'} disabled={writesDisabled} onPress={() => {
                if (createBillOpen) closeBillCreate();
                else { setEditingBill(''); setCreateBillOpen(true); }
              }} />
            </View>

            {actionIssue?.area === 'bill' && <ErrorNotice message={actionIssue.message} colors={colors} />}

            {currentBills.length > 0 ? <View style={styles.billList}>
              {currentBills.map((bill) => {
                const expanded = editingBill === bill.id;
                const deleting = confirmBillDelete === bill.id;
                const status = bill.status === 'paid' ? 'Paid' : bill.status === 'overdue' ? 'Overdue' : 'Upcoming';
                return <View key={bill.id} style={[styles.billRow, { borderBottomColor: colors.rule }]}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${bill.label}, ${status}, due ${bill.dueDate}. ${money(bill.amountPaise)}. Manage bill.`}
                    accessibilityState={{ expanded }}
                    aria-expanded={expanded}
                    disabled={writesDisabled}
                    onPress={() => expanded ? closeBillEditor() : openBillEditor(bill)}
                    style={({ pressed }) => [styles.billButton, { opacity: writesDisabled ? 0.5 : pressed ? 0.72 : 1 }]}>
                    <DateTile date={bill.dueDate} colors={colors} />
                    <View style={styles.billDescription}>
                      <ThemedText style={Type.rowTitle} numberOfLines={1}>{bill.label}</ThemedText>
                      <ThemedText style={[Type.note, bill.status === 'overdue' && { color: colors.over }]}>
                        {status} · due {billDateLabel(bill.dueDate)}
                      </ThemedText>
                    </View>
                    <ThemedText style={Type.amountSmall}>{money(bill.amountPaise)}</ThemedText>
                  </Pressable>

                  {expanded && <PrintedPanel colors={colors} dark={dark}>
                    <ThemedText style={Type.rowTitle}>Edit bill</ThemedText>
                    <Field label="Bill name" value={editBillLabel} onChangeText={setEditBillLabel} placeholder="For example, Electricity" colors={colors} />
                    <View style={styles.billFields}>
                      <Field label="Amount in rupees" value={editBillAmount} onChangeText={setEditBillAmount} placeholder="Amount" colors={colors} keyboardType="decimal-pad" />
                      <Field label="Due date · YYYY-MM-DD" value={editBillDueDate} onChangeText={setEditBillDueDate} placeholder="YYYY-MM-DD" colors={colors} keyboardType="numbers-and-punctuation" maxLength={10} />
                    </View>
                    <View style={styles.actions}>
                      <LedgerButton label={pending === `bill-edit-${bill.id}` ? 'Saving…' : 'Save bill'} primary disabled={writesDisabled} onPress={() => void editBill(bill.id)} />
                      <LedgerButton label={bill.status === 'paid' ? 'Mark unpaid' : 'Mark paid'} disabled={writesDisabled} onPress={() => void runWrite('bill', `bill-paid-${bill.id}`, (ledger) => ledger.setBillPaid(bill.id, bill.status !== 'paid'))} />
                    </View>
                    <ThemedText themeColor="textSecondary" style={Type.note}>Marked paid? Add the expense in Home too.</ThemedText>
                    {deleting ? <>
                      <ThemedText style={Type.note}>Remove “{bill.label}”?</ThemedText>
                      <View style={styles.actions}>
                        <LedgerButton label="Confirm remove" disabled={writesDisabled} onPress={() => void runWrite('bill', `bill-delete-${bill.id}`, (ledger) => ledger.removeBill(bill.id)).then((removed) => removed && closeBillEditor())} />
                        <LedgerButton label="Keep bill" disabled={writesDisabled} onPress={() => setConfirmBillDelete('')} />
                      </View>
                    </> : <LedgerButton label="Remove bill" disabled={writesDisabled} onPress={() => setConfirmBillDelete(bill.id)} />}
                  </PrintedPanel>}
                </View>;
              })}
            </View> : summaryReady && !loading && !loadError ? <View style={[styles.emptyState, { borderColor: colors.textMuted }]}>
              <ThemedText style={Type.rowTitle}>No bills saved yet.</ThemedText>
              <ThemedText themeColor="textSecondary" style={Type.note}>Add a bill to track its due date.</ThemedText>
            </View> : loading ? <ThemedText themeColor="textSecondary" style={Type.note}>Checking due dates…</ThemedText> : null}

            {createBillOpen && <PrintedPanel colors={colors} dark={dark}>
              <ThemedText style={Type.rowTitle}>Add a bill</ThemedText>
              <Field label="Bill name" value={billLabel} onChangeText={setBillLabel} placeholder="For example, Electricity" colors={colors} />
              <View style={styles.billFields}>
                <Field label="Amount in rupees" value={billAmount} onChangeText={setBillAmount} placeholder="Amount" colors={colors} keyboardType="decimal-pad" />
                <Field label="Due date · YYYY-MM-DD" value={billDueDate} onChangeText={setBillDueDate} placeholder="YYYY-MM-DD" colors={colors} keyboardType="numbers-and-punctuation" maxLength={10} />
              </View>
              <View style={styles.actions}>
                <LedgerButton label={pending === 'bill-create' ? 'Saving…' : 'Save bill'} primary disabled={writesDisabled || !billLabel.trim() || !billAmount.trim() || !billDueDate.trim()} onPress={() => void saveBill()} />
                <LedgerButton label="Cancel" disabled={!!pending} onPress={closeBillCreate} />
              </View>
            </PrintedPanel>}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </ThemedView>;
}

function DateTile({ date, colors }: { date: string; colors: ReturnType<typeof useTheme> }) {
  const month = new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'Asia/Kolkata' }).format(parseIndiaDate(date));
  return <View accessible={false} style={[styles.dateTile, { borderColor: colors.border, backgroundColor: colors.backgroundElement }]}>
    <ThemedText style={[Type.label, styles.dateMonth]}>{month}</ThemedText>
    <ThemedText style={[Type.amountSmall, styles.dateDay]}>{date.slice(-2)}</ThemedText>
  </View>;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1 },
  content: { width: '100%', maxWidth: 520, alignSelf: 'center', paddingHorizontal: Spacing.gutter, paddingTop: Spacing.five, paddingBottom: Spacing.tabBarClearance, gap: Spacing.section },
  header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  heroLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  overBadge: { borderRadius: Radius.pill, paddingHorizontal: Spacing.two, paddingVertical: Spacing.one },
  hero: { borderWidth: Stroke.ink, borderRadius: Radius.hero, padding: 22, gap: Spacing.three },
  heroAmount: { fontSize: 44, lineHeight: 48, letterSpacing: -1.7 },
  heroAmountCompact: { fontSize: 30, lineHeight: 36, letterSpacing: -1 },
  heroTrack: { height: 14, borderRadius: Radius.bar, overflow: 'hidden' },
  heroFill: { height: '100%', borderRadius: Radius.bar },
  statHighlight: { alignSelf: 'flex-start', borderRadius: 4, paddingHorizontal: Spacing.one },
  section: { gap: Spacing.three },
  sectionHeading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  categoryList: { gap: 0 },
  categoryRow: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: Spacing.three },
  categoryButton: { gap: Spacing.two },
  categoryTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  categoryName: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  categoryAmounts: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'flex-end', gap: Spacing.one },
  stamp: { width: 10, height: 10, borderRadius: Radius.pill, flexShrink: 0 },
  categoryTrack: { height: 10, borderRadius: Radius.bar, overflow: 'hidden' },
  categoryFill: { height: '100%', borderRadius: Radius.bar },
  emptyState: { borderWidth: Stroke.hairline, borderStyle: 'dashed', borderRadius: Radius.card, padding: Spacing.three, gap: Spacing.two },
  printedPanelWrap: { position: 'relative', marginRight: 4, marginBottom: 4 },
  printedShadow: { position: 'absolute', top: 3, left: 3, right: -3, bottom: -4, borderRadius: Radius.card },
  printedPanel: { borderWidth: Stroke.ink, borderRadius: Radius.card, padding: Spacing.three, gap: Spacing.three },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  stepButton: { width: 56, height: 56, borderWidth: Stroke.ink, borderRadius: Radius.control, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontFamily: Fonts.sansHeavy, fontSize: 24, lineHeight: 28 },
  stepAmount: { flex: 1, minWidth: 0, height: 56, borderWidth: Stroke.hairline, borderRadius: Radius.control, paddingHorizontal: Spacing.two, textAlign: 'center' },
  centerText: { textAlign: 'center' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  categoryChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  field: { flex: 1, minWidth: 130, gap: Spacing.one },
  input: { minHeight: 48, borderWidth: Stroke.ink, borderRadius: Radius.control, paddingHorizontal: Spacing.three, fontFamily: Fonts.sans, fontSize: 16 },
  billFields: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  billList: { gap: 0 },
  billRow: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: Spacing.two, gap: Spacing.two },
  billButton: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  dateTile: { width: 52, minHeight: 56, borderWidth: Stroke.ink, borderRadius: Radius.tile, alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.one },
  dateMonth: { textTransform: 'uppercase' },
  dateDay: { fontSize: 18, lineHeight: 24 },
  billDescription: { flex: 1, minWidth: 0, gap: Spacing.one },
  errorNotice: { borderWidth: Stroke.hairline, borderRadius: Radius.control, padding: Spacing.two },
  refreshError: { borderWidth: Stroke.hairline, borderRadius: Radius.control, padding: Spacing.two, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  loadPanel: { minHeight: 104, borderWidth: Stroke.hairline, borderRadius: Radius.card, padding: Spacing.three, justifyContent: 'center', alignItems: 'flex-start', gap: Spacing.two },
});
