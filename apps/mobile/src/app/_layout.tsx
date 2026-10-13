import { BricolageGrotesque_400Regular } from '@expo-google-fonts/bricolage-grotesque/400Regular';
import { BricolageGrotesque_600SemiBold } from '@expo-google-fonts/bricolage-grotesque/600SemiBold';
import { BricolageGrotesque_800ExtraBold } from '@expo-google-fonts/bricolage-grotesque/800ExtraBold';
import { SpaceMono_400Regular } from '@expo-google-fonts/space-mono/400Regular';
import { SpaceMono_700Bold } from '@expo-google-fonts/space-mono/700Bold';
import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import AppTabs from '@/components/app-tabs';
import { getLedger, type ThemePreference } from '@/db';
import { AppearanceProvider, useColorScheme } from '@/hooks/appearance';
import { runEnabledAndroidSmsCatchup, abortAndroidSmsCatchup, recordAndroidSmsCatchupFailure } from '@/imports/android-sms-flow';
import { getSmsReader } from '../../modules/sms-reader';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [theme, setTheme] = useState<ThemePreference | null>(null);
  const [loaded, error] = useFonts({
    BricolageGrotesque_400Regular,
    BricolageGrotesque_600SemiBold,
    BricolageGrotesque_800ExtraBold,
    SpaceMono_400Regular,
    SpaceMono_700Bold,
  });

  // The saved theme is read before the splash lifts so the first frame is already in the right scheme.
  // If the ledger can't open, follow the system; the screens report the storage error themselves.
  useEffect(() => {
    getLedger().then((ledger) => ledger.getThemePreference()).catch((): ThemePreference => 'system').then(setTheme);
  }, []);

  // A font that fails to load falls back to the system face; don't hold the splash for it.
  const ready = (loaded || Boolean(error)) && theme !== null;
  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let active = true;
    let foregroundGeneration = 0;
    const isForeground = (generation: number) => active &&
      generation === foregroundGeneration && AppState.currentState === 'active';
    const catchUp = async () => {
      const generation = foregroundGeneration;
      try {
        const reader = getSmsReader();
        if (!reader) return;
        const settings = await reader.getImportSettingsAsync();
        if (!isForeground(generation) || settings.enabled !== true || settings.startDateMs === null) return;
        const ledger = await getLedger();
        if (!isForeground(generation)) return;
        await runEnabledAndroidSmsCatchup(reader, ledger, settings.startDateMs, Date.now());
      } catch (error) {
        if (isForeground(generation)) recordAndroidSmsCatchupFailure(error);
      }
    };
    if (AppState.currentState === 'active') void catchUp();
    const subscription = AppState.addEventListener('change', (state) => {
      foregroundGeneration += 1;
      if (state === 'active') void catchUp();
      else abortAndroidSmsCatchup();
    });
    return () => {
      active = false;
      foregroundGeneration += 1;
      subscription.remove();
      abortAndroidSmsCatchup();
    };
  }, []);

  if (!ready) return null;

  return (
    <AppearanceProvider initial={theme}>
      <Shell />
    </AppearanceProvider>
  );
}

function Shell() {
  const scheme = useColorScheme();
  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <AppTabs />
    </ThemeProvider>
  );
}
