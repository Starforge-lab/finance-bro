import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Appearance, Platform, useColorScheme as useSystemColorScheme } from 'react-native';

import { getLedger, type ThemePreference } from '@/db';

type AppearanceState = { preference: ThemePreference; setPreference: (next: ThemePreference) => Promise<void> };
const AppearanceContext = createContext<AppearanceState | null>(null);

/** Applies the saved System / Light / Dark choice app-wide and persists changes to the ledger. */
export function AppearanceProvider({ initial, children }: { initial: ThemePreference; children: ReactNode }) {
  const [preference, setState] = useState(initial);
  useEffect(() => {
    // Native chrome (tab bar, dialogs, status bar) follows this; web resolves through useColorScheme below.
    if (Platform.OS !== 'web') Appearance.setColorScheme(preference === 'system' ? 'auto' : preference);
  }, [preference]);
  const setPreference = useCallback(async (next: ThemePreference) => {
    setState(next);
    await (await getLedger()).setThemePreference(next);
  }, []);
  const value = useMemo(() => ({ preference, setPreference }), [preference, setPreference]);
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useThemePreference(): AppearanceState {
  const state = useContext(AppearanceContext);
  if (!state) throw new Error('useThemePreference needs an AppearanceProvider');
  return state;
}

/** The scheme screens should draw with: the user's choice, else the system's. */
export function useColorScheme(): 'light' | 'dark' {
  const preference = useContext(AppearanceContext)?.preference ?? 'system';
  const system = useSystemColorScheme();
  if (preference !== 'system') return preference;
  return system === 'dark' ? 'dark' : 'light';
}
