import { useColorScheme } from '@/hooks/appearance';

import { Colors } from '@/constants/theme';

export function useTheme() {
  return Colors[useColorScheme() === 'dark' ? 'dark' : 'light'];
}
