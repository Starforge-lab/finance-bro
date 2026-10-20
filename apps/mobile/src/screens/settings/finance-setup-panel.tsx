import { useEffect, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { LedgerButton, Segmented } from '@/components/ledger-controls';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing, Type } from '@/constants/theme';
import type { DataLayer } from '@/db';
import { parseInrAmount } from '@/db/manual';
import { useTheme } from '@/hooks/use-theme';
import { amountInput, exactMoney, indiaDate } from '@/utils/display';

type Balance = Awaited<ReturnType<DataLayer['getAccountBalances']>>[number];
type Schedule = Awaited<ReturnType<DataLayer['listRecurringSchedules']>>[number];

function amount(input: string, signed = false): number {
  const value = input.trim();
  if (/^0(?:\.0{1,2})?$/.test(value)) return 0;
  return signed && value.startsWith('-') ? -parseInrAmount(value.slice(1)) : parseInrAmount(value);
}

export function FinanceSetupPanel({ ledger, version }: { ledger: DataLayer; version: number }) {
  const colors = useTheme();
  const [balances, setBalances] = useState<Balance[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [salaryDay, setSalaryDay] = useState('');
  const [salary, setSalary] = useState('');
  const [reserve, setReserve] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [accountCoverageConfirmed, setAccountCoverageConfirmed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [balance, setBalance] = useState('');
  const [label, setLabel] = useState('');
  const [billAmount, setBillAmount] = useState('');
  const [billDay, setBillDay] = useState('');
  const [kind, setKind] = useState<'bill' | 'card_payment'>('bill');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const scheduleId = useRef(Crypto.randomUUID());
  useEffect(() => {
    let active = true;
    void Promise.all([ledger.getFinanceSetup(), ledger.getAccountBalances(new Date()), ledger.listRecurringSchedules()])
      .then(([setup, rows, recurring]) => {
        if (!active) return;
        setBalances(rows.filter((row) => row.isOwn && !row.archived)); setSchedules(recurring);
        if (!loaded) {
          setSalaryDay(setup ? String(setup.salaryDay) : ''); setSalary(setup ? amountInput(setup.salaryAmountPaise) : '');
          setReserve(setup ? amountInput(setup.reservePaise) : ''); setConfirmed(setup?.commitmentsConfirmed ?? false);
          setAccountCoverageConfirmed(setup?.accountCoverageConfirmed ?? false);
        }
        setLoaded(true);
      }).catch(() => { if (active) setNotice('Couldn’t load your plan. Reopen Settings to retry.'); });
    return () => { active = false; };
  }, [ledger, version, loaded]);
  async function save(task: () => Promise<unknown>, message: string) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setNotice('');
    try {
      await task();
      const [rows, recurring] = await Promise.all([ledger.getAccountBalances(new Date()), ledger.listRecurringSchedules()]);
      setBalances(rows.filter((row) => row.isOwn && !row.archived)); setSchedules(recurring); setNotice(message);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Couldn’t save. Your previous values are still available.'); }
    finally { guard.current = false; setBusy(false); }
  }
  return <View style={styles.section}>
    <ThemedText style={Type.sectionTitle} accessibilityRole="header">Your spending plan</ThemedText>
    <ThemedText style={Type.body}>Confirm balances once, then recorded entries update them. Full card outstanding stays reserved. Missing alerts can change your real balance; reconcile regularly.</ThemedText>
    {!loaded ? <ThemedText style={Type.note}>Loading plan…</ThemedText> : <>
      <ThemedText style={Type.rowTitle}>Payday & cash reserve</ThemedText>
      <PlanField label="Salary day of month (1–31)" value={salaryDay} onChange={setSalaryDay} disabled={busy} numeric />
      <PlanField label="Expected monthly salary (INR)" value={salary} onChange={setSalary} disabled={busy} numeric />
      <PlanField label="Keep aside as cash reserve (INR, 0 allowed)" value={reserve} onChange={setReserve} disabled={busy} numeric />
      <ThemedText style={Type.note}>Expected salary sets the planning horizon. It becomes available only when recorded in an account balance. Days beyond month end use the last day.</ThemedText>
      <Segmented label="Have you included all upcoming commitments?" value={confirmed ? 'yes' : 'no'}
        options={[{ value: 'no', label: 'Still setting up' }, { value: 'yes', label: 'All included' }]}
        onChange={(value) => { if (!busy) setConfirmed(value === 'yes'); }} />
      <ThemedText style={Type.note}>Choose “All included” after adding regular payments here and any one-off bills in Budgets, including anything overdue.</ThemedText>
      <Segmented label="Have you included every account and card that affects this estimate?" value={accountCoverageConfirmed ? 'yes' : 'no'}
        options={[{ value: 'no', label: 'Still setting up' }, { value: 'yes', label: 'All included' }]}
        onChange={(value) => { if (!busy) setAccountCoverageConfirmed(value === 'yes'); }} />
      <ThemedText style={Type.note}>Include each bank, cash, wallet and credit-card balance that affects your available money. Archived overdrafts and card debt still count; credit limits are not cash.</ThemedText>
      <LedgerButton label="Save spending plan" disabled={busy} onPress={() => { void save(() => ledger.saveFinanceSetup({ salaryDay: Number(salaryDay), salaryAmountPaise: amount(salary), reservePaise: amount(reserve), commitmentsConfirmed: confirmed, accountCoverageConfirmed }), 'Spending plan saved on this device.'); }} />
      <ThemedText style={Type.rowTitle}>Verified account balances</ThemedText>
      {!balances.length ? <ThemedText style={Type.body}>Add your bank accounts and credit cards above first.</ThemedText> : null}
      {balances.map((row) => <View key={row.accountId} style={[styles.row, { borderColor: colors.rule }]}>
        <ThemedText style={Type.rowTitle}>{row.name}</ThemedText>
        <ThemedText style={Type.note}>{row.type === 'credit_card' ? 'Outstanding owed (positive); overpayment (negative)' : 'Available balance; overdraft is negative'}</ThemedText>
        <ThemedText style={Type.note}>Calculated balance</ThemedText>
        <ThemedText style={Type.amount}>{row.calculatedPaise === null ? 'Balance needed' : exactMoney(row.calculatedPaise)}</ThemedText>
        {row.lastVerifiedAt && row.lastVerifiedPaise !== null ? <ThemedText style={Type.note}>Last verified {indiaDate(row.lastVerifiedAt)}: {exactMoney(row.lastVerifiedPaise)}</ThemedText> : null}
        {row.reconciliationDeltaPaise !== null ? <ThemedText style={Type.note}>Last reconciliation difference {exactMoney(row.reconciliationDeltaPaise)} · no income entry created</ThemedText> : null}
        {editing === row.accountId ? <>
          <PlanField label={`Current ${row.name} balance in INR`} value={balance} onChange={setBalance} disabled={busy} />
          <ThemedText style={Type.note}>Use the current amount from your bank. Entries recorded through this moment are included in this checkpoint.</ThemedText>
          <LedgerButton label="Confirm current balance" disabled={busy} onPress={() => { void save(async () => { const now = new Date(); await ledger.setAccountBalance({ accountId: row.accountId, balancePaise: amount(balance, true), asOf: now }, now); setEditing(undefined); }, 'Balance reconciled.'); }} />
          <LedgerButton label="Cancel balance change" disabled={busy} onPress={() => setEditing(undefined)} />
        </> : <LedgerButton label={`Reconcile ${row.name}`} disabled={busy} onPress={() => { setEditing(row.accountId); setBalance(''); }} />}
      </View>)}
      <ThemedText style={Type.rowTitle}>Regular payments</ThemedText>
      <ThemedText style={Type.note}>Monthly reminders roll forward automatically. Card payment reminders don’t reduce your allowance again. Add overdue payments in Budgets.</ThemedText>
      {schedules.map((row) => <View key={row.id} style={[styles.row, { borderColor: colors.rule }]}>
        <ThemedText style={Type.rowTitle}>{row.label}{row.paused ? ' · paused' : ''}</ThemedText>
        <ThemedText style={Type.note}>{exactMoney(row.amountPaise)} · day {row.dayOfMonth} · {row.kind === 'card_payment' ? 'card payment' : 'bill'}</ThemedText>
        <LedgerButton label={`${row.paused ? 'Resume' : 'Pause'} ${row.label}`} disabled={busy} onPress={() => { void save(() => ledger.setRecurringSchedulePaused(row.id, !row.paused), 'Schedule updated. Existing bills remain in Budgets.'); }} />
      </View>)}
      <PlanField label="Payment name" value={label} onChange={setLabel} disabled={busy} />
      <PlanField label="Monthly payment (INR)" value={billAmount} onChange={setBillAmount} disabled={busy} numeric />
      <PlanField label="Payment day (1–31)" value={billDay} onChange={setBillDay} disabled={busy} numeric />
      <Segmented label="Payment type" value={kind} onChange={(value) => { if (!busy) setKind(value); }} options={[{ value: 'bill', label: 'Regular bill' }, { value: 'card_payment', label: 'Card payment' }]} />
      <LedgerButton label="Add monthly payment" disabled={busy} onPress={() => { void save(async () => {
        await ledger.createRecurringSchedule({ id: scheduleId.current, label, amountPaise: amount(billAmount), dayOfMonth: Number(billDay), kind });
        scheduleId.current = Crypto.randomUUID(); setLabel(''); setBillAmount(''); setBillDay('');
      }, 'Monthly payment added.'); }} />
    </>}
    {notice ? <ThemedText accessibilityRole="alert" style={Type.note}>{notice}</ThemedText> : null}
  </View>;
}

function PlanField({ label, value, onChange, disabled, numeric = false }: { label: string; value: string; onChange: (value: string) => void; disabled: boolean; numeric?: boolean }) {
  const colors = useTheme();
  return <View style={styles.field}>
    <ThemedText style={Type.note}>{label}</ThemedText>
    <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} editable={!disabled} keyboardType={numeric ? 'decimal-pad' : 'default'}
      selectionColor={colors.text} style={[Type.body, styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.backgroundElement }]} />
  </View>;
}
const styles = StyleSheet.create({
  section: { gap: Spacing.three, marginVertical: Spacing.three },
  row: { gap: Spacing.two, borderBottomWidth: 1, paddingVertical: Spacing.three },
  field: { gap: Spacing.two },
  input: { borderWidth: 1, borderRadius: Radius.control, padding: Spacing.three, minHeight: 48 },
});
