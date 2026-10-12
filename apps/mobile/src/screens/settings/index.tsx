import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import * as Crypto from 'expo-crypto';

import { LedgerButton } from '@/components/ledger-controls';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Fonts, Radius, Shadow, Spacing, Stroke, Type } from '@/constants/theme';
import { accountTypes, categoryKinds } from '@/db/schema';
import { getLedger, type DataLayer, type NewAccount, type NewCategory } from '@/db';
import { useTheme } from '@/hooks/use-theme';
import { indiaDate } from '@/utils/display';
import { saveCsv } from '@/exports/save-csv';
import { ExportCleanupError } from '@/exports/save-csv-write';

type Account = Awaited<ReturnType<DataLayer['listAccounts']>>[number];
type Category = Awaited<ReturnType<DataLayer['listCategories']>>[number];
type AccountKind = typeof accountTypes[number];
type CategoryKind = typeof categoryKinds[number];
type AccountFields = Pick<NewAccount, 'name' | 'type'> & { institution?: string | null; last4?: string | null };
type CategoryFields = Pick<NewCategory, 'name' | 'kind'>;
type Theme = ReturnType<typeof useTheme>;

const accountLabels: Record<AccountKind, string> = {
  bank: 'Bank account',
  credit_card: 'Credit card',
  wallet: 'Wallet',
  upi_lite: 'UPI Lite',
  cash: 'Cash',
};

const categoryLabels: Record<CategoryKind, string> = { expense: 'Expense', income: 'Income' };

export default function SettingsScreen() {
  const theme = useTheme();
  const dark = theme.background === Colors.dark.background;
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [entryCount, setEntryCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null);
  const [accountEditor, setAccountEditor] = useState<string | 'new' | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [categoryEditor, setCategoryEditor] = useState<string | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const operationGuard = useRef(false);

  const refresh = useCallback(async (isCurrent: () => boolean = () => true) => {
    try {
      const ledger = await getLedger();
      const [nextAccounts, nextCategories, entries] = await Promise.all([
        ledger.listAccounts(true),
        ledger.listCategories(),
        ledger.listTransactions(),
      ]);
      if (!isCurrent()) return;
      setAccounts(nextAccounts);
      setCategories(nextCategories);
      setEntryCount(entries.length);
      setLoadError(false);
    } catch {
      if (isCurrent()) setLoadError(true);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    let focused = true;
    setLoading(true);
    void refresh(() => focused);
    return () => { focused = false; };
  }, [refresh]));

  const saveAccount = useCallback(async (fields: AccountFields, id?: string, createId?: string): Promise<string | null> => {
    if (operationGuard.current) return 'Another settings action is finishing. Try again in a moment.';
    operationGuard.current = true;
    setPending('account');
    setNotice(null);
    try {
      const ledger = await getLedger();
      if (id) {
        if (!await ledger.updateAccount(id, fields)) return 'This account is no longer available. Refresh and try again.';
      } else {
        const input: NewAccount = {
          id: createId ?? Crypto.randomUUID(), name: fields.name, type: fields.type,
          ...(fields.institution ? { institution: fields.institution } : {}),
          ...(fields.last4 ? { last4: fields.last4 } : {}),
        };
        await ledger.createAccount(input);
      }
      await refresh();
      setNotice({ text: id ? 'Account updated.' : 'Account added.' });
      return null;
    } catch {
      return 'Could not save this account. Your changes are still here; try again.';
    } finally {
      setPending(null);
      operationGuard.current = false;
    }
  }, [refresh]);

  const archiveAccount = useCallback(async (id: string) => {
    if (operationGuard.current) return;
    operationGuard.current = true;
    setPending(`archive:${id}`);
    setNotice(null);
    try {
      const ledger = await getLedger();
      if (!await ledger.archiveAccount(id)) throw new Error('Account unavailable');
      setConfirmArchive(null);
      setExpandedAccount(null);
      setNotice({ text: 'Account archived. Existing entries keep their account link.' });
      await refresh();
    } catch {
      setNotice({ text: 'Could not archive this account. Your entries are unchanged; try again.', error: true });
    } finally {
      setPending(null);
      operationGuard.current = false;
    }
  }, [refresh]);

  const saveCategory = useCallback(async (fields: CategoryFields, id?: string, createId?: string): Promise<string | null> => {
    if (operationGuard.current) return 'Another settings action is finishing. Try again in a moment.';
    operationGuard.current = true;
    setPending('category');
    setNotice(null);
    try {
      const ledger = await getLedger();
      if (id) {
        if (!await ledger.updateCategory(id, fields)) return 'This category is no longer available. Refresh and try again.';
      } else {
        await ledger.createCategory({ id: createId ?? Crypto.randomUUID(), ...fields });
      }
      await refresh();
      setNotice({ text: id ? 'Category updated.' : 'Category added.' });
      return null;
    } catch (error) {
      if (error instanceof Error && /kind|budget|category/i.test(error.message)) {
        return 'Could not change this category. Saved entries or budgets may still refer to it.';
      }
      return 'Could not save this category. Your changes are still here; try again.';
    } finally {
      setPending(null);
      operationGuard.current = false;
    }
  }, [refresh]);

  const deleteCategory = useCallback(async (category: Category) => {
    if (category.isSystem) {
      setNotice({ text: 'Built-in categories cannot be removed.', error: true });
      return;
    }
    if (operationGuard.current) return;
    operationGuard.current = true;
    setPending(`delete:${category.id}`);
    setNotice(null);
    try {
      const ledger = await getLedger();
      const deleted = await ledger.deleteCategory(category.id);
      if (!deleted) {
        setConfirmDelete(null);
        setNotice({ text: 'This category is already gone. Refresh Settings to update the list.' });
        await refresh();
        return;
      }
      setConfirmDelete(null);
      setExpandedCategory(null);
      setNotice({ text: 'Category removed.' });
      await refresh();
    } catch (error) {
      setNotice({
        text: error instanceof Error && /referenced/i.test(error.message)
          ? 'This category is linked to an entry, budget, or another category. Clear those links before removing it.'
          : 'Could not remove this category. No linked entries were changed.',
        error: true,
      });
    } finally {
      setPending(null);
      operationGuard.current = false;
    }
  }, [refresh]);

  const exportCsv = useCallback(async () => {
    if (operationGuard.current) return;
    operationGuard.current = true;
    setPending('export');
    setExportError(null);
    setNotice(null);
    try {
      const ledger = await getLedger();
      const content = await ledger.exportTransactionsCsv();
      const result = await saveCsv(content, `transactions-${indiaDate()}.csv`);
      setNotice({ text: result === 'cancelled' ? 'Export cancelled. No file was created.'
        : Platform.OS === 'web' ? 'Download requested. Check your downloads.' : 'CSV saved to your chosen file.' });
    } catch (error) {
      setExportError(error instanceof ExportCleanupError
        ? 'Export couldn’t finish. Check the selected location for an incomplete CSV before retrying. Your ledger is unchanged.'
        : 'Export couldn’t finish. Your ledger is unchanged; try again.');
    } finally {
      setPending(null);
      operationGuard.current = false;
    }
  }, []);

  const activeAccounts = accounts.filter((account) => !account.archived);
  const archivedAccounts = accounts.filter((account) => account.archived);
  const expenses = categories.filter((category) => category.kind === 'expense');
  const incomes = categories.filter((category) => category.kind === 'income');
  const busy = pending !== null;

  return (
    <ThemedView style={styles.fill}>
      <SafeAreaView edges={['top']} style={styles.fill}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <ThemedText style={Type.screenTitle}>Settings</ThemedText>

          <View style={[styles.hero, {
            backgroundColor: theme.heroBackground,
            ...(dark ? {} : { boxShadow: Shadow.card }),
          }]}>
            <ThemedText style={[styles.heroTitle, { color: theme.heroText }]}>Your money stays here.</ThemedText>
            <ThemedText style={[Type.body, { color: theme.heroTextSecondary }]}>
              Stored on this device; pasted message text is never saved.
            </ThemedText>
            <View style={[styles.stats, { borderColor: theme.heroRule }]}>
              <Stat label="Entries" value={entryCount === null ? '—' : String(entryCount)} theme={theme} />
              <Stat label="Accounts" value={loading ? '—' : String(activeAccounts.length)} theme={theme} />
              <Stat label="Texts stored" value="0" theme={theme} highlight />
            </View>
          </View>

          {loading ? <View accessibilityRole="progressbar" accessibilityLabel="Loading settings" style={[styles.loadLine, { backgroundColor: theme.backgroundSelected }]}><ActivityIndicator color={theme.textSecondary} /></View> : null}
          {loadError ? <View style={styles.messageLine}>
            <ThemedText accessibilityRole="alert" style={[Type.note, { color: theme.over }]}>Settings couldn’t load. Your saved data is still on this device.</ThemedText>
            <LedgerButton label="Retry" onPress={() => { setLoading(true); void refresh(); }} />
          </View> : null}
          {notice ? <ThemedText accessibilityRole="alert" style={[Type.note, styles.message, { color: notice.error ? theme.over : theme.text }]}>{notice.text}</ThemedText> : null}

          <View style={styles.section}>
            <SectionHeading title="Sources" theme={theme} />
            <SettingsGroup theme={theme}>
              <StaticRow title="Add manually" detail="Add an expense or income." theme={theme} />
              <StaticRow last title="Paste a message" detail="Check details before saving." theme={theme} />
            </SettingsGroup>
          </View>

          <View style={styles.section}>
            <SectionHeading title="Accounts" theme={theme} />
            <SettingsGroup theme={theme}>
              {loading && accounts.length === 0 ? <LoadingRow theme={theme} /> : null}
              {!loading && activeAccounts.length === 0 ? <StaticRow title="No accounts added." theme={theme} /> : null}
              {activeAccounts.map((account, index) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  theme={theme}
                  expanded={expandedAccount === account.id}
                  editing={accountEditor === account.id}
                  confirmingArchive={confirmArchive === account.id}
                  pending={pending === `archive:${account.id}`}
                  disabled={busy || (accountEditor !== null && accountEditor !== account.id)}
                  last={index === activeAccounts.length - 1 && archivedAccounts.length === 0 && accountEditor !== 'new'}
                  onToggle={() => { setExpandedAccount(expandedAccount === account.id ? null : account.id); setConfirmArchive(null); }}
                  onEdit={() => { setAccountEditor(account.id); setCategoryEditor(null); setConfirmArchive(null); setConfirmDelete(null); }}
                  onCancelEdit={() => setAccountEditor(null)}
                  onSave={(fields) => saveAccount(fields, account.id)}
                  onAskArchive={() => { setConfirmArchive(account.id); setNotice(null); }}
                  onCancelArchive={() => setConfirmArchive(null)}
                  onArchive={() => void archiveAccount(account.id)}
                />
              ))}
              {accountEditor === 'new' ? <AccountEditor theme={theme} pending={pending === 'account'} disabled={busy && pending !== 'account'} onCancel={() => setAccountEditor(null)} onSave={(fields, createId) => saveAccount(fields, undefined, createId)} /> : null}
              {archivedAccounts.length > 0 ? (
                <DisclosureRow
                  title="Archived accounts"
                  detail={`${archivedAccounts.length}`}
                  expanded={showArchived}
                  theme={theme}
                  onPress={() => setShowArchived((value) => !value)}
                  last={!showArchived && accountEditor !== 'new'}
                />
              ) : null}
              {showArchived ? <View style={styles.nestedRows}>
                {archivedAccounts.map((account, index) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    theme={theme}
                    archived
                    expanded={expandedAccount === account.id}
                    editing={accountEditor === account.id}
                    confirmingArchive={false}
                    pending={pending === 'account'}
                    disabled={busy || (accountEditor !== null && accountEditor !== account.id)}
                    last={index === archivedAccounts.length - 1}
                    onToggle={() => setExpandedAccount(expandedAccount === account.id ? null : account.id)}
                    onEdit={() => { setAccountEditor(account.id); setConfirmArchive(null); setConfirmDelete(null); }}
                    onCancelEdit={() => setAccountEditor(null)}
                    onSave={(fields) => saveAccount(fields, account.id)}
                    onAskArchive={() => {}}
                    onCancelArchive={() => {}}
                    onArchive={() => {}}
                  />
                ))}
                <ThemedText style={[Type.note, styles.archivedNote]}>Past entries keep their account link. Archived accounts are hidden from new entries.</ThemedText>
              </View> : null}
              <GroupAction theme={theme} last={accountEditor !== 'new'}>
                <LedgerButton label="Add account" disabled={busy || loading || accountEditor !== null} onPress={() => { setAccountEditor('new'); setExpandedAccount(null); setCategoryEditor(null); setConfirmArchive(null); setConfirmDelete(null); }} />
              </GroupAction>
            </SettingsGroup>
          </View>

          <View style={styles.section}>
            <SectionHeading title="Ledger" theme={theme} />
            <SettingsGroup theme={theme}>
              <DisclosureRow
                title="Categories"
                detail={loading ? '—' : String(categories.length)}
                expanded={categoriesOpen}
                theme={theme}
                onPress={() => { setCategoriesOpen((value) => !value); setConfirmDelete(null); }}
                last={!categoriesOpen}
              />
              {categoriesOpen ? <View style={styles.categoryContents}>
                {loading ? <LoadingRow theme={theme} /> : null}
                {!loading && categories.length === 0 ? <ThemedText style={[Type.note, styles.emptyCopy]}>No categories yet.</ThemedText> : null}
                {expenses.length > 0 ? <ThemedText style={[Type.label, styles.kindHeading]}>Expenses</ThemedText> : null}
                {expenses.map((category, index) => (
                  <CategoryRow
                    key={category.id}
                    category={category}
                    theme={theme}
                    expanded={expandedCategory === category.id}
                    editing={categoryEditor === category.id}
                    confirmingDelete={confirmDelete === category.id}
                    pending={pending === `delete:${category.id}`}
                    disabled={busy || (categoryEditor !== null && categoryEditor !== category.id)}
                    last={index === expenses.length - 1 && incomes.length === 0 && categoryEditor !== 'new'}
                    onToggle={() => { setExpandedCategory(expandedCategory === category.id ? null : category.id); setConfirmDelete(null); }}
                    onEdit={() => { setCategoryEditor(category.id); setConfirmDelete(null); setAccountEditor(null); }}
                    onCancelEdit={() => setCategoryEditor(null)}
                    onSave={(fields) => saveCategory(fields, category.id)}
                    onAskDelete={() => { setConfirmDelete(category.id); setNotice(null); }}
                    onCancelDelete={() => setConfirmDelete(null)}
                    onDelete={() => void deleteCategory(category)}
                  />
                ))}
                {incomes.length > 0 ? <ThemedText style={[Type.label, styles.kindHeading]}>Income</ThemedText> : null}
                {incomes.map((category, index) => (
                  <CategoryRow
                    key={category.id}
                    category={category}
                    theme={theme}
                    expanded={expandedCategory === category.id}
                    editing={categoryEditor === category.id}
                    confirmingDelete={confirmDelete === category.id}
                    pending={pending === `delete:${category.id}`}
                    disabled={busy || (categoryEditor !== null && categoryEditor !== category.id)}
                    last={index === incomes.length - 1 && categoryEditor !== 'new'}
                    onToggle={() => { setExpandedCategory(expandedCategory === category.id ? null : category.id); setConfirmDelete(null); }}
                    onEdit={() => { setCategoryEditor(category.id); setConfirmDelete(null); setAccountEditor(null); }}
                    onCancelEdit={() => setCategoryEditor(null)}
                    onSave={(fields) => saveCategory(fields, category.id)}
                    onAskDelete={() => { setConfirmDelete(category.id); setNotice(null); }}
                    onCancelDelete={() => setConfirmDelete(null)}
                    onDelete={() => void deleteCategory(category)}
                  />
                ))}
                {categoryEditor === 'new' ? <CategoryEditor theme={theme} pending={pending === 'category'} disabled={busy && pending !== 'category'} onCancel={() => setCategoryEditor(null)} onSave={(fields, createId) => saveCategory(fields, undefined, createId)} /> : null}
                <GroupAction theme={theme} last={categoryEditor !== 'new'}>
                  <LedgerButton label="Add category" disabled={busy || loading || categoryEditor !== null} onPress={() => { setCategoryEditor('new'); setExpandedCategory(null); setConfirmDelete(null); setAccountEditor(null); setConfirmArchive(null); }} />
                </GroupAction>
              </View> : null}
            </SettingsGroup>
          </View>

          <View style={styles.section}>
            <SectionHeading title="Your data" theme={theme} />
            <SettingsGroup theme={theme}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={Platform.OS === 'ios' ? 'Export to CSV, not available on iOS yet' : `Export ${entryCount ?? 0} entries to CSV`}
                accessibilityHint={Platform.OS === 'ios' ? 'CSV export is not available on iOS yet.' : Platform.OS === 'android' ? 'Choose a location and filename for a single CSV file on this device.' : 'Downloads a copy in your browser.'}
                accessibilityState={{ disabled: Platform.OS === 'ios' || busy || loading, busy: pending === 'export' }}
                aria-busy={pending === 'export'}
                disabled={Platform.OS === 'ios' || busy || loading}
                onPress={() => void exportCsv()}
                style={({ pressed }) => [styles.exportRow, { borderBottomColor: theme.rule, opacity: Platform.OS === 'ios' || busy || loading ? 0.55 : pressed ? 0.72 : 1 }]}
              >
                <View style={styles.rowCopy}>
                  <ThemedText style={Type.rowTitle}>Export to CSV</ThemedText>
                  <ThemedText style={Type.note}>{Platform.OS === 'ios' ? 'Not available on iOS yet' : `${entryCount ?? '—'} entries`}</ThemedText>
                </View>
                {pending === 'export' ? <ActivityIndicator color={theme.textSecondary} /> : null}
              </Pressable>
              {exportError ? <ThemedText accessibilityRole="alert" style={[Type.note, styles.exportError, { color: theme.over }]}>{exportError}</ThemedText> : null}
            </SettingsGroup>
            <ThemedText style={[Type.note, styles.exportNote]}>Local file · not encrypted.</ThemedText>
          </View>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

function Stat({ label, value, theme, highlight = false }: { label: string; value: string; theme: Theme; highlight?: boolean }) {
  return <View style={styles.stat}>
    <ThemedText style={[Type.label, { color: theme.heroTextSecondary }]}>{label}</ThemedText>
    <ThemedText style={[Type.amountSmall, styles.statValue, {
      color: theme.heroText,
      ...(highlight ? { color: theme.accent } : {}),
    }]}>{value}</ThemedText>
  </View>;
}

function SectionHeading({ title, detail, theme }: { title: string; detail?: string; theme: Theme }) {
  return <View style={styles.sectionHeading}>
    <ThemedText style={Type.sectionTitle}>{title}</ThemedText>
    {detail ? <ThemedText style={[Type.note, { color: theme.textSecondary }]}>{detail}</ThemedText> : null}
  </View>;
}

function SettingsGroup({ children, theme }: { children: ReactNode; theme: Theme }) {
  const dark = theme.background === Colors.dark.background;
  return <View style={[styles.group, {
    backgroundColor: theme.backgroundElement,
    borderColor: theme.border,
    ...(dark ? {} : { boxShadow: Shadow.card }),
  }]}>{children}</View>;
}

function StaticRow({ title, detail, theme, last = false }: { title: string; detail?: string; theme: Theme; last?: boolean }) {
  return <View style={[styles.staticRow, !last && { borderBottomColor: theme.rule, borderBottomWidth: StyleSheet.hairlineWidth }]}>
    <View style={styles.rowCopy}>
      <ThemedText style={Type.rowTitle}>{title}</ThemedText>
      {detail ? <ThemedText style={[Type.note, { color: theme.textSecondary }]}>{detail}</ThemedText> : null}
    </View>
  </View>;
}

function LoadingRow({ theme }: { theme: Theme }) {
  return <View accessibilityLiveRegion="polite" style={[styles.loadingRow, { backgroundColor: theme.backgroundSelected }]}>
    <ThemedText style={Type.note}>Loading saved settings…</ThemedText>
  </View>;
}

function DisclosureRow({ title, detail, expanded, theme, onPress, last = false }: {
  title: string; detail: string; expanded: boolean; theme: Theme; onPress: () => void; last?: boolean;
}) {
  return <Pressable
    accessibilityRole="button"
    accessibilityState={{ expanded }}
    aria-expanded={expanded}
    onPress={onPress}
    style={({ pressed }) => [styles.disclosureRow, !last && { borderBottomColor: theme.rule, borderBottomWidth: StyleSheet.hairlineWidth }, { opacity: pressed ? 0.72 : 1 }]}
  >
    <ThemedText style={[Type.rowTitle, styles.disclosureTitle]}>{title}</ThemedText>
    <ThemedText style={[Type.note, { color: theme.textSecondary }]}>{expanded ? 'Hide' : detail}</ThemedText>
  </Pressable>;
}

function GroupAction({ children, theme, last = false }: { children: ReactNode; theme: Theme; last?: boolean }) {
  return <View style={[styles.groupAction, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.rule }]}>{children}</View>;
}

function AccountRow({ account, theme, archived = false, expanded, editing, confirmingArchive, pending, disabled = false, last = false, onToggle, onEdit, onCancelEdit, onSave, onAskArchive, onCancelArchive, onArchive }: {
  account: Account; theme: Theme; archived?: boolean; expanded: boolean; editing: boolean; confirmingArchive: boolean; pending: boolean; disabled?: boolean; last?: boolean;
  onToggle: () => void; onEdit: () => void; onCancelEdit: () => void; onSave: (fields: AccountFields) => Promise<string | null>; onAskArchive: () => void; onCancelArchive: () => void; onArchive: () => void;
}) {
  const info = [accountLabels[account.type], account.institution, account.last4 ? `•••• ${account.last4}` : null].filter(Boolean).join(' · ');
  return <View>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${expanded ? 'Hide' : 'Manage'} ${archived ? 'archived ' : ''}account ${account.name}`}
      accessibilityState={{ expanded: expanded || editing || confirmingArchive }}
      aria-expanded={expanded || editing || confirmingArchive}
      disabled={disabled || editing || confirmingArchive}
      onPress={onToggle}
      style={({ pressed }) => [styles.dataRow, !last && { borderBottomColor: theme.rule, borderBottomWidth: StyleSheet.hairlineWidth }, { opacity: pressed ? 0.72 : 1 }]}
    >
      <View style={styles.rowCopy}>
        <ThemedText style={Type.rowTitle}>{account.name}</ThemedText>
        <ThemedText style={[Type.note, { color: theme.textSecondary }]}>{archived ? `${info} · Archived` : info}</ThemedText>
      </View>
      <ThemedText style={[Type.label, { color: theme.textSecondary }]}>{expanded ? 'Actions' : 'Manage'}</ThemedText>
    </Pressable>
    {expanded && !editing && !confirmingArchive ? <View style={styles.rowActions}>
      <LedgerButton label="Edit account" disabled={disabled} onPress={onEdit} />
      {!archived ? <DestructiveButton label="Archive" disabled={disabled} theme={theme} onPress={onAskArchive} /> : null}
    </View> : null}
    {confirmingArchive ? <View style={styles.inlinePanel}>
      <ThemedText style={[Type.note, { color: theme.textSecondary }]}>Hide this account from new entries? Existing entries keep their account link.</ThemedText>
      <View style={styles.rowActions}>
        <LedgerButton label="Keep account" disabled={pending} onPress={onCancelArchive} />
        <DestructiveButton label={pending ? 'Archiving…' : 'Archive account'} disabled={pending} theme={theme} onPress={onArchive} />
      </View>
    </View> : null}
    {editing ? <AccountEditor key={account.id} account={account} theme={theme} pending={pending} disabled={disabled} onCancel={onCancelEdit} onSave={onSave} /> : null}
  </View>;
}

function CategoryRow({ category, theme, expanded, editing, confirmingDelete, pending, disabled = false, last = false, onToggle, onEdit, onCancelEdit, onSave, onAskDelete, onCancelDelete, onDelete }: {
  category: Category; theme: Theme; expanded: boolean; editing: boolean; confirmingDelete: boolean; pending: boolean; disabled?: boolean; last?: boolean;
  onToggle: () => void; onEdit: () => void; onCancelEdit: () => void; onSave: (fields: CategoryFields) => Promise<string | null>; onAskDelete: () => void; onCancelDelete: () => void; onDelete: () => void;
}) {
  return <View>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${expanded ? 'Hide' : 'Manage'} ${category.kind} category ${category.name}`}
      accessibilityState={{ expanded: expanded || editing || confirmingDelete }}
      aria-expanded={expanded || editing || confirmingDelete}
      disabled={disabled || editing || confirmingDelete}
      onPress={onToggle}
      style={({ pressed }) => [styles.dataRow, !last && { borderBottomColor: theme.rule, borderBottomWidth: StyleSheet.hairlineWidth }, { opacity: pressed ? 0.72 : 1 }]}
    >
      <View style={styles.rowCopy}>
        <ThemedText style={Type.rowTitle}>{category.name}</ThemedText>
        {category.isSystem ? <ThemedText style={[Type.note, { color: theme.textSecondary }]}>Built-in</ThemedText> : null}
      </View>
      <ThemedText style={[Type.label, { color: theme.textSecondary }]}>{expanded ? 'Actions' : 'Manage'}</ThemedText>
    </Pressable>
    {expanded && !editing && !confirmingDelete ? <View style={styles.rowActions}>
      <LedgerButton label="Edit category" disabled={disabled} onPress={onEdit} />
      <DestructiveButton label={category.isSystem ? 'Built-in' : 'Remove'} disabled={disabled || category.isSystem} theme={theme} onPress={onAskDelete} />
    </View> : null}
    {category.isSystem && expanded ? <ThemedText style={[Type.note, styles.inlineHint]}>Built-in categories can’t be removed.</ThemedText> : null}
    {confirmingDelete ? <View style={styles.inlinePanel}>
      <ThemedText style={[Type.note, { color: theme.textSecondary }]}>Remove “{category.name}”? Entries, budgets, or subcategories can prevent removal.</ThemedText>
      <View style={styles.rowActions}>
        <LedgerButton label="Keep category" disabled={pending} onPress={onCancelDelete} />
        <DestructiveButton label={pending ? 'Removing…' : 'Remove category'} disabled={pending} theme={theme} onPress={onDelete} />
      </View>
    </View> : null}
    {editing ? <CategoryEditor key={category.id} category={category} theme={theme} pending={pending} disabled={disabled} onCancel={onCancelEdit} onSave={onSave} /> : null}
  </View>;
}

function DestructiveButton({ label, theme, onPress, disabled = false }: { label: string; theme: Theme; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.destructiveButton, { borderColor: theme.over, opacity: disabled ? 0.5 : pressed ? 0.72 : 1 }]}>
    <ThemedText style={[Type.note, styles.destructiveText, { color: theme.over }]}>{label}</ThemedText>
  </Pressable>;
}

function AccountEditor({ account, theme, pending, disabled = false, onCancel, onSave }: {
  account?: Account; theme: Theme; pending: boolean; disabled?: boolean; onCancel: () => void; onSave: (fields: AccountFields, createId?: string) => Promise<string | null>;
}) {
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<AccountKind | null>(account?.type ?? null);
  const [institution, setInstitution] = useState(account?.institution ?? '');
  const [last4, setLast4] = useState(account?.last4 ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const createId = useRef<string | null>(null);
  const locked = disabled || pending || saving;

  const submit = async () => {
    const cleanName = name.trim();
    const cleanLast4 = last4.trim();
    if (!cleanName) { setError('Enter an account name.'); return; }
    if (!type) { setError('Choose an account type.'); return; }
    if (cleanLast4 && !/^\d{4}$/.test(cleanLast4)) { setError('Enter exactly four digits, or leave this blank.'); return; }
    setSaving(true); setError('');
    try {
      let stableCreateId: string | undefined;
      if (!account) {
        createId.current ??= Crypto.randomUUID();
        stableCreateId = createId.current;
      }
      const issue = await onSave({ name: cleanName, type, institution: institution.trim() || null, last4: cleanLast4 || null }, stableCreateId);
      if (issue) setError(issue); else onCancel();
    } finally { setSaving(false); }
  };

  return <View style={[styles.editor, { borderColor: theme.rule }]}>
    <ThemedText style={Type.rowTitle}>{account ? 'Edit account' : 'Add account'}</ThemedText>
    <Field label="Account name" value={name} onChangeText={setName} theme={theme} placeholder="For example, salary account" editable={!locked} />
    <ThemedText style={[Type.label, styles.fieldLabel]}>Account type</ThemedText>
    <ChoiceList values={accountTypes} selected={type} labels={accountLabels} onSelect={setType} disabled={locked} />
    <Field label="Institution (optional)" value={institution} onChangeText={setInstitution} theme={theme} placeholder="Bank or provider" editable={!locked} />
    <Field label="Last four digits (optional)" value={last4} onChangeText={(value) => setLast4(value.replace(/\D/g, '').slice(0, 4))} theme={theme} placeholder="1234" keyboardType="number-pad" maxLength={4} editable={!locked} />
    {error ? <ThemedText accessibilityRole="alert" style={[Type.note, { color: theme.over }]}>{error}</ThemedText> : null}
    <View style={styles.rowActions}>
      <LedgerButton label="Cancel" disabled={locked} onPress={onCancel} />
      <LedgerButton label={saving || pending ? 'Saving…' : account ? 'Save account' : 'Add account'} primary disabled={locked} onPress={() => void submit()} />
    </View>
  </View>;
}

function CategoryEditor({ category, theme, pending, disabled = false, onCancel, onSave }: {
  category?: Category; theme: Theme; pending: boolean; disabled?: boolean; onCancel: () => void; onSave: (fields: CategoryFields, createId?: string) => Promise<string | null>;
}) {
  const [name, setName] = useState(category?.name ?? '');
  const [kind, setKind] = useState<CategoryKind | null>(category?.kind ?? null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const createId = useRef<string | null>(null);
  const locked = disabled || pending || saving;

  const submit = async () => {
    const cleanName = name.trim();
    if (!cleanName) { setError('Enter a category name.'); return; }
    if (!kind) { setError('Choose whether this category is for expenses or income.'); return; }
    setSaving(true); setError('');
    try {
      let stableCreateId: string | undefined;
      if (!category) {
        createId.current ??= Crypto.randomUUID();
        stableCreateId = createId.current;
      }
      const issue = await onSave({ name: cleanName, kind }, stableCreateId);
      if (issue) setError(issue); else onCancel();
    } finally { setSaving(false); }
  };

  return <View style={[styles.editor, { borderColor: theme.rule }]}>
    <ThemedText style={Type.rowTitle}>{category ? 'Edit category' : 'Add category'}</ThemedText>
    <Field label="Category name" value={name} onChangeText={setName} theme={theme} placeholder="For example, groceries" editable={!locked} />
    <ThemedText style={[Type.label, styles.fieldLabel]}>Use for</ThemedText>
    <ChoiceList values={categoryKinds} selected={kind} labels={categoryLabels} onSelect={setKind} disabled={locked} />
    {error ? <ThemedText accessibilityRole="alert" style={[Type.note, { color: theme.over }]}>{error}</ThemedText> : null}
    <View style={styles.rowActions}>
      <LedgerButton label="Cancel" disabled={locked} onPress={onCancel} />
      <LedgerButton label={saving || pending ? 'Saving…' : category ? 'Save category' : 'Add category'} primary disabled={locked} onPress={() => void submit()} />
    </View>
  </View>;
}

function Field({ label, value, onChangeText, theme, placeholder, keyboardType = 'default', maxLength, editable = true }: {
  label: string; value: string; onChangeText: (text: string) => void; theme: Theme; placeholder?: string; keyboardType?: 'default' | 'number-pad'; maxLength?: number; editable?: boolean;
}) {
  return <View style={styles.field}>
    <ThemedText style={[Type.label, styles.fieldLabel]}>{label}</ThemedText>
    <TextInput
      accessibilityLabel={label}
      maxLength={maxLength}
      editable={editable}
      keyboardType={keyboardType}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={theme.textSecondary}
      selectionColor={theme.accent}
      value={value}
      style={[Type.body, styles.input, { backgroundColor: theme.backgroundElement, borderColor: theme.border, color: theme.text }]}
    />
  </View>;
}

function ChoiceList<T extends string>({ values, selected, labels, onSelect, disabled }: {
  values: readonly T[]; selected: T | null; labels: Record<T, string>; onSelect: (value: T) => void; disabled: boolean;
}) {
  return <View style={styles.choices}>
    {values.map((value) => <LedgerButton key={value} label={labels[value]} selected={selected === value} disabled={disabled} onPress={() => onSelect(value)} />)}
  </View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { width: '100%', maxWidth: 520, alignSelf: 'center', paddingHorizontal: Spacing.gutter, paddingTop: 52, paddingBottom: Spacing.tabBarClearance },
  hero: { marginTop: 20, padding: 22, borderRadius: Radius.hero, gap: 8 },
  heroTitle: { fontFamily: Fonts.sansHeavy, fontSize: 24, lineHeight: 30, letterSpacing: -0.5 },
  stats: { marginTop: 8, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8 },
  stat: { flex: 1, gap: 5 },
  statValue: { alignSelf: 'flex-start', overflow: 'hidden' },
  section: { marginTop: Spacing.section },
  sectionHeading: { minHeight: 28, marginBottom: 12, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  group: { borderWidth: Stroke.ink, borderRadius: Radius.card },
  staticRow: { minHeight: 72, paddingHorizontal: 16, paddingVertical: 12, justifyContent: 'center' },
  dataRow: { minHeight: 68, paddingHorizontal: 16, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rowCopy: { flex: 1, gap: 2 },
  disclosureRow: { minHeight: 64, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  disclosureTitle: { flex: 1 },
  rowActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  groupAction: { paddingHorizontal: 16, paddingVertical: 10 },
  nestedRows: { paddingLeft: 16 },
  archivedNote: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 14 },
  categoryContents: { paddingBottom: 4 },
  kindHeading: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  emptyCopy: { paddingHorizontal: 16, paddingVertical: 16 },
  editor: { marginHorizontal: 16, marginVertical: 10, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, gap: 12 },
  inlinePanel: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, gap: 8 },
  inlineHint: { paddingHorizontal: 16, paddingBottom: 8 },
  destructiveButton: { minHeight: 44, minWidth: 48, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14, borderWidth: Stroke.ink, borderRadius: Radius.pill },
  destructiveText: { fontFamily: 'BricolageGrotesque_600SemiBold' },
  field: { gap: 5 },
  fieldLabel: { marginBottom: 1 },
  input: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 8, borderWidth: Stroke.ink, borderRadius: Radius.control },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  loadLine: { marginTop: 12, height: 32, borderRadius: Radius.control, alignItems: 'center', justifyContent: 'center' },
  messageLine: { marginTop: 12, gap: 8, alignItems: 'flex-start' },
  message: { marginTop: 12 },
  exportRow: { minHeight: 68, paddingHorizontal: 16, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  exportError: { padding: 16 },
  exportNote: { marginTop: 8, maxWidth: 480 },
  loadingRow: { minHeight: 64, paddingHorizontal: 16, alignItems: 'flex-start', justifyContent: 'center' },
});
