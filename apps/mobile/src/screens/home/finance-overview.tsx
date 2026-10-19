import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { LedgerButton } from '@/components/ledger-controls';
import { ThemedText } from '@/components/themed-text';
import { Spacing, Type } from '@/constants/theme';
import type { DataLayer } from '@/db';
import { useTheme } from '@/hooks/use-theme';
import { exactMoney, indiaDate } from '@/utils/display';

type Plan = Awaited<ReturnType<DataLayer['getPersonalFinancePlan']>>;

export function FinanceOverview({ ledger, version }: { ledger: DataLayer; version: number }) {
  const colors = useTheme();
  const router = useRouter();
  const [plan, setPlan] = useState<Plan>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmPaid, setConfirmPaid] = useState<string>();
  const [details, setDetails] = useState(false);
  const guard = useRef(false);
  const payments = plan?.upcoming.filter((bill) => plan.nextSalaryDate === null || bill.dueDate <= plan.nextSalaryDate).slice(0, 3) ?? [];
  const refresh = useCallback(async () => {
    try { const next = await ledger.getPersonalFinancePlan(new Date()); setPlan(next); setError(''); }
    catch { setPlan(undefined); setError('Couldn’t calculate your allowance. Retry or check your setup.'); }
  }, [ledger]);
  useEffect(() => {
    let active = true;
    const reload = () => { if (active) void refresh(); };
    reload();
    const timer = setInterval(reload, 60_000);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') reload(); });
    return () => { active = false; clearInterval(timer); subscription.remove(); };
  }, [refresh, version]);
  async function paid(id: string) {
    if (guard.current) return;
    guard.current = true; setBusy(true);
    try {
      if (!await ledger.setPlannedObligationPaid(id, true)) throw new Error('Payment unavailable');
      setConfirmPaid(undefined); await refresh();
    } catch { setError('Couldn’t update the payment. Retry.'); }
    finally { guard.current = false; setBusy(false); }
  }
  return <View style={[styles.section, { borderColor: colors.rule }]}>
    <ThemedText style={Type.sectionTitle} accessibilityRole="header">Until payday</ThemedText>
    {error ? <><ThemedText style={Type.body} accessibilityRole="alert">{error}</ThemedText><LedgerButton label="Retry spending plan" onPress={() => { void refresh(); }} /></> : !plan ? <ThemedText style={Type.note}>Calculating your spending plan…</ThemedText> : <>
      {plan.status === 'ready' && plan.safeToSpendPaise !== null ? <>
        <View style={styles.line}><ThemedText style={Type.rowTitle}>{plan.safeToSpendPaise < 0 ? 'Shortfall to cover' : 'Available to spend'}</ThemedText>
          <ThemedText style={[Type.amount, { color: plan.safeToSpendPaise < 0 ? colors.over : colors.text }]}>{exactMoney(plan.safeToSpendPaise)}</ThemedText></View>
        <ThemedText style={Type.body}>{plan.dailyAllowancePaise === null ? 'Payday is today. Confirm salary has arrived and reconcile your balance.' : `${exactMoney(plan.dailyAllowancePaise)} per day · ${plan.daysUntilSalary} days until ${plan.nextSalaryDate}`}</ThemedText>
        <LedgerButton label={details ? 'Hide calculation' : 'Show calculation'} expanded={details} onPress={() => setDetails((value) => !value)} />
        {details ? <View style={[styles.breakdown, { borderColor: colors.rule }]}>
          <PlanLine label="Tracked liquid balances" value={plan.liquidPaise} />
          <PlanLine label="Full card outstanding reserved" value={plan.cardOutstandingPaise} />
          <PlanLine label="Bills through payday reserved" value={plan.billsReservedPaise} />
          <PlanLine label="Cash reserve" value={plan.reservePaise} />
        </View> : null}
        <ThemedText style={Type.note}>{plan.oldestBalanceCheckpointAt
          ? `Oldest tracked account checkpoint: ${indiaDate(plan.oldestBalanceCheckpointAt)}. Recorded posted movements since each account’s checkpoint are included. Missing alerts or unrecorded payments can change this estimate; expected salary is excluded.`
          : 'No verified balance checkpoint is available. Reconcile your accounts before using this estimate.'}</ThemedText>
      </> : <ThemedText style={Type.body}>{plan.reason ?? 'Finish your spending plan and confirm each account balance.'}</ThemedText>}
      <LedgerButton label="Review plan & balances" onPress={() => router.push('/settings')} />
      {plan.upcoming.length ? <ThemedText style={Type.rowTitle}>Upcoming & overdue</ThemedText> : <ThemedText style={Type.note}>No unpaid bills recorded. Add regular payments in Settings and one-off bills in Budgets.</ThemedText>}
      {payments.map((bill) => <View key={bill.id} style={[styles.payment, { borderColor: colors.rule }]}>
        <View style={styles.line}><ThemedText style={[Type.body, styles.words]}>{bill.label}</ThemedText><ThemedText style={Type.amountSmall}>{exactMoney(bill.amountPaise)}</ThemedText></View>
        <ThemedText style={Type.note}>{bill.dueDate}{bill.kind === 'card_payment' ? ' · outstanding reserved separately' : ''}</ThemedText>
        {confirmPaid === bill.id ? <>
          <ThemedText style={Type.note}>Record the payment entry first, or reconcile the paying account. Marking paid only clears this reminder; it does not move money.</ThemedText>
          <LedgerButton label={`Payment recorded; clear ${bill.label}`} disabled={busy} onPress={() => { void paid(bill.id); }} />
          <LedgerButton label="Keep payment reminder" disabled={busy} onPress={() => setConfirmPaid(undefined)} />
        </> : <LedgerButton label={`Mark ${bill.label} paid`} disabled={busy} onPress={() => setConfirmPaid(bill.id)} />}
      </View>)}
      {plan.upcoming.length > payments.length ? <LedgerButton label={`See all ${plan.upcoming.length} payments`} onPress={() => router.push('/budgets')} /> : null}
    </>}
  </View>;
}
function PlanLine({ label, value }: { label: string; value: number | null }) {
  return <View style={styles.line}><ThemedText style={[Type.note, styles.words]}>{label}</ThemedText><ThemedText style={Type.amountSmall}>{value === null ? '—' : exactMoney(value)}</ThemedText></View>;
}
const styles = StyleSheet.create({
  section: { gap: Spacing.three, paddingVertical: Spacing.four, borderTopWidth: 1 },
  line: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, justifyContent: 'space-between', alignItems: 'baseline' },
  words: { flexShrink: 1 },
  breakdown: { gap: Spacing.two, borderTopWidth: 1, paddingTop: Spacing.three },
  payment: { gap: Spacing.two, borderBottomWidth: 1, paddingBottom: Spacing.three },
});
