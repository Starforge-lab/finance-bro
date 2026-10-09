import { Easing, Keyframe, ReduceMotion } from 'react-native-reanimated';

import { Motion } from '@/constants/theme';

export const ease = Easing.bezier(...Motion.ease);

/**
 * A plain fade in, as a keyframe. Reanimated's preset FadeIn left some keyed views at
 * opacity 0 on Android with the New Architecture; keyframes animate reliably.
 */
export function fadeIn(delay = 0) {
  return new Keyframe({ 0: { opacity: 0 }, 100: { opacity: 1, easing: ease } }).duration(Motion.quick).delay(delay).reduceMotion(ReduceMotion.Never);
}
