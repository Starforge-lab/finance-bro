import { Platform } from 'react-native';
import { Easing, FadeIn, Keyframe, ReduceMotion } from 'react-native-reanimated';

import { Motion } from '@/constants/theme';

export const ease = Easing.bezier(...Motion.ease);

/**
 * Native keyframes avoid Android's invisible preset fade; web presets keep views in flow.
 */
export function fadeIn(delay = 0) {
  if (Platform.OS === 'web') {
    return FadeIn.duration(Motion.quick).delay(delay).easing(ease).reduceMotion(ReduceMotion.Never);
  }
  return new Keyframe({ 0: { opacity: 0 }, 100: { opacity: 1, easing: ease } }).duration(Motion.quick).delay(delay).reduceMotion(ReduceMotion.Never);
}
