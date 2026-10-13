import { SymbolView } from 'expo-symbols';
import type { ColorValue } from 'react-native';

/** One glyph set for the app: SF Symbols on iOS, Material Symbols on Android and web. */
const glyphs = {
  food: { ios: 'fork.knife', android: 'restaurant' },
  rent: { ios: 'house', android: 'home' },
  groceries: { ios: 'cart', android: 'shopping_cart' },
  shopping: { ios: 'bag', android: 'shopping_bag' },
  travel: { ios: 'bus', android: 'directions_bus' },
  bills: { ios: 'doc.text', android: 'receipt_long' },
  health: { ios: 'cross.case', android: 'medical_services' },
  fun: { ios: 'ticket', android: 'theaters' },
  salary: { ios: 'briefcase', android: 'work' },
  income: { ios: 'indianrupeesign', android: 'payments' },
  savings: { ios: 'banknote', android: 'savings' },
  cashback: { ios: 'gift', android: 'redeem' },
  category: { ios: 'tag', android: 'sell' },
  transfer: { ios: 'arrow.left.arrow.right', android: 'swap_horiz' },
  withdrawal: { ios: 'banknote', android: 'local_atm' },
  refund: { ios: 'arrow.uturn.backward', android: 'undo' },
  filter: { ios: 'line.3.horizontal.decrease', android: 'filter_list' },
  expand: { ios: 'chevron.down', android: 'expand_more' },
  next: { ios: 'chevron.right', android: 'chevron_right' },
  add: { ios: 'plus', android: 'add' },
  paste: { ios: 'doc.on.clipboard', android: 'content_paste' },
  back: { ios: 'chevron.left', android: 'arrow_back' },
  edit: { ios: 'pencil', android: 'edit' },
  check: { ios: 'checkmark', android: 'check' },
  close: { ios: 'xmark', android: 'close' },
  info: { ios: 'info.circle', android: 'info' },
  remove: { ios: 'trash', android: 'delete' },
  light: { ios: 'sun.max', android: 'light_mode' },
  dark: { ios: 'moon', android: 'dark_mode' },
  system: { ios: 'circle.lefthalf.filled', android: 'contrast' },
  calendar: { ios: 'calendar', android: 'calendar_month' },
  bank: { ios: 'building.columns', android: 'account_balance' },
  card: { ios: 'creditcard', android: 'credit_card' },
  wallet: { ios: 'wallet.bifold', android: 'wallet' },
  cash: { ios: 'indianrupeesign.circle', android: 'attach_money' },
} as const;

export type IconName = keyof typeof glyphs;

const categoryGlyphs: Record<string, IconName> = {
  food: 'food', rent: 'rent', groceries: 'groceries', shopping: 'shopping', travel: 'travel', bills: 'bills',
  health: 'health', fun: 'fun', salary: 'salary', freelance: 'income', interest: 'savings', cashback: 'cashback',
};

/** A category's glyph by its name; anything unknown gets a plain tag rather than a guess. */
export function categoryIcon(name: string | null | undefined): IconName {
  return categoryGlyphs[(name ?? '').trim().toLowerCase()] ?? 'category';
}

/** An account's glyph by its type. */
export function accountIcon(type: string): IconName {
  return type === 'credit_card' ? 'card' : type === 'cash' ? 'cash' : type === 'bank' ? 'bank' : 'wallet';
}

export function Icon({ name, size = 20, color }: { name: IconName; size?: number; color: ColorValue }) {
  const glyph = glyphs[name];
  return <SymbolView name={{ ios: glyph.ios, android: glyph.android, web: glyph.android }} size={size} tintColor={color}
    accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />;
}
