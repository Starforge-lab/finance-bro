import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Animated, { SlideInDown, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { Icon, type IconName } from './icon';
import { ThemedText } from './themed-text';
import { Fonts, Motion, Radius, Spacing, Type } from '@/constants/theme';
import { getLedger } from '@/db';
import { useTheme } from '@/hooks/use-theme';
import { indiaDate, money } from '@/utils/display';
import { monthPickerRows, type MonthPickerRow } from '@/utils/month-picker';
import { shiftMonth } from '@/utils/month-pace';
import { ease, fadeIn } from '@/utils/motion';


export function LedgerButton({ label, onPress, disabled = false, primary = false, selected, expanded, icon, iconOnly = false }: {
  label: string; onPress: () => void; disabled?: boolean; primary?: boolean; selected?: boolean; expanded?: boolean;
  icon?: IconName; iconOnly?: boolean;
}) {
  const colors = useTheme();
  const reduceMotion = useReducedMotion();
  const ink = primary ? colors.onAccent : selected ? colors.background : colors.text;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, ...(selected !== undefined && { selected }), ...(expanded !== undefined && { expanded }) }}
    aria-pressed={selected} aria-expanded={expanded} disabled={disabled}
    onPress={onPress} style={({ pressed }) => [styles.button, iconOnly && styles.iconButton, {
      borderColor: colors.border, backgroundColor: primary ? colors.accent : selected ? colors.fill : colors.backgroundElement,
      opacity: disabled ? 0.5 : pressed && reduceMotion ? 0.72 : 1, transform: [{ scale: pressed && !disabled && !reduceMotion ? 0.96 : 1 }],
    }]}>
    {icon ? <Icon name={icon} size={20} color={ink} /> : null}
    {iconOnly ? null : <ThemedText style={[Type.body, { fontFamily: Fonts.sansSemiBold, color: ink }]}>{label}</ThemedText>}
  </Pressable>;
}

/** Two or three choices with an ink thumb that slides between them. */
export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: readonly { value: T; label: string; icon?: IconName }[]; value: T; onChange: (value: T) => void; label: string;
}) {
  const colors = useTheme();
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const segment = width ? (width - 8) / options.length : 0;
  const x = useSharedValue(index * segment);
  useEffect(() => {
    if (reduceMotion) return;
    x.value = withTiming(index * segment, { duration: Motion.standard, easing: ease });
  }, [index, segment, reduceMotion, x]);
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return <View accessibilityRole="radiogroup" accessibilityLabel={label}
    onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
    style={[styles.segment, { borderColor: colors.border, backgroundColor: colors.backgroundElement }]}>
    {segment ? reduceMotion
      ? <Animated.View key={value} entering={fadeIn()} style={[styles.thumb, { width: segment, left: 2 + index * segment, backgroundColor: colors.fill }]} />
      : <Animated.View style={[styles.thumb, { width: segment, backgroundColor: colors.fill }, thumb]} />
      : null}
    {options.map((option) => {
      const on = option.value === value;
      const ink = on ? colors.background : colors.text;
      return <Pressable key={option.value} accessibilityRole="radio" accessibilityState={{ checked: on }} aria-checked={on}
        onPress={() => {
          if (on) return;
          void Haptics.selectionAsync().catch(() => {});
          onChange(option.value);
        }} style={styles.segmentItem}>
        {option.icon ? <Icon name={option.icon} size={18} color={ink} /> : null}
        <ThemedText style={[Type.rowTitle, { color: ink }]} numberOfLines={1}>{option.label}</ThemedText>
      </Pressable>;
    })}
  </View>;
}

function monthName(month: string, withYear: boolean) {
  return new Intl.DateTimeFormat('en-IN', { month: 'long', ...(withYear && { year: 'numeric' }), timeZone: 'UTC' })
    .format(new Date(`${month}-01T00:00:00Z`));
}

/**
 * The month as a control. `title` is the screen heading itself; `pill` sits beside a heading.
 * Opens a sheet listing the months that hold entries, newest first, with what each spent.
 */
export function MonthPicker({ month, onChange, variant = 'pill' }: {
  month: string; onChange: (month: string) => void; variant?: 'title' | 'pill';
}) {
  const colors = useTheme();
  const reduceMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [months, setMonths] = useState<MonthPickerRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const current = indiaDate().slice(0, 7);
  const monthRows = monthPickerRows(months ?? [], current, month);
  const showYear = month.slice(0, 4) !== current.slice(0, 4);
  const label = monthName(month, showYear);

  const show = useCallback(() => {
    setOpen(true); setFailed(false);
    getLedger().then((ledger) => ledger.listEntryMonths()).then(setMonths).catch(() => setFailed(true));
  }, []);

  const trigger = variant === 'title'
    ? <Pressable accessibilityRole="button" accessibilityLabel={`${label}. Choose month`} onPress={show}
      style={({ pressed }) => [styles.titleTrigger, { opacity: pressed ? 0.6 : 1 }]}>
      <ThemedText style={Type.screenTitle} numberOfLines={1}><MonthLabel month={month} withYear={showYear} /></ThemedText>
      <Icon name="expand" size={26} color={colors.text} />
    </Pressable>
    : <Pressable accessibilityRole="button" accessibilityLabel={`${label}. Choose month`} onPress={show}
      style={({ pressed }) => [styles.button, styles.monthPill, { backgroundColor: colors.backgroundElement, borderColor: colors.border, opacity: pressed && reduceMotion ? 0.72 : 1, transform: [{ scale: pressed && !reduceMotion ? 0.96 : 1 }] }]}>
      <ThemedText style={{ ...Type.body, fontFamily: Fonts.sansHeavy }}><MonthLabel month={month} withYear={showYear} /></ThemedText>
      <Icon name="expand" size={18} color={colors.text} />
    </Pressable>;

  return <>
    {trigger}
    <Modal visible={open} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={() => setOpen(false)}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close month list" style={[styles.backdrop, { backgroundColor: colors.scrim }]} onPress={() => setOpen(false)} />
      <Animated.View entering={reduceMotion ? fadeIn() : SlideInDown.duration(Motion.standard).easing(ease)}
        style={[styles.sheet, { backgroundColor: colors.background, borderColor: colors.border, paddingBottom: insets.bottom + 16 }]}>
        <View style={[styles.grabber, { backgroundColor: colors.textMuted }]} />
        <View style={styles.sheetHeader}>
          <MonthStepButton label="Previous month" icon="back" disabled={month === '0001-01'} onPress={() => onChange(shiftMonth(month, -1))} />
          <View style={styles.sheetHeading}>
            <ThemedText style={Type.sectionTitle} accessibilityRole="header">Choose month</ThemedText>
            <ThemedText style={[Type.label, { color: colors.textSecondary }]}><MonthLabel month={month} withYear color={colors.textSecondary} /></ThemedText>
          </View>
          <MonthStepButton label="Next month" icon="next" disabled={month === '9999-12'} onPress={() => onChange(shiftMonth(month, 1))} />
        </View>
        {failed ? <ThemedText style={[Type.note, styles.sheetError, { color: colors.over }]} accessibilityRole="alert">Couldn’t load months. Close and try again.</ThemedText> : null}
        <ScrollView style={styles.sheetList} contentContainerStyle={styles.sheetContent}>
          {monthRows.map((row, index) => {
            const selected = row.month === month;
            return <Animated.View key={row.month} entering={fadeIn(Math.min(index, 8) * 30)}>
              <Pressable accessibilityRole="button" accessibilityState={{ selected }}
                accessibilityLabel={`${monthName(row.month, true)}, ${money(row.expensePaise)} spent, ${row.entryCount} ${row.entryCount === 1 ? 'entry' : 'entries'}${row.month === current ? ', this month' : ''}`}
                onPress={() => { setOpen(false); if (!selected) onChange(row.month); }}
                style={({ pressed }) => [styles.monthRow, { backgroundColor: selected ? colors.fill : pressed ? colors.backgroundSelected : 'transparent' }]}>
                <View style={styles.monthWords}>
                  <ThemedText style={[Type.rowTitle, { color: selected ? colors.background : colors.text }]}><MonthLabel month={row.month} withYear={row.month.slice(0, 4) !== current.slice(0, 4)} color={selected ? colors.background : colors.text} /></ThemedText>
                  <ThemedText style={[Type.label, { color: selected ? colors.background : colors.textSecondary }]}>
                    {row.month === current ? 'This month · ' : ''}<Text style={{ fontFamily: Fonts.monoBold }}>{row.entryCount}</Text> {row.entryCount === 1 ? 'entry' : 'entries'}
                  </ThemedText>
                </View>
                <ThemedText style={[Type.amountSmall, { color: selected ? colors.background : colors.text }]}>{money(row.expensePaise)}</ThemedText>
                {selected ? <Icon name="check" size={20} color={colors.background} /> : <View style={styles.checkSpace} />}
              </Pressable>
            </Animated.View>;
          })}
        </ScrollView>
      </Animated.View>
    </Modal>
  </>;
}

function MonthLabel({ month, withYear, color }: { month: string; withYear: boolean; color?: string }) {
  const label = monthName(month, withYear);
  const year = withYear ? label.match(/\d+/)?.[0] ?? '' : '';
  const index = year ? label.lastIndexOf(year) : -1;
  return index < 0 ? label : <>{label.slice(0, index)}<Text style={{ fontFamily: Fonts.monoBold, ...(color ? { color } : {}) }}>{year}</Text>{label.slice(index + year.length)}</>;
}
function MonthStepButton({ label, icon, disabled, onPress }: {
  label: string; icon: IconName; disabled: boolean; onPress: () => void;
}) {
  const colors = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} aria-label={label}
    disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.monthStepButton, { borderColor: colors.border, backgroundColor: colors.backgroundElement, opacity: disabled ? 0.5 : pressed ? 0.72 : 1 }]}>
    <Icon name={icon} size={20} color={colors.text} />
  </Pressable>;
}

const styles = StyleSheet.create({
  button: { minHeight: 44, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, flexDirection: 'row', gap: 8,
    borderWidth: 2, borderRadius: Radius.pill, justifyContent: 'center', alignItems: 'center' },
  iconButton: { width: 44, paddingHorizontal: 0 },
  monthPill: { gap: 6 },
  titleTrigger: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, alignSelf: 'flex-start' },
  segment: { flexDirection: 'row', borderWidth: 2, borderRadius: Radius.pill, padding: 2, minHeight: 44 },
  thumb: { position: 'absolute', top: 2, bottom: 2, left: 2, borderRadius: Radius.pill },
  segmentItem: { flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, minHeight: 40 },
  backdrop: StyleSheet.absoluteFill,
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '75%', borderTopLeftRadius: Radius.hero, borderTopRightRadius: Radius.hero, borderWidth: 2, borderBottomWidth: 0, paddingTop: 10 },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, opacity: 0.5 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: Spacing.gutter, paddingTop: 14, paddingBottom: 8 },
  sheetHeading: { flex: 1, alignItems: 'center', gap: 2 },
  sheetError: { paddingHorizontal: Spacing.gutter, paddingBottom: 8 },
  monthStepButton: { width: 48, height: 48, borderWidth: 2, borderRadius: Radius.control, alignItems: 'center', justifyContent: 'center' },
  sheetList: { flexGrow: 0 },
  sheetContent: { paddingHorizontal: 12, gap: 2 },
  monthRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingHorizontal: 12, borderRadius: Radius.control },
  monthWords: { flex: 1, gap: 2 },
  checkSpace: { width: 20 },
});
