import { useEffect, type ReactNode } from 'react';
import { View, type DimensionValue, type ViewProps } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * A section waiting for its first data on a cold start, shaped like the content it becomes.
 * Flat paper-toned shapes breathe slowly (static under reduced motion). Screen readers hear one label.
 */
export function SkeletonGroup({ label, style, children }: { label: string; style?: ViewProps['style']; children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (reduceMotion) return;
    pulse.set(withRepeat(withTiming(0.55, { duration: 900, easing: Easing.inOut(Easing.ease) }), -1, true));
  }, [pulse, reduceMotion]);
  const breathe = useAnimatedStyle(() => ({ opacity: pulse.get() }));
  return <View accessible accessibilityRole="progressbar" accessibilityLabel={label}>
    <Animated.View style={breathe}><View style={style}>{children}</View></Animated.View>
  </View>;
}

/** One placeholder shape. Use inside SkeletonGroup. */
export function Bone({ width = '100%', height = 14, radius = Radius.bar, style }: { width?: DimensionValue; height?: DimensionValue; radius?: number; style?: ViewProps['style'] }) {
  const colors = useTheme();
  return <View style={[{ width, height, borderRadius: radius, backgroundColor: colors.track }, style]} />;
}
