import { useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Radius, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { toggleCategoryFilter } from '@/utils/category-filter';
import { flexibleSpendSummary, type CategoryBar, type MonthPace } from '@/utils/month-pace';
import { money } from '@/utils/display';


const HEIGHT = 132;
const TOP = 14;
const BOTTOM = 4;

/** Rounds a rupee ceiling up to a readable step (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10ⁿ) without leaving the line squashed. */
function niceCeiling(paise: number): number {
  const rupees = Math.max(100, paise / 100);
  const step = 10 ** Math.floor(Math.log10(rupees));
  const nice = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * step).find((value) => value >= rupees)!;
  return nice * 100;
}

function shortRupees(paise: number): string {
  const rupees = paise / 100;
  return rupees >= 1000 ? `₹${Number((rupees / 1000).toFixed(1))}k` : `₹${Math.round(rupees)}`;
}

function linePath(values: number[], x: (day: number) => number, y: (paise: number) => number): string {
  return values.map((value, index) => `${index ? 'L' : 'M'}${x(index + 1).toFixed(1)},${y(value).toFixed(1)}`).join('');
}

/**
 * This month's running spend against last month's, plus the biggest categories
 * against their budgets. Touch and drag the line (or use the screen reader's
 * adjust gesture) to read any day.
 */
export function MonthPaceChart({ pace, bars, monthName, previousName, hasFixed, selectedCategoryId, onSelectCategory }: {
  pace: MonthPace; bars: CategoryBar[]; monthName: string; previousName: string; hasFixed: boolean;
  selectedCategoryId: string | null | undefined; onSelectCategory: (categoryId: string | null | undefined) => void;
}) {
  const colors = useTheme();
  const [width, setWidth] = useState(0);
  const [day, setDay] = useState<number | null>(null);
  const top = niceCeiling(Math.max(1, ...pace.current, ...pace.previous));
  const x = (d: number) => ((d - 1) / Math.max(1, pace.days - 1)) * (width - 8) + 4;
  const y = (paise: number) => TOP + (1 - Math.max(0, paise) / top) * (HEIGHT - TOP - BOTTOM);
  const lastDay = pace.elapsed;
  const pick = (locationX: number) => {
    if (!lastDay || !width) return;
    setDay(Math.min(lastDay, Math.max(1, Math.round(((locationX - 4) / (width - 8)) * (pace.days - 1)) + 1)));
  };

  const summary = flexibleSpendSummary({
    currentPaise: pace.flexiblePaise, previousPaise: pace.previousFlexiblePaise, hasFixed, previousName,
    day: Math.min(lastDay, pace.previous.length),
  });
  const readout = day === null ? summary : (() => {
    const total = pace.current[day - 1] ?? 0;
    const thatDay = total - (day > 1 ? pace.current[day - 2] ?? 0 : 0);
    const before = pace.previous[Math.min(day, pace.previous.length) - 1];
    return `Day ${day}: ${money(thatDay)} spent, ${money(total)} so far${before === undefined ? '' : ` (${previousName}: ${money(before)})`}.`;
  })();
  const pacePosition = lastDay / pace.days;

  return <View style={styles.wrap}>
    <ThemedText accessibilityLiveRegion="polite" style={[Type.note, styles.readout]}>{readout}</ThemedText>
    <View
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      accessible accessibilityRole="adjustable"
      accessibilityLabel={`${monthName} running spending compared with ${previousName}`}
      accessibilityValue={{ text: readout }}
      accessibilityHint="Swipe up or down to step through days."
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => {
        if (!lastDay) return;
        const from = day ?? lastDay;
        setDay(Math.min(lastDay, Math.max(1, from + (event.nativeEvent.actionName === 'increment' ? 1 : -1))));
      }}
      onStartShouldSetResponder={() => lastDay > 0}
      onMoveShouldSetResponder={() => lastDay > 0}
      onResponderTerminationRequest={() => true}
      onResponderGrant={(event) => pick(event.nativeEvent.locationX)}
      onResponderMove={(event) => pick(event.nativeEvent.locationX)}
      onResponderRelease={() => setDay(null)}
      onResponderTerminate={() => setDay(null)}
      style={{ height: HEIGHT }}
    >
      {width ? <Svg width={width} height={HEIGHT}>
        <Line x1={0} x2={width} y1={y(top)} y2={y(top)} stroke={colors.rule} strokeWidth={1} />
        <Line x1={0} x2={width} y1={y(top / 2)} y2={y(top / 2)} stroke={colors.rule} strokeWidth={1} />
        <Line x1={0} x2={width} y1={y(0)} y2={y(0)} stroke={colors.textMuted} strokeWidth={1} />
        <SvgText x={2} y={y(top) - 4} fill={colors.textSecondary} fontSize={10} fontFamily={Fonts.mono}>{shortRupees(top)}</SvgText>
        <SvgText x={2} y={y(top / 2) - 4} fill={colors.textSecondary} fontSize={10} fontFamily={Fonts.mono}>{shortRupees(top / 2)}</SvgText>
        {pace.previous.length ? <Path d={linePath(pace.previous, x, y)} fill="none" stroke={colors.textSecondary} strokeWidth={1.5} strokeDasharray="4 4" strokeLinejoin="round" /> : null}
        {pace.current.length ? <Path d={linePath(pace.current, x, y)} fill="none" stroke={colors.text} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" /> : null}
        {pace.fixedStep ? <SvgText x={Math.min(x(pace.fixedStep.day) + 6, width - 96)} y={y(pace.current[pace.fixedStep.day - 1] ?? 0) + 14}
          fill={colors.textSecondary} fontSize={10} fontFamily={Fonts.sansSemiBold}>{`${pace.fixedStep.label} · fixed`}</SvgText> : null}
        {lastDay ? <Circle cx={x(lastDay)} cy={y(pace.current[lastDay - 1] ?? 0)} r={4.5} fill={colors.text} stroke={colors.backgroundElement} strokeWidth={2} /> : null}
        {day !== null ? <>
          <Line x1={x(day)} x2={x(day)} y1={TOP} y2={y(0)} stroke={colors.text} strokeWidth={1} opacity={0.4} />
          <Circle cx={x(day)} cy={y(pace.current[day - 1] ?? 0)} r={5} fill={colors.accent} stroke={colors.text} strokeWidth={2} />
        </> : null}
      </Svg> : null}
    </View>
    <View style={styles.axis}>
      <ThemedText style={[Type.label, { color: colors.textMuted }]}>1</ThemedText>
      <View style={styles.legend}>
        <Svg width={18} height={6}><Line x1={1} x2={17} y1={3} y2={3} stroke={colors.text} strokeWidth={2.5} strokeLinecap="round" /></Svg>
        <ThemedText style={[Type.label, { color: colors.textSecondary }]}>{monthName}</ThemedText>
        <Svg width={18} height={6} style={styles.key}><Line x1={1} x2={17} y1={3} y2={3} stroke={colors.textSecondary} strokeWidth={1.5} strokeDasharray="4 4" /></Svg>
        <ThemedText style={[Type.label, { color: colors.textSecondary }]}>{previousName}</ThemedText>
      </View>
      <ThemedText style={[Type.label, { color: colors.textMuted }]}>{pace.days}</ThemedText>
    </View>

    <View style={styles.bars}>
      {bars.map((bar) => {
        const selectable = bar.key !== '__other';
        const selected = selectable && selectedCategoryId === bar.categoryId;
        const amount = bar.budgetPaise === null ? money(bar.spentPaise) + ' · no budget' : money(bar.spentPaise) + ' of ' + money(bar.budgetPaise);
        const accessibilityLabel = bar.label + (bar.fixed ? ', fixed cost' : '') + ', ' + amount + (bar.over ? ', over budget' : '');
        const contents = <>
          <View style={styles.barHead}>
            <ThemedText style={[Type.rowTitle, styles.barLabel]} numberOfLines={1}>{bar.label}</ThemedText>
            {bar.fixed ? <ThemedText style={[Type.label, { color: colors.textSecondary }]}>Fixed</ThemedText> : null}
            <ThemedText style={[Type.amountSmall, { color: bar.over ? colors.over : colors.text }]} numberOfLines={1}>{amount}</ThemedText>
          </View>
          <View style={[styles.track, { backgroundColor: colors.track }]}>
            <View style={[styles.fill, { width: String(bar.fill * 100) + '%', backgroundColor: bar.over ? colors.over : bar.budgetPaise === null ? colors.textMuted : colors.fill }]} />
            {bar.budgetPaise !== null && !bar.fixed && lastDay < pace.days ? <View style={[styles.pace, { left: String(pacePosition * 100) + '%', backgroundColor: colors.accent }]} /> : null}
          </View>
        </>;
        return selectable
          ? <Pressable key={bar.key} onPress={() => onSelectCategory(toggleCategoryFilter(selectedCategoryId, bar.categoryId))}
            accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={accessibilityLabel}
            accessibilityHint="Shows only these entries below."
            style={({ pressed }) => [styles.bar, { borderColor: selected ? colors.fill : 'transparent', opacity: pressed ? 0.7 : 1 }]}>
            {contents}
          </Pressable>
          : <View key={bar.key} accessible accessibilityRole="text" accessibilityLabel={accessibilityLabel}
            style={[styles.bar, { borderColor: 'transparent' }]}>
            {contents}
          </View>;
      })}
    </View>
    {bars.some((bar) => bar.budgetPaise !== null && !bar.fixed) && lastDay < pace.days
      ? <ThemedText style={[Type.note, { color: colors.textSecondary }]}>Yellow tick: where a budget would be if spent evenly through the month.</ThemedText> : null}
  </View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  readout: { minHeight: 38 },
  axis: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: -4 },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  key: { marginLeft: 8 },
  bars: { gap: 4, marginTop: 6 },
  bar: { gap: 8, paddingVertical: 8, paddingHorizontal: 8, marginHorizontal: -8, borderWidth: 2, borderRadius: Radius.control },
  barHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  barLabel: { flex: 1, minWidth: 0 },
  track: { height: 10, borderRadius: Radius.bar, overflow: 'visible' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: Radius.bar },
  pace: { position: 'absolute', top: -4, bottom: -4, width: 3, marginLeft: -1.5, borderRadius: 2 },
});
