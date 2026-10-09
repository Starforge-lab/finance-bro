import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useColorScheme } from '@/hooks/appearance';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DuplicateReviewRequiredError, type DataLayer } from '@/db';
import { transactionDirections, transactionKinds, transactionStatuses } from '@/db/schema';
import type { PastePreparation, ReviewCorrections } from '@/imports/paste';
import { amountInput, exactMoney, indiaDate, indiaTime, parseIndiaDate, parseIndiaDateTime } from '@/utils/display';
import { parseInrAmount } from '@/db/manual';
import { Fonts, Radius, Spacing, Stroke, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { confirmSave } from '@/utils/confirm-save';

type Direction = typeof transactionDirections[number];
type Kind = typeof transactionKinds[number];
type Status = typeof transactionStatuses[number];
type CategoryOption = Awaited<ReturnType<DataLayer['listCategories']>>[number];
type AccountOption = Awaited<ReturnType<DataLayer['listAccounts']>>[number];
type SaveOutcome = 'inserted' | 'duplicate';

const directions = transactionDirections;
const kinds = transactionKinds;
const statuses = transactionStatuses;

function categoryKind(kind: Kind, direction: Direction): 'expense' | 'income' | undefined {
  if (kind === 'expense') return 'expense';
  if (kind === 'income') return 'income';
  if ((kind === 'refund' || kind === 'reversal') && direction === 'credit') return 'expense';
  return undefined;
}

function safeAmountText(paise: number | undefined): string {
  if (paise === undefined || !Number.isSafeInteger(paise)) return '';
  try {
    return amountInput(paise);
  } catch {
    return '';
  }
}

function safeDateText(timestamp: number | undefined): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return '';
  try {
    return indiaDate(new Date(timestamp));
  } catch {
    return '';
  }
}

function safeTimeText(timestamp: number | undefined): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return '';
  try {
    return indiaTime(new Date(timestamp));
  } catch {
    return '';
  }
}

function displayKind(kind: string): string {
  return kind.replaceAll('_', ' ');
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const colors = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      {children}
      {hint ? <Text style={[styles.hint, { color: colors.textSecondary }]}>{hint}</Text> : null}
    </View>
  );
}

function Choice({
  label,
  selected,
  disabled,
  onPress,
  accessibilityRole = 'radio',
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
  accessibilityRole?: 'button' | 'radio';
}) {
  const colors = useTheme();
  return (
    <Pressable
      accessibilityRole={accessibilityRole}
      aria-checked={selected}
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        {
          backgroundColor: selected ? colors.backgroundSelected : colors.backgroundElement,
          borderColor: colors.border,
          opacity: disabled ? 0.48 : pressed ? 0.75 : 1,
        },
      ]}>
      <Text style={[styles.choiceText, { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

export function PasteForm({
  ledger,
  onSaved,
  onCancel,
}: {
  ledger: DataLayer;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const colors = useTheme();
  const dark = useColorScheme() === 'dark';
  const [sender, setSender] = useState('');
  const [senderOpen, setSenderOpen] = useState(false);
  const [body, setBody] = useState('');
  const [prepared, setPrepared] = useState<PastePreparation | null>(null);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [amountText, setAmountText] = useState('');
  const [direction, setDirection] = useState<Direction | ''>('');
  const [kind, setKind] = useState<Kind | ''>('');
  const [status, setStatus] = useState<Status | ''>('');
  const [dateText, setDateText] = useState('');
  const [timeText, setTimeText] = useState('');
  const [separatePayment, setSeparatePayment] = useState(false);
  const [merchant, setMerchant] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [excludeFromStats, setExcludeFromStats] = useState(false);
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [riskRequiredAfterError, setRiskRequiredAfterError] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [discardPromptOpen, setDiscardPromptOpen] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const availableCategories = useMemo(() => {
    if (!direction || !kind) return categories;
    const requiredKind = categoryKind(kind, direction);
    return requiredKind ? categories.filter((category) => category.kind === requiredKind) : categories;
  }, [categories, direction, kind]);

  const amountValue = useMemo(() => {
    if (!amountText.trim()) return { amountPaise: null, message: 'Enter the amount in rupees.' };
    try {
      return { amountPaise: parseInrAmount(amountText), message: '' };
    } catch {
      return { amountPaise: null, message: 'Use rupees with up to two decimal places, for example 450.00.' };
    }
  }, [amountText]);

  const parsedDate = useMemo(() => {
    if (!dateText.trim()) return null;
    try {
      return parseIndiaDate(dateText);
    } catch {
      return null;
    }
  }, [dateText]);

  const separatePaymentAt = useMemo(() => {
    if (!separatePayment) return null;
    try {
      return parseIndiaDateTime(dateText, timeText);
    } catch {
      return null;
    }
  }, [dateText, separatePayment, timeText]);

  const duplicateReviewRequired = prepared?.kind === 'needs-review' &&
    (prepared.duplicateReviewRequired || riskRequiredAfterError);
  const canOfferSeparatePayment = prepared?.kind === 'needs-review' && prepared.collision !== null &&
    prepared.identity.dedupeKey.startsWith('body:') && !prepared.candidate?.upiRef && !reference.trim();
  const sameCollisionSecond = Boolean(
    separatePayment && prepared?.kind === 'needs-review' && prepared.collision && separatePaymentAt &&
    Math.floor(prepared.collision.occurredAt / 1_000) === Math.floor(separatePaymentAt.getTime() / 1_000),
  );
  const consistentKind = kind !== 'expense' || direction === 'debit';
  const consistentIncome = kind !== 'income' || direction === 'credit';
  const selectedCategoryIsValid = categoryId === null || availableCategories.some((category) => category.id === categoryId);
  const canPrepare = body.trim().length > 0 && !busy;
  const reviewFieldsValid = Boolean(prepared?.kind === 'needs-review' && amountValue.amountPaise !== null &&
    direction && kind && status && parsedDate && consistentKind && consistentIncome && selectedCategoryIsValid);
  const detailsVisible = separatePayment || detailsOpen || !reviewFieldsValid;
  const canSave = reviewFieldsValid && (!duplicateReviewRequired || riskAcknowledged) &&
    (!separatePayment || (canOfferSeparatePayment && separatePaymentAt !== null && !sameCollisionSecond)) && !busy;
  const dirty = !outcome && (body.length > 0 || sender.length > 0 || prepared?.kind === 'needs-review');

  function resetReview() {
    setPrepared(null);
    setOutcome(null);
    setError('');
    setCategories([]);
    setAccounts([]);
    setAmountText('');
    setDirection('');
    setKind('');
    setStatus('');
    setDateText('');
    setTimeText('');
    setSeparatePayment(false);
    setMerchant('');
    setReference('');
    setNote('');
    setCategoryId(null);
    setAccountId(null);
    setExcludeFromStats(false);
    setRiskAcknowledged(false);
    setRiskRequiredAfterError(false);
    setDetailsOpen(false);
    setSenderOpen(false);
    setDiscardPromptOpen(false);
  }

  async function prepare() {
    if (busyRef.current || !body.trim()) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const receivedAt = Date.now();
      const result = await ledger.preparePaste({
        sender: sender.trim() || 'PASTE',
        body,
        receivedAt,
      });
      let nextCategories: CategoryOption[] = [];
      let nextAccounts: AccountOption[] = [];
      if (result.kind === 'needs-review') {
        [nextCategories, nextAccounts] = await Promise.all([
          ledger.listCategories(),
          ledger.listAccounts(),
        ]);
      }
      if (!mountedRef.current) return;
      setCategories(nextCategories);
      setAccounts(nextAccounts);
      setPrepared(result);
      setOutcome(null);
      setSeparatePayment(false);
      setRiskAcknowledged(false);
      setRiskRequiredAfterError(false);
      if (result.kind === 'needs-review') {
        const candidate = result.candidate;
        const nextAmount = safeAmountText(candidate?.amountPaise);
        const collisionAt = result.collision?.occurredAt;
        const nextDate = safeDateText(collisionAt ?? candidate?.occurredAt);
        const nextTime = safeTimeText(collisionAt ?? candidate?.occurredAt);
        let candidateIsComplete = Boolean(
          candidate?.direction && candidate.kind && candidate.status && nextAmount && nextDate &&
          (candidate.kind !== 'expense' || candidate.direction === 'debit') &&
          (candidate.kind !== 'income' || candidate.direction === 'credit'),
        );
        try {
          if (candidateIsComplete) {
            parseInrAmount(nextAmount);
            parseIndiaDate(nextDate);
          }
        } catch {
          candidateIsComplete = false;
        }
        setDetailsOpen(!candidateIsComplete);
        setAmountText(nextAmount);
        setDirection(candidate?.direction ?? '');
        setKind(candidate?.kind ?? '');
        setStatus(candidate?.status ?? '');
        setDateText(nextDate);
        setTimeText(nextTime);
        setMerchant(candidate?.counterparty ?? candidate?.vpa ?? '');
        setReference(candidate?.upiRef ?? '');
      }
      setSenderOpen(false);
      setSender('');
      setBody('');
      Keyboard.dismiss();
    } catch {
      if (mountedRef.current) setError('Could not prepare this paste. Your text is still here; try again.');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  async function save() {
    if (busyRef.current || prepared?.kind !== 'needs-review' || !canSave) return;
    let amountPaise: number;
    let occurredAt: Date;
    try {
      amountPaise = parseInrAmount(amountText);
      const candidateTime = prepared.candidate ? new Date(prepared.candidate.occurredAt) : undefined;
      const preserveTimeFrom = candidateTime && Number.isFinite(candidateTime.getTime()) ? candidateTime : undefined;
      occurredAt = separatePayment
        ? separatePaymentAt ?? parseIndiaDateTime(dateText, timeText)
        : parseIndiaDate(dateText, preserveTimeFrom);
    } catch {
      setError('Check the amount and India calendar date before saving.');
      return;
    }
    if (!direction || !kind || !status) return;
    if (kind === 'expense' && direction !== 'debit') {
      setError('An expense must be a debit.');
      return;
    }
    if (kind === 'income' && direction !== 'credit') {
      setError('Income must be a credit.');
      return;
    }

    const corrections: ReviewCorrections = {
      amountPaise,
      direction,
      kind,
      status,
      occurredAt,
      accountId,
      categoryId,
      counterparty: merchant.trim() || null,
      note: note.trim() || null,
      upiRef: reference.trim() || null,
      excludeFromStats,
    };
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await ledger.saveReviewedPaste(prepared, corrections, {
        acknowledgeDuplicateRisk: riskAcknowledged,
        ...(separatePaymentAt ? { separatePaymentAt } : {}),
      });
      if (result === 'duplicate' && separatePayment) {
        setError('This exact date and second is already handled. If this is another purchase, choose its actual different time or enter it manually.');
        return;
      }
      if (result === 'duplicate' && prepared.collision === null &&
          prepared.identity.dedupeKey.startsWith('body:') && !prepared.candidate?.upiRef) {
        const collision = await ledger.getPasteCollision(prepared.identity.id);
        if (collision && mountedRef.current) {
          setPrepared({ ...prepared, collision });
          setDateText(safeDateText(collision.occurredAt));
          setTimeText(safeTimeText(collision.occurredAt));
          setError('A matching paste was saved while you reviewed. Confirm whether this is the same message or a separate payment.');
          return;
        }
      }
      if (result === 'inserted') void confirmSave();
      if (mountedRef.current) setOutcome(result);
    } catch (cause) {
      if (!mountedRef.current) return;
      if (cause instanceof DuplicateReviewRequiredError) {
        setRiskRequiredAfterError(true);
        setRiskAcknowledged(false);
        setError('The import key changed since review. Check the duplicate warning before saving.');
      } else if (cause instanceof RangeError && cause.message.includes('different actual time')) {
        setError('Choose a different actual time. Purchases in the same second must be entered manually.');
      } else {
        setError('Could not save this review. Your corrections are still here; try again.');
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  const discard = useCallback(() => {
    if (busyRef.current) return;
    setSender('');
    setBody('');
    resetReview();
    onCancel();
  }, [onCancel]);

  const requestCancel = useCallback(() => {
    if (busyRef.current) return;
    if (!dirty) {
      discard();
      return;
    }
    if (Platform.OS === 'web') {
      setDiscardPromptOpen(true);
      return;
    }
    Alert.alert('Discard this paste?', 'Your message and review will be lost.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: discard },
    ]);
  }, [dirty, discard]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      requestCancel();
      return true;
    });
    return () => subscription.remove();
  }, [requestCancel]);

  function changeDirection(value: Direction) {
    setDirection(value);
    const requiredKind = kind ? categoryKind(kind, value) : undefined;
    if (categoryId && requiredKind) {
      const selected = categories.find((category) => category.id === categoryId);
      if (selected?.kind !== requiredKind) setCategoryId(null);
    }
  }

  function changeKind(value: Kind) {
    setKind(value);
    const requiredKind = direction ? categoryKind(value, direction) : undefined;
    if (categoryId && requiredKind) {
      const selected = categories.find((category) => category.id === categoryId);
      if (selected?.kind !== requiredKind) setCategoryId(null);
    }
  }

  function complete() {
    resetReview();
    if (outcome === 'inserted') onSaved();
    else onCancel();
  }

  const inputStyle = [
    styles.input,
    {
      backgroundColor: colors.backgroundElement,
      borderColor: colors.border,
      color: colors.text,
    },
  ];

  return (
    <KeyboardAvoidingView style={[styles.container, { backgroundColor: colors.background }]} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag">
          <View style={styles.header}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Paste a bank message</Text>
          </View>

          {!prepared ? (
            <View style={[styles.panel, { backgroundColor: colors.backgroundElement, borderColor: colors.border, shadowColor: dark ? 'transparent' : colors.shadow }]}>
              <Field label="Message text" hint="Used for this review, then cleared.">
                <TextInput
                  accessibilityLabel="Paste bank message text"
                  autoCapitalize="sentences"
                  autoCorrect={false}
                  editable={!busy}
                  multiline
                  onChangeText={setBody}
                  placeholder="Paste the bank message here"
                  placeholderTextColor={colors.textSecondary}
                  scrollEnabled={false}
                  style={[...inputStyle, styles.messageInput]}
                  textAlignVertical="top"
                  value={body}
                />
              </Field>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: senderOpen, disabled: busy }}
                aria-expanded={senderOpen}
                disabled={busy}
                onPress={() => setSenderOpen((open) => !open)}
                style={({ pressed }) => [styles.detailsToggle, { borderColor: colors.border, opacity: busy ? 0.45 : pressed ? 0.7 : 1 }]}>
                <Text style={[styles.detailsToggleText, { color: colors.text }]}>{senderOpen ? 'Hide sender' : 'Add sender'}</Text>
              </Pressable>
              {senderOpen ? (
                <Field label="Sender (optional)">
                  <TextInput
                    accessibilityLabel="Message sender, optional"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    editable={!busy}
                    onChangeText={setSender}
                    placeholder="Bank name"
                    placeholderTextColor={colors.textSecondary}
                    returnKeyType="next"
                    style={inputStyle}
                    value={sender}
                  />
                </Field>
              ) : null}
            </View>
          ) : prepared.kind === 'ignored' ? (
            <View style={[styles.panel, { backgroundColor: colors.backgroundElement, borderColor: colors.border, shadowColor: dark ? 'transparent' : colors.shadow }]}>
              <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.text }]}>Nothing to save</Text>
              <Text style={[styles.bodyCopy, { color: colors.textSecondary }]}>This message was not added ({prepared.reason.replaceAll('_', ' ')}).</Text>
            </View>
          ) : outcome ? (
            <View style={[styles.panel, { backgroundColor: colors.backgroundElement, borderColor: colors.border, shadowColor: dark ? 'transparent' : colors.shadow }]}>
              <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.text }]}>
                {outcome === 'inserted' ? 'Saved on this device' : 'Already handled'}
              </Text>
              <Text style={[styles.bodyCopy, { color: colors.textSecondary }]}>
                {outcome === 'inserted'
                  ? 'Saved in your ledger. Message text cleared.'
                  : 'This paste was saved or deleted before. Nothing was added or changed.'}
              </Text>
            </View>
          ) : (
            <View style={[styles.panel, { backgroundColor: colors.backgroundElement, borderColor: colors.border, shadowColor: dark ? 'transparent' : colors.shadow }]}>
              <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.text }]}>Review transaction</Text>
              {prepared.candidate ? (
                <View style={[styles.summary, { borderBottomColor: colors.rule }]}>
                  <Text style={[styles.summaryAmount, { color: colors.text }]}>
                    {direction === 'credit' ? '+' : '−'}{amountValue.amountPaise === null ? 'Amount needs correction' : exactMoney(amountValue.amountPaise)}
                  </Text>
                  <Text style={[styles.bodyCopy, { color: colors.textSecondary }]}>
                    {merchant.trim() || 'Merchant not identified'} · {kind ? displayKind(kind) : 'Type needed'} · {status || 'Status needed'}
                  </Text>
                  <Text style={[styles.hint, { color: colors.textSecondary }]}>
                    {dateText ? 'India date ' + dateText : 'Date needs review'}
                  </Text>
                </View>
              ) : (
                <Text style={[styles.bodyCopy, { color: colors.textSecondary }]}>No transaction details were found. Fill in the required fields.</Text>
              )}

              {canOfferSeparatePayment ? (
                <View style={[styles.warning, { borderTopColor: colors.rule }]}>
                  <Text style={[styles.warningTitle, { color: colors.text }]}>Same message or separate payment?</Text>
                  <Text style={[styles.bodyCopy, { color: colors.textSecondary }]}>
                    {prepared.collision?.deleted
                      ? 'This message matches a saved paste that was later deleted. It stays handled unless you deliberately choose another purchase.'
                      : 'An identical message is already recorded. It stays the same message unless you deliberately choose another purchase.'}
                  </Text>
                  <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel="Resolve identical paste">
                    <Choice label="Same message" selected={!separatePayment} disabled={busy} onPress={() => { setSeparatePayment(false); setError(''); }} />
                    <Choice label="Separate payment" selected={separatePayment} disabled={busy} onPress={() => { setSeparatePayment(true); setDetailsOpen(true); setError(''); }} />
                  </View>
                  {separatePayment ? <Text style={[styles.hint, { color: colors.textSecondary }]}>The existing India date and time are filled in below. Set this purchase’s actual time; entries in the same second must be added manually.</Text> : null}
                </View>
              ) : null}

              <Field label="Amount (₹)" hint={amountValue.message}>
                <TextInput
                  accessibilityLabel="Transaction amount in rupees"
                  editable={!busy}
                  keyboardType="decimal-pad"
                  onChangeText={setAmountText}
                  placeholder="0.00"
                  placeholderTextColor={colors.textSecondary}
                  selectTextOnFocus
                  style={inputStyle}
                  value={amountText}
                />
              </Field>

              {reviewFieldsValid && !separatePayment ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: detailsVisible, disabled: busy }}
                  aria-expanded={detailsVisible}
                  disabled={busy}
                  onPress={() => {
                    if (detailsVisible) Keyboard.dismiss();
                    setDetailsOpen(!detailsVisible);
                  }}
                  style={({ pressed }) => [styles.detailsToggle, { borderColor: colors.border, opacity: busy ? 0.45 : pressed ? 0.7 : 1 }]}>
                  <Text style={[styles.detailsToggleText, { color: colors.text }]}>{detailsVisible ? 'Hide details' : 'Edit details'}</Text>
                </Pressable>
              ) : null}

              {detailsVisible ? <View style={styles.details}>
                <Field label="Direction">
                  <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel="Transaction direction">
                    {directions.map((value) => <Choice key={value} label={value === 'debit' ? 'Debit' : 'Credit'} selected={direction === value} disabled={busy} onPress={() => changeDirection(value)} />)}
                  </View>
                </Field>
                <Field label="Transaction type">
                  <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel="Transaction type">
                    {kinds.map((value) => <Choice key={value} label={displayKind(value)} selected={kind === value} disabled={busy} onPress={() => changeKind(value)} />)}
                  </View>
                  {!consistentKind || !consistentIncome ? <Text style={[styles.error, { color: colors.over }]}>Expenses must be debits and income must be credits.</Text> : null}
                </Field>
                <Field label="Status">
                  <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel="Transaction status">
                    {statuses.map((value) => <Choice key={value} label={value} selected={status === value} disabled={busy} onPress={() => setStatus(value)} />)}
                  </View>
                </Field>
                <Field label="Transaction date">
                  <TextInput
                    accessibilityLabel="Transaction date in India calendar, year month day"
                    editable={!busy}
                    keyboardType="numbers-and-punctuation"
                    onChangeText={setDateText}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={colors.textSecondary}
                    style={inputStyle}
                    value={dateText}
                  />
                  {dateText && !parsedDate ? <Text style={[styles.error, { color: colors.over }]}>Enter a real date as YYYY-MM-DD.</Text> : null}
                  {separatePayment ? (
                    <>
                      <Text style={[styles.label, { color: colors.text }]}>Transaction time (India)</Text>
                      <TextInput
                        accessibilityLabel="Transaction time in India, 24-hour hours minutes seconds"
                        editable={!busy}
                        keyboardType="numbers-and-punctuation"
                        maxLength={8}
                        onChangeText={setTimeText}
                        placeholder="HH:MM:SS"
                        placeholderTextColor={colors.textSecondary}
                        style={inputStyle}
                        value={timeText}
                      />
                      {!separatePaymentAt ? <Text style={[styles.error, { color: colors.over }]}>Enter a valid 24-hour time as HH:MM:SS.</Text> : null}
                      {sameCollisionSecond ? <Text style={[styles.error, { color: colors.over }]}>Choose a different actual time. Purchases in the same second must be entered manually.</Text> : null}
                    </>
                  ) : null}
                </Field>
                <Field label="Merchant or person">
                  <TextInput accessibilityLabel="Merchant or person" editable={!busy} onChangeText={setMerchant} placeholder="Optional" placeholderTextColor={colors.textSecondary} style={inputStyle} value={merchant} />
                </Field>
                <Field label="Category">
                  <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel="Transaction category">
                    <Choice label="No category" selected={categoryId === null} disabled={busy} onPress={() => setCategoryId(null)} />
                    {availableCategories.map((category) => (
                      <Choice key={category.id} label={category.name} selected={categoryId === category.id} disabled={busy} onPress={() => setCategoryId(category.id)} />
                    ))}
                  </View>
                  {availableCategories.length === 0 ? <Text style={[styles.hint, { color: colors.textSecondary }]}>No matching categories are available yet.</Text> : null}
                  {!selectedCategoryIsValid ? <Text style={[styles.error, { color: colors.over }]}>Choose a category that matches this transaction type.</Text> : null}
                </Field>
                <Field label="Account">
                  <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel="Transaction account">
                    <Choice label="No account" selected={accountId === null} disabled={busy} onPress={() => setAccountId(null)} />
                    {accounts.map((account) => {
                      const detail = [account.institution, account.last4 ? '••' + account.last4 : null].filter(Boolean).join(' · ');
                      return <Choice key={account.id} label={detail ? account.name + ' · ' + detail : account.name} selected={accountId === account.id} disabled={busy} onPress={() => setAccountId(account.id)} />;
                    })}
                  </View>
                  {accounts.length === 0 ? <Text style={[styles.hint, { color: colors.textSecondary }]}>No accounts set up; leave blank.</Text> : null}
                </Field>
                <Field label="UPI reference (optional)">
                  <TextInput accessibilityLabel="UPI reference, optional" autoCapitalize="none" autoCorrect={false} editable={!busy} onChangeText={(value) => { setReference(value); if (value.trim()) setSeparatePayment(false); }} placeholder="Reference number" placeholderTextColor={colors.textSecondary} style={inputStyle} value={reference} />
                </Field>
                <Field label="Note (optional)">
                  <TextInput accessibilityLabel="Transaction note, optional" editable={!busy} multiline onChangeText={setNote} placeholder="Add context for yourself" placeholderTextColor={colors.textSecondary} style={[...inputStyle, styles.noteInput]} textAlignVertical="top" value={note} />
                </Field>

                <Pressable
                  accessibilityRole="checkbox"
                  aria-checked={excludeFromStats}
                  accessibilityState={{ checked: excludeFromStats, disabled: busy }}
                  disabled={busy}
                  onPress={() => setExcludeFromStats((value) => !value)}
                  style={styles.checkRow}>
                  <View style={[styles.checkbox, { borderColor: colors.border, backgroundColor: excludeFromStats ? colors.accent : 'transparent' }]}>
                    {excludeFromStats ? <View style={[styles.checkMark, { backgroundColor: colors.onAccent }]} /> : null}
                  </View>
                  <Text style={[styles.bodyCopy, { color: colors.text }]}>Exclude from totals</Text>
                </Pressable>
              </View> : null}

              {duplicateReviewRequired ? (
                <View style={[styles.warning, { borderTopColor: colors.rule }]}>
                  <Text style={[styles.warningTitle, { color: colors.text }]}>Duplicate risk</Text>
                  <Text style={[styles.bodyCopy, { color: colors.textSecondary }]}>Earlier pastes can’t be checked. Review every paste; duplicates may be added.</Text>
                  <Pressable
                    accessibilityRole="checkbox"
                    aria-checked={riskAcknowledged}
                    accessibilityState={{ checked: riskAcknowledged, disabled: busy }}
                    disabled={busy}
                    onPress={() => setRiskAcknowledged((value) => !value)}
                    style={styles.checkRow}>
                    <View style={[styles.checkbox, { borderColor: colors.border, backgroundColor: riskAcknowledged ? colors.accent : 'transparent' }]}>
                      {riskAcknowledged ? <View style={[styles.checkMark, { backgroundColor: colors.onAccent }]} /> : null}
                    </View>
                    <Text style={[styles.bodyCopy, { color: colors.text }]}>I understand; allow this save</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          )}
        </ScrollView>

        <View style={[styles.footer, { backgroundColor: colors.background, borderTopColor: colors.rule }]}>
          {error ? <Text accessibilityRole="alert" style={[styles.error, { color: colors.over }]}>{error}</Text> : null}
          {discardPromptOpen ? (
            <View style={styles.actions}>
              <Text style={[styles.bodyCopy, { color: colors.text }]}>Discard this paste?</Text>
              <View style={styles.actionRow}>
                <Pressable accessibilityRole="button" onPress={() => setDiscardPromptOpen(false)} style={({ pressed }) => [styles.secondaryButton, styles.actionButton, { borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}>
                  <Text style={[styles.secondaryLabel, { color: colors.text }]}>Keep editing</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={discard} style={({ pressed }) => [styles.primaryButton, styles.actionButton, { backgroundColor: colors.over, borderColor: colors.border, opacity: pressed ? 0.78 : 1 }]}>
                  <Text style={[styles.primaryLabel, { color: colors.backgroundElement }]}>Discard</Text>
                </Pressable>
              </View>
            </View>
          ) : prepared?.kind === 'ignored' ? (
            <View style={styles.actions}>
              <Pressable accessibilityRole="button" disabled={busy} onPress={resetReview} style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.accent, borderColor: colors.border, opacity: busy ? 0.45 : pressed ? 0.78 : 1 }]}>
                <Text style={[styles.primaryLabel, { color: colors.onAccent }]}>Paste another</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={busy} onPress={discard} style={({ pressed }) => [styles.secondaryButton, { borderColor: colors.border, opacity: busy ? 0.45 : pressed ? 0.7 : 1 }]}>
                <Text style={[styles.secondaryLabel, { color: colors.text }]}>Done</Text>
              </Pressable>
            </View>
          ) : outcome ? (
            <Pressable accessibilityRole="button" onPress={complete} style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.accent, borderColor: colors.border, opacity: pressed ? 0.78 : 1 }]}>
              <Text style={[styles.primaryLabel, { color: colors.onAccent }]}>Done</Text>
            </Pressable>
          ) : prepared?.kind === 'needs-review' ? (
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={busy ? 'Saving transaction' : duplicateReviewRequired ? separatePayment ? 'Save separate payment despite duplicate risk' : 'Save despite duplicate risk' : separatePayment ? 'Save separate payment' : 'Save transaction'}
                aria-busy={busy}
                accessibilityState={{ disabled: !canSave, busy }}
                disabled={!canSave}
                onPress={save}
                style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.accent, borderColor: colors.border, opacity: !canSave ? 0.45 : pressed ? 0.78 : 1 }]}>
                <Text style={[styles.primaryLabel, { color: colors.onAccent }]}>{busy ? 'Saving…' : duplicateReviewRequired ? separatePayment ? 'Save separate payment anyway' : 'Save anyway' : separatePayment ? 'Save separate payment' : 'Save transaction'}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={requestCancel} style={({ pressed }) => [styles.secondaryButton, { borderColor: colors.border, opacity: busy ? 0.45 : pressed ? 0.7 : 1 }]}>
                <Text style={[styles.secondaryLabel, { color: colors.text }]}>Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={busy ? 'Reading message' : 'Review message'}
                aria-busy={busy}
                accessibilityState={{ disabled: !canPrepare, busy }}
                disabled={!canPrepare}
                onPress={prepare}
                style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.accent, borderColor: colors.border, opacity: !canPrepare ? 0.45 : pressed ? 0.78 : 1 }]}>
                <Text style={[styles.primaryLabel, { color: colors.onAccent }]}>{busy ? 'Reading…' : 'Review message'}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={requestCancel} style={({ pressed }) => [styles.secondaryButton, { borderColor: colors.border, opacity: busy ? 0.45 : pressed ? 0.7 : 1 }]}>
                <Text style={[styles.secondaryLabel, { color: colors.text }]}>Cancel</Text>
              </Pressable>
            </View>
          )}
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1 },
  scroll: { flex: 1 },
  content: { width: '100%', maxWidth: 640, alignSelf: 'center', paddingHorizontal: Spacing.gutter, paddingTop: Spacing.four, paddingBottom: Spacing.four, gap: Spacing.three },
  header: { gap: Spacing.two, marginBottom: Spacing.two },
  title: { ...Type.screenTitle },
  sectionTitle: { ...Type.sectionTitle },
  bodyCopy: { ...Type.body, flexShrink: 1 },
  hint: { ...Type.note },
  label: { ...Type.label },
  panel: {
    padding: Spacing.three,
    gap: Spacing.three,
    borderWidth: Stroke.ink,
    borderRadius: Radius.card,
    shadowOffset: { width: 3, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 0,
  },
  field: { gap: Spacing.two },
  input: {
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: Stroke.ink,
    borderRadius: Radius.control,
    fontFamily: Fonts.sans,
    fontSize: Type.body.fontSize,
    lineHeight: Type.body.lineHeight,
  },
  messageInput: { minHeight: 128, paddingTop: 12 },
  noteInput: { minHeight: 88 },
  details: { gap: Spacing.three },
  detailsToggle: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: Spacing.three, borderWidth: Stroke.ink, borderRadius: Radius.pill },
  detailsToggleText: { ...Type.body, fontFamily: Fonts.sansSemiBold },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  choice: { minHeight: 44, maxWidth: '100%', justifyContent: 'center', paddingHorizontal: 14, borderWidth: Stroke.ink, borderRadius: Radius.pill },
  choiceText: { ...Type.label, flexShrink: 1, textTransform: 'capitalize' },
  summary: { gap: Spacing.one, paddingBottom: Spacing.three, borderBottomWidth: Stroke.hairline },
  summaryAmount: { ...Type.amount },
  error: { ...Type.note },
  warning: { paddingTop: Spacing.three, gap: Spacing.two, borderTopWidth: Stroke.hairline },
  warningTitle: { ...Type.rowTitle },
  checkRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  checkbox: { width: 24, height: 24, borderWidth: Stroke.ink, borderRadius: Radius.tile, alignItems: 'center', justifyContent: 'center' },
  checkMark: { width: 10, height: 10, borderRadius: 2 },
  footer: { width: '100%', maxWidth: 640, alignSelf: 'center', paddingHorizontal: Spacing.gutter, paddingTop: Spacing.two, paddingBottom: Platform.OS === 'web' ? Spacing.tabBarClearance : Spacing.two, borderTopWidth: Stroke.hairline, gap: Spacing.two },
  actions: { gap: Spacing.two },
  actionRow: { flexDirection: 'row', gap: Spacing.two },
  actionButton: { flex: 1 },
  primaryButton: { minHeight: 52, paddingHorizontal: Spacing.three, alignItems: 'center', justifyContent: 'center', borderWidth: Stroke.ink, borderRadius: Radius.pill, shadowOffset: { width: 2, height: 3 }, shadowOpacity: 0.18, shadowRadius: 0 },
  primaryLabel: { ...Type.rowTitle },
  secondaryButton: { minHeight: 48, paddingHorizontal: Spacing.three, alignItems: 'center', justifyContent: 'center', borderWidth: Stroke.ink, borderRadius: Radius.pill },
  secondaryLabel: { ...Type.body },
});
