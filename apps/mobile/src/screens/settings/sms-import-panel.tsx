import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, AppState, Pressable, StyleSheet, View } from 'react-native';

import { LedgerButton } from '@/components/ledger-controls';
import { ThemedText } from '@/components/themed-text';
import { Colors, Radius, Shadow, Spacing, Stroke, Type } from '@/constants/theme';
import { type DataLayer, type SmsImportHealth, type SmsReviewPage, type SmsReviewRow } from '@/db';
import { useLedgerVersion } from '@/hooks/use-ledger-version';
import { useTheme } from '@/hooks/use-theme';
import { indiaDate } from '@/utils/display';
import {
  AndroidSmsCatchupError,
  previewAndroidSms,
} from '@/imports/android-sms-catchup';
import {
  abortAndroidSmsCatchup,
  AndroidSmsBackgroundUnavailableError,
  clearAndroidSmsCatchupFailure,
  createAndroidSmsOriginalReader,
  createAndroidSmsOperationGeneration,
  getAndroidSmsCatchupFailure,
  runEnabledAndroidSmsCatchup,
  setAndroidSmsImportSettings,
  shouldAbortAndroidSmsPreviewOnHide,
  subscribeAndroidSmsCatchupFailure,
  type AndroidSmsCatchupFailure,
  type AndroidSmsPreviewPhase,
  type AndroidSmsReviewSelection,
} from '@/imports/android-sms-flow';
import { androidSmsBackgroundScheduler } from '@/imports/android-sms-background-task';
import { getSmsReader, type SmsImportSettings, type SmsPermissionState, type SmsReaderModule, type SmsWakeMetadata } from '../../../modules/sms-reader';

const ninetyDaysMs = 90 * 24 * 60 * 60 * 1_000;

type Preview = { count: number; startDateMs: number; endDateMs: number };

function hasSmsAccess(value: SmsPermissionState | null): boolean {
  return value?.granted === true && value.readSms === true && value.receiveSms === true;
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function backgroundUnavailableCopy(error: AndroidSmsBackgroundUnavailableError): string {
  switch (error.reason) {
    case 'registration':
      return 'Android could not schedule automatic SMS checks, so SMS import was turned off. You can still paste messages or add entries manually.';
    case 'registration_rollback':
      return 'Android could not schedule automatic SMS checks or confirm that SMS import was turned off. Check the import setting before leaving; paste and manual entry still work.';
    case 'unregistration':
      return 'SMS import is off, but Android could not remove its scheduled check. It will skip inbox reads; retry turning it off to remove the schedule.';
  }
}

function reviewUnavailableCopy(reason: string): string {
  switch (reason) {
    case 'unreadable_source':
      return 'This message could not be read safely. Add the payment manually or paste it from Home.';
    case 'missing_original':
    case 'source_changed':
      return 'This message is no longer available to review. Add the payment manually or paste it from Home.';
    case 'key_unavailable':
      return 'The saved import key is unavailable. Restore access, or add the payment manually.';
    case 'not_pending':
      return 'This message is no longer waiting for review. Refresh the list.';
    case 'no_longer_financial':
      return 'This message no longer looks like a transaction. You can still add it manually.';
    default:
      return 'Could not reopen this message. Try again, or add the payment manually.';
  }
}

function catchupFailureCopy(code: AndroidSmsCatchupFailure): string {
  switch (code) {
    case 'permission_denied':
      return 'SMS permission is unavailable. Grant it, then preview again. Manual entry and paste still work.';
    case 'permission_unavailable':
      return 'Android permission state could not be checked. Retry the preview or use paste.';
    case 'invalid_consent':
      return 'Saved SMS consent could not be verified. Check the import setting before trying again.';
    case 'source_unavailable':
      return 'Android could not read the inbox. Retry the preview or add entries manually.';
    case 'invalid_source_page':
      return 'Android returned a message page that could not be verified. No rows from that page were saved; retry or paste.';
    case 'stale_cursor':
      return 'Another import changed the saved position. Refresh this screen, then preview again.';
    case 'storage_unavailable':
      return 'The ledger could not finish this catch-up. Your manual entries remain available; retry later.';
    case 'key_unavailable':
      return 'The saved import key is unavailable. Restore access or add entries manually.';
    case 'duplicate_review_required':
      return 'Catch-up paused because earlier imported messages need review below. Review them, then preview again.';
    case 'invalid_clock':
      return 'The device time could not be verified. Check the date and time, then preview again.';
    case 'time_budget_exceeded':
      return 'Background catch-up ran out of time. A read already in progress may finish; opening the app or a later SMS wake can retry.';
    case 'background_unavailable':
      return 'Android could not schedule automatic SMS checks. Review the import setting and try again; paste still works.';
    default:
      return 'SMS catch-up stopped safely. Retry the preview or use manual entry and paste.';
  }
}

export function SmsImportPanel({
  ledger,
  onReview,
  onPaste,
}: {
  ledger: DataLayer;
  onReview: (selection: AndroidSmsReviewSelection) => void;
  onPaste: () => void;
}) {
  const colors = useTheme();
  const dark = colors.background === Colors.dark.background;
  const version = useLedgerVersion();
  const catchupFailure = useSyncExternalStore(
    subscribeAndroidSmsCatchupFailure,
    getAndroidSmsCatchupFailure,
    () => null,
  );
  const [reader] = useState<SmsReaderModule | null>(() => getSmsReader());
  const [settings, setSettings] = useState<SmsImportSettings | null>(null);
  const [permission, setPermission] = useState<SmsPermissionState | null>(null);
  const [health, setHealth] = useState<SmsImportHealth | null>(null);
  const [captureHealth, setCaptureHealth] = useState<SmsWakeMetadata | null>(null);
  const [rows, setRows] = useState<SmsReviewRow[]>([]);
  const [nextPage, setNextPage] = useState<SmsReviewPage['nextCursor']>();
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<'preview' | 'catchup' | 'disable' | 'review' | 'page' | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failure, setFailure] = useState('');
  const [statusFailure, setStatusFailure] = useState('');
  const visibleFailure = failure || statusFailure;
  const [reviewingReferenceId, setReviewingReferenceId] = useState<string | null>(null);
  const [previewCancelling, setPreviewCancelling] = useState(false);
  const previewController = useRef<AbortController | null>(null);
  const previewPhase = useRef<AndroidSmsPreviewPhase>(null);
  const routeFocused = useRef(false);
  const operation = useRef(createAndroidSmsOperationGeneration());
  const statusGeneration = useRef(0);
  const actionRef = useRef(false);
  const disableRef = useRef(false);

  const refresh = useCallback(async (operationIsCurrent: () => boolean = () => true) => {
    const request = ++statusGeneration.current;
    const current = () => statusGeneration.current === request && operationIsCurrent();
    try {
      const [nextHealth, page] = await Promise.all([
        ledger.getSmsImportHealth(),
        ledger.getSmsReviewPage({ limit: 100 }),
      ]);
      let nextSettings: SmsImportSettings | null = null;
      let nextPermission: SmsPermissionState | null = null;
      let nextCaptureHealth: SmsWakeMetadata | null = null;
      let nativeStatusFailed = false;
      let captureStatusFailed = false;
      if (reader) {
        try {
          [nextSettings, nextPermission] = await Promise.all([
            reader.getImportSettingsAsync(),
            reader.getPermissionsAsync(),
          ]);
        } catch {
          nativeStatusFailed = true;
        }
        try {
          nextCaptureHealth = await reader.getWakeMetadataAsync();
          captureStatusFailed = nextCaptureHealth.captureFailedCount === undefined ||
            nextCaptureHealth.captureUnavailableCount === undefined;
        } catch {
          captureStatusFailed = true;
        }
      }
      if (!current()) return;
      setSettings(nextSettings);
      setPermission(nextPermission);
      setHealth(nextHealth);
      setCaptureHealth(nextCaptureHealth);
      setRows(page.rows);
      setNextPage(page.nextCursor);
      setStatusFailure(nativeStatusFailed
        ? 'Couldn’t check Android consent or permission. Pending reviews are still available; retry status or use paste.'
        : captureStatusFailed ? 'Couldn’t read capture history. Retry status or use paste.' : '');
    } catch {
      if (current()) setStatusFailure('Couldn’t load SMS import status. Try again.');
    } finally {
      if (current()) setLoading(false);
    }
  }, [ledger, reader]);

  useEffect(() => {
    let current = true;
    // Refresh writes component state only after its asynchronous native and ledger reads settle.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh(() => current);
    return () => { current = false; };
  }, [refresh, version, catchupFailure]);

  useEffect(() => () => {
    operation.current.next();
    previewController.current?.abort();
  }, []);

  const beginPreview = useCallback(async () => {
    if (!reader || actionRef.current || disableRef.current) return;
    const operationId = operation.current.next();
    const isCurrent = () => operation.current.isCurrent(operationId);
    actionRef.current = true;
    const controller = new AbortController();
    previewController.current = controller;
    previewPhase.current = 'permission';
    setAction('preview');
    setPreviewCancelling(false);
    setFailure('');
    clearAndroidSmsCatchupFailure();
    setPreview(null);
    try {
      let permissionState = await reader.getPermissionsAsync();
      if (!isCurrent() || controller.signal.aborted || !routeFocused.current || AppState.currentState !== 'active') return;
      if (!hasSmsAccess(permissionState)) {
        permissionState = await reader.requestPermissionsAsync();
        if (!isCurrent() || controller.signal.aborted || !routeFocused.current || AppState.currentState !== 'active') return;
      }
      if (!isCurrent() || !routeFocused.current || AppState.currentState !== 'active') return;
      setPermission(permissionState);
      if (!hasSmsAccess(permissionState)) {
        setFailure('SMS access was not granted. You can still add entries manually or paste a message.');
        return;
      }

      previewPhase.current = 'source';
      const consent = await reader.getImportSettingsAsync();
      if (!isCurrent() || controller.signal.aborted || !routeFocused.current || AppState.currentState !== 'active') return;
      const endDateMs = Date.now();
      const startDateMs = consent.startDateMs ?? Math.max(1, endDateMs - ninetyDaysMs);
      const counted = await previewAndroidSms({
        reader,
        startDateMs,
        endDateMs,
        signal: controller.signal,
      });
      if (!isCurrent() || controller.signal.aborted) return;
      setSettings(consent);
      setPreview({ ...counted, startDateMs, endDateMs });
    } catch (error) {
      if (isCurrent() && !isAbortError(error)) {
        setFailure(error instanceof AndroidSmsCatchupError ? error.message : 'Couldn’t count messages. Your ledger was not changed; try again or use paste.');
      }
    } finally {
      if (previewController.current === controller) {
        previewController.current = null;
        previewPhase.current = null;
      }
      if (isCurrent()) {
        setPreviewCancelling(false);
        actionRef.current = false;
        setAction(null);
      }
    }
  }, [reader]);

  const cancelPreview = useCallback(() => {
    const controller = previewController.current;
    if (controller) {
      setPreviewCancelling(true);
      controller.abort();
      return;
    }
    if (actionRef.current) return;
    setPreview(null);
  }, []);

  const cancelPreviewWhenHidden = useCallback(() => {
    if (shouldAbortAndroidSmsPreviewOnHide(previewPhase.current)) cancelPreview();
  }, [cancelPreview]);

  useFocusEffect(useCallback(() => {
    routeFocused.current = true;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') cancelPreviewWhenHidden();
    });
    return () => {
      routeFocused.current = false;
      subscription.remove();
      // Route blur is explicit navigation; abort the preview even if the Android prompt is pending.
      // This only aborts our continuation, not the OS permission dialog itself.
      cancelPreview();
    };
  }, [cancelPreview, cancelPreviewWhenHidden]));

  const confirmAndCatchup = useCallback(async () => {
    if (!reader || !preview || actionRef.current || disableRef.current) return;
    const operationId = operation.current.next();
    const isCurrent = () => operation.current.isCurrent(operationId);
    actionRef.current = true;
    setAction('catchup');
    setFailure('');
    try {
      const currentSettings = await reader.getImportSettingsAsync();
      if (!isCurrent()) return;
      const currentPermission = await reader.getPermissionsAsync();
      if (!isCurrent()) return;
      if (!hasSmsAccess(currentPermission)) {
        throw new Error('permission_revoked');
      }
      if (!currentSettings.enabled) {
        const initialConsent = {
          enabled: true,
          startDateMs: preview.startDateMs,
          ...(currentSettings.startDateMs === null ? { previewEndDateMs: preview.endDateMs } : {}),
        };
        await setAndroidSmsImportSettings(reader, initialConsent, androidSmsBackgroundScheduler);
        if (!isCurrent()) return;
      } else if (currentSettings.startDateMs !== preview.startDateMs) {
        throw new Error('consent_range_changed');
      }
      if (!isCurrent()) return;
      await refresh(isCurrent);
      if (!isCurrent()) return;
      await runEnabledAndroidSmsCatchup(reader, ledger, preview.startDateMs, preview.endDateMs);
      if (!isCurrent()) return;
      setPreview(null);
      await refresh(isCurrent);
    } catch (error) {
      if (!isCurrent() || isAbortError(error)) return;
      await refresh(isCurrent);
      if (!isCurrent()) return;
      if (error instanceof AndroidSmsCatchupError) setFailure(`${error.message} Retry the preview, or use paste.`);
      else if (error instanceof Error && error.message === 'consent_range_changed') setFailure('SMS consent changed. Preview again before importing.');
      else if (error instanceof Error && error.message === 'permission_revoked') setFailure('SMS permission is no longer available. Import is unchanged; grant permission and preview again.');
      else if (error instanceof AndroidSmsBackgroundUnavailableError) setFailure(backgroundUnavailableCopy(error));
      else setFailure('Couldn’t start the SMS catch-up. Your entries remain available; try again or use paste.');
    } finally {
      if (isCurrent()) {
        actionRef.current = false;
        setAction(null);
      }
    }
  }, [ledger, preview, reader, refresh]);

  const disable = useCallback(async () => {
    if (!reader || disableRef.current) return;
    const operationId = operation.current.next();
    const isCurrent = () => operation.current.isCurrent(operationId);
    disableRef.current = true;
    abortAndroidSmsCatchup();
    previewController.current?.abort();
    setPreview(null);
    setPreviewCancelling(false);
    actionRef.current = true;
    setAction('disable');
    setFailure('');
    try {
      await setAndroidSmsImportSettings(reader, { enabled: false }, androidSmsBackgroundScheduler);
      if (!isCurrent()) return;
      clearAndroidSmsCatchupFailure();
      await refresh(isCurrent);
    } catch (error) {
      if (!isCurrent()) return;
      await refresh(isCurrent);
      if (isCurrent()) setFailure(error instanceof AndroidSmsBackgroundUnavailableError
        ? backgroundUnavailableCopy(error)
        : 'Couldn’t turn off SMS import. It may still be on; retry here.');
    } finally {
      if (isCurrent()) {
        actionRef.current = false;
        disableRef.current = false;
        setAction(null);
      }
    }
  }, [reader, refresh]);

  const openReview = useCallback(async (row: SmsReviewRow) => {
    if (!reader || actionRef.current || disableRef.current) return;
    const operationId = operation.current.next();
    const isCurrent = () => operation.current.isCurrent(operationId);
    actionRef.current = true;
    setAction('review');
    setFailure('');
    setReviewingReferenceId(row.referenceId);
    try {
      const result = await ledger.prepareSmsReview(row.referenceId, createAndroidSmsOriginalReader(reader));
      if (!isCurrent()) return;
      if (result.kind === 'ready') {
        onReview({
          referenceId: result.referenceId,
          platformId: result.platformId,
          receivedAt: result.receivedAt,
          expectedPreparation: result,
        });
      } else {
        setFailure(reviewUnavailableCopy(result.reason));
        await refresh(isCurrent);
      }
    } catch {
      if (isCurrent()) setFailure('Could not reopen this message. Try again, or add the payment manually.');
    } finally {
      if (isCurrent()) {
        actionRef.current = false;
        setAction(null);
        setReviewingReferenceId(null);
      }
    }
  }, [ledger, onReview, reader, refresh]);

  const loadMore = useCallback(async () => {
    if (!nextPage || actionRef.current || disableRef.current) return;
    const operationId = operation.current.next();
    const isCurrent = () => operation.current.isCurrent(operationId);
    actionRef.current = true;
    setAction('page');
    try {
      const page = await ledger.getSmsReviewPage({ limit: 100, after: nextPage });
      if (!isCurrent()) return;
      setRows((existing) => [...existing, ...page.rows]);
      setNextPage(page.nextCursor);
    } catch {
      if (isCurrent()) setFailure('Couldn’t load more reviews. Try again.');
    } finally {
      if (isCurrent()) {
        actionRef.current = false;
        setAction(null);
      }
    }
  }, [ledger, nextPage]);

  const panel = [styles.panel, {
    backgroundColor: colors.backgroundElement,
    borderColor: colors.border,
    ...(dark ? {} : { boxShadow: Shadow.card }),
  }];
  const active = settings?.enabled === true;
  const visibleCatchupFailure = catchupFailure ?? captureHealth?.currentFailureCode ?? null;
  const failedCaptureCount = captureHealth?.captureFailedCount;
  const unavailableCaptureCount = captureHealth?.captureUnavailableCount;

  return (
    <View style={styles.section}>
      <View style={styles.heading}>
        <ThemedText style={Type.sectionTitle}>SMS import</ThemedText>
        <ThemedText style={[Type.note, { color: colors.textSecondary }]}>Android only · local to this device</ThemedText>
      </View>
      <View style={panel}>
        <ThemedText style={[Type.body, { color: colors.textSecondary }]}>
          Original message text is read temporarily and never saved. Your first preview covers the last 90 days of inbox history. Permission alone does not turn import on. Manual entry and paste always work.
        </ThemedText>
        <ThemedText style={[Type.note, { color: colors.textSecondary }]}>
          Experimental: only verified message formats save automatically. Other bank, card and UPI alerts need your review. Missing alerts and background delays can leave totals incomplete.
        </ThemedText>
        {reader ? <>
          <View style={[styles.statusLine, { borderTopColor: colors.rule }]}>
            <ThemedText style={Type.rowTitle}>{loading ? 'Checking status…' : settings === null ? 'Import status unavailable' : active ? 'Import is on' : 'Import is off'}</ThemedText>
            <ThemedText style={[Type.note, { color: colors.textSecondary }]}>
              {permission === null ? 'Permission state unavailable' : hasSmsAccess(permission) ? 'SMS permission granted' : 'SMS permission not granted'}
            </ThemedText>
          </View>
          {health ? <ThemedText style={[Type.note, { color: colors.textSecondary }]}>
            {health.lastSuccessfulCatchupAt === null
              ? 'No successful catch-up yet'
              : `Last catch-up ${indiaDate(new Date(health.lastSuccessfulCatchupAt))}`} · {health.pendingReviewCount} to review
          </ThemedText> : null}
          {health && health.nonPostedReviewCount > 0 ? <ThemedText style={[Type.note, { color: colors.textSecondary }]}>
            {health.nonPostedReviewCount} failed payment {health.nonPostedReviewCount === 1 ? 'alert' : 'alerts'} in review
          </ThemedText> : null}
          {failedCaptureCount !== undefined && unavailableCaptureCount !== undefined &&
            (failedCaptureCount > 0 || unavailableCaptureCount > 0) ? <ThemedText style={[Type.note, { color: colors.textSecondary }]}>
              Recorded checks: {failedCaptureCount} failed · {unavailableCaptureCount} unavailable
            </ThemedText> : null}
          {preview ? <View style={[styles.preview, { backgroundColor: colors.background, borderColor: colors.rule }]}>
            <ThemedText style={Type.rowTitle}>{preview.count} {preview.count === 1 ? 'message' : 'messages'} found</ThemedText>
            <ThemedText style={[Type.note, { color: colors.textSecondary }]}>
              History: {indiaDate(new Date(preview.startDateMs))} – {indiaDate(new Date(preview.endDateMs))}. This count includes previously checked messages. Existing entries and corrections are preserved. The preview changed no ledger data; import begins only after you confirm below.
            </ThemedText>
          </View> : null}
          {visibleFailure ? <ThemedText accessibilityRole="alert" style={[Type.note, { color: colors.text }]}>{visibleFailure}</ThemedText> : null}
          {visibleCatchupFailure ? <ThemedText accessibilityRole="alert" style={[Type.note, { color: colors.text }]}>{catchupFailureCopy(visibleCatchupFailure)}</ThemedText> : null}
          {active ? <View style={styles.actions}>
            {preview ? <LedgerButton label={action === 'catchup' ? 'Importing…' : 'Confirm and catch up'} primary disabled={action !== null || loading} onPress={() => void confirmAndCatchup()} /> : null}
            <LedgerButton label={action === 'preview' ? 'Counting…' : 'Preview messages'} disabled={action !== null || loading || !settings} onPress={() => void beginPreview()} />
            {action === 'preview' || (preview !== null && action === null) ? <LedgerButton label={previewCancelling ? 'Canceling preview…' : 'Cancel preview'} disabled={previewCancelling} onPress={cancelPreview} /> : null}
            <LedgerButton label={action === 'disable' ? 'Turning off…' : 'Turn off SMS import'} disabled={action === 'disable'} onPress={() => void disable()} />
          </View> : <View style={styles.actions}>
            {preview ? <LedgerButton label={action === 'catchup' ? 'Starting…' : 'Turn on and import'} primary disabled={action !== null || loading} onPress={() => void confirmAndCatchup()} /> : null}
            <LedgerButton label={action === 'preview' ? 'Counting…' : 'Preview messages'} primary={!preview} disabled={action !== null || loading || !settings} onPress={() => void beginPreview()} />
            {action === 'preview' || (preview !== null && action === null) ? <LedgerButton label={previewCancelling ? 'Canceling preview…' : 'Cancel preview'} disabled={previewCancelling} onPress={cancelPreview} /> : null}
            {action === 'catchup' ? <LedgerButton label="Cancel import" onPress={() => void disable()} /> : null}
          </View>}
          {active ? <ThemedText style={[Type.note, { color: colors.textMuted }]}>
            Android controls background timing; checks may take 15 minutes or longer. Opening the app also catches up. Turning import off stops future checks.
          </ThemedText> : null}
          {!settings || !health || statusFailure ? <LedgerButton label={loading ? 'Loading status…' : 'Retry status'} disabled={loading || action !== null} onPress={() => { setLoading(true); void refresh(); }} /> : null}
        </> : <>
          <ThemedText style={[Type.note, { color: colors.textSecondary }]}>
            SMS import is unavailable in this app build. You can still add entries or paste a bank message from Home.
          </ThemedText>
          {visibleFailure ? <ThemedText accessibilityRole="alert" style={[Type.note, { color: colors.text }]}>{visibleFailure}</ThemedText> : null}
        </>}
        <LedgerButton label="Paste a bank message" onPress={onPaste} />
      </View>

      <View style={panel}>
        <View style={styles.reviewHeading}>
          <ThemedText style={Type.rowTitle}>Needs review</ThemedText>
          {health ? <ThemedText style={[Type.amountSmall, { color: colors.textSecondary }]}>{health.pendingReviewCount}</ThemedText> : null}
        </View>
        {loading && rows.length === 0 ? <ActivityIndicator accessibilityLabel="Loading SMS reviews" color={colors.textSecondary} /> : null}
        {!loading && rows.length === 0 ? <ThemedText style={[Type.note, { color: colors.textSecondary }]}>No messages waiting for review.</ThemedText> : null}
        {rows.map((row) => (
          <Pressable
            key={row.referenceId}
            accessibilityRole="button"
            accessibilityLabel={`Review message received ${indiaDate(new Date(row.receivedAt))}`}
            accessibilityState={{ disabled: action !== null }}
            disabled={action !== null || !reader}
            onPress={() => void openReview(row)}
            style={({ pressed }) => [styles.reviewRow, { borderTopColor: colors.rule, opacity: action !== null ? 0.55 : pressed ? 0.72 : 1 }]}
          >
            <View style={styles.rowCopy}>
              <ThemedText style={Type.body}>{indiaDate(new Date(row.receivedAt))}</ThemedText>
              <ThemedText style={[Type.note, { color: colors.textSecondary }]}>{row.reason?.replaceAll('_', ' ') ?? 'Transaction details need review'}</ThemedText>
            </View>
            {reviewingReferenceId === row.referenceId ? <ActivityIndicator accessibilityLabel="Opening review" color={colors.textSecondary} /> : null}
          </Pressable>
        ))}
        {nextPage ? <LedgerButton label={action === 'page' ? 'Loading…' : 'Load more'} disabled={action !== null} onPress={() => void loadMore()} /> : null}
        {!reader && rows.length > 0 ? <ThemedText style={[Type.note, { color: colors.textSecondary }]}>
          To reopen these messages, use a supported Android build. If a message is unavailable, add it manually or paste it from Home.
        </ThemedText> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: Spacing.three },
  heading: { gap: Spacing.one },
  panel: { padding: Spacing.three, gap: Spacing.three, borderWidth: Stroke.ink, borderRadius: Radius.card },
  statusLine: { paddingTop: Spacing.three, borderTopWidth: Stroke.hairline, gap: Spacing.one },
  preview: { padding: Spacing.three, gap: Spacing.one, borderWidth: Stroke.hairline, borderRadius: Radius.control },
  actions: { gap: Spacing.two },
  reviewHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  reviewRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two, paddingTop: Spacing.two, borderTopWidth: StyleSheet.hairlineWidth },
  rowCopy: { flex: 1, gap: Spacing.one },
});
