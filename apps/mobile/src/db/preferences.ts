import { eq } from 'drizzle-orm';
import type { Ledger } from './ledger';
import { preferences, themePreferences } from './schema';

export type ThemePreference = typeof themePreferences[number];

/** Validated reads and writes for app settings stored beside the ledger. */
export function createPreferences(db: Ledger['db']) {
  return {
    async getThemePreference(): Promise<ThemePreference> {
      const row = await db.select({ value: preferences.value }).from(preferences).where(eq(preferences.key, 'theme')).get();
      // An unknown stored value (from a newer build, say) falls back to following the system.
      return themePreferences.find((value) => value === row?.value) ?? 'system';
    },
    async setThemePreference(value: ThemePreference): Promise<void> {
      if (!themePreferences.includes(value)) throw new TypeError(`theme must be one of ${themePreferences.join(', ')}`);
      await db.insert(preferences).values({ key: 'theme', value })
        .onConflictDoUpdate({ target: preferences.key, set: { value } }).run();
    },
  };
}
