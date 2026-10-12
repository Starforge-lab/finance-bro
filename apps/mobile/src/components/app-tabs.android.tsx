import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { Tabs } from 'expo-router';
import type { BottomTabBarProps, BottomTabNavigationOptions } from 'expo-router/tabs';
import { useEffect, useRef } from 'react';
import { Easing, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { Fonts, Motion } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const tabs = [
  { name: 'index', title: 'Home', icon: 'home' },
  { name: 'budgets', title: 'Budgets', icon: 'account_balance_wallet' },
  { name: 'insights', title: 'Insights', icon: 'insights' },
  { name: 'settings', title: 'Settings', icon: 'settings' },
] as const;

const PAD = 5;
const HEIGHT = 64;
/** Settles fast without overshoot, like a segmented-control thumb. */
const pillSpring = { damping: 26, stiffness: 320, mass: 0.9 };

/** Pages shift 30px toward the side they come from; the outgoing page is gone by the halfway point. */
const shift: Pick<BottomTabNavigationOptions, 'sceneStyleInterpolator' | 'transitionSpec'> = {
  transitionSpec: { animation: 'timing', config: { duration: 220, easing: Easing.bezier(...Motion.ease) } },
  sceneStyleInterpolator: ({ current }) => ({
    sceneStyle: {
      opacity: current.progress.interpolate({ inputRange: [-1, -0.5, 0, 0.5, 1], outputRange: [0, 0, 1, 0, 0] }),
      transform: [{ translateX: current.progress.interpolate({ inputRange: [-1, 0, 1], outputRange: [-30, 0, 30] }) }],
    },
  }),
};

/** The Android material bar cannot float; keep the reference capsule with Router's standard tabs. */
export default function AppTabs() {
  const reduceMotion = useReducedMotion();
  // All four tabs are built at launch and stay attached, so a switch only moves finished pages.
  return <Tabs detachInactiveScreens={false} tabBar={(props) => <CapsuleBar {...props} />} screenOptions={{
    headerShown: false, lazy: false, freezeOnBlur: false,
    ...(reduceMotion ? { animation: 'none' as const } : shift),
  }}>
    {tabs.map((tab) => <Tabs.Screen key={tab.name} name={tab.name} options={{ title: tab.title }} />)}
  </Tabs>;
}

function CapsuleBar({ state, emitter, navigateToTab, insets }: BottomTabBarProps) {
  const colors = useTheme();
  const reduceMotion = useReducedMotion();
  const { width } = useWindowDimensions();
  const capsuleWidth = Math.min(520, width - 32);
  const slot = (capsuleWidth - PAD * 2 - 2) / state.routes.length;
  const x = useSharedValue(state.index * slot);
  const laidOut = useRef(slot);

  useEffect(() => {
    const target = state.index * slot;
    // A width change (rotation) repositions without animating.
    x.set(reduceMotion || laidOut.current !== slot ? target : withSpring(target, pillSpring));
    laidOut.current = slot;
  }, [state.index, slot, reduceMotion, x]);

  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));
  const current = state.routes[state.index];
  // Hide during Home's entry and paste forms.
  if (current.name === 'index' && (current.params as { _entryOpen?: string } | undefined)?._entryOpen === '1') return null;

  return <View role="tablist" style={[styles.capsule, {
    width: capsuleWidth, bottom: insets.bottom + 24, borderColor: colors.tabBarBorder, backgroundColor: colors.backgroundElement,
  }]}>
    <Animated.View pointerEvents="none" style={[styles.pill, { width: slot, backgroundColor: colors.tabSelected }, pill]} />
    {state.routes.map((route, index) => {
      const tab = tabs.find((item) => item.name === route.name);
      const selected = index === state.index;
      const onPress = () => {
        const event = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
        if (!selected && !event.defaultPrevented) {
          void Haptics.selectionAsync().catch(() => {});
          navigateToTab(route.key);
        }
      };
      return <TabButton key={route.key} label={tab?.title ?? route.name} icon={tab?.icon ?? 'circle'} selected={selected}
        color={selected ? colors.text : colors.tabText} onPress={onPress}
        onLongPress={() => emitter.emit({ type: 'tabLongPress', target: route.key })} reduceMotion={reduceMotion} />;
    })}
  </View>;
}

function TabButton({ label, icon, selected, color, onPress, onLongPress, reduceMotion }: {
  label: string; icon: string; selected: boolean; color: string; onPress: () => void; onLongPress: () => void; reduceMotion: boolean;
}) {
  const scale = useSharedValue(1);
  const press = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  const to = (value: number) => { if (!reduceMotion) scale.set(withTiming(value, { duration: 120 })); };
  return <Pressable role="tab" aria-selected={selected} accessibilityLabel={label} style={styles.tab}
    onPress={onPress} onLongPress={onLongPress} onPressIn={() => to(0.92)} onPressOut={() => to(1)}>
    <Animated.View style={[styles.tabInner, press]}>
      <SymbolView name={{ ios: 'circle', android: icon, web: icon } as never} size={22} tintColor={color}
        accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <Text numberOfLines={1} style={[styles.label, { color, fontFamily: selected ? Fonts.sansHeavy : Fonts.sansSemiBold }]}>{label}</Text>
    </Animated.View>
  </Pressable>;
}

const styles = StyleSheet.create({
  capsule: { position: 'absolute', alignSelf: 'center', height: HEIGHT, padding: PAD, flexDirection: 'row', borderRadius: 999, borderWidth: 1 },
  pill: { position: 'absolute', top: PAD, bottom: PAD, left: PAD, borderRadius: 999 },
  tab: { flex: 1, borderRadius: 999 },
  tabInner: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 },
  label: { fontSize: 11, lineHeight: 14 },
});
