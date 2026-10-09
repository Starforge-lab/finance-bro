/**
 * Design tokens for the "Ink and Stamps" system (C2 light, C3 dark).
 * DESIGN.md at the repo root explains where each token is used; keep every
 * colour, font, radius, shadow and motion value in the app flowing from here.
 */

/** The highlighter. One or two spots per screen, never a fill for large areas. */
const HIGHLIGHT = '#FFC83D';

export const Colors = {
  light: {
    text: '#17181D',
    textSecondary: '#4B4E58',
    textMuted: '#8B8E98',
    background: '#F1F2F5',
    backgroundElement: '#FFFFFF',
    backgroundSelected: '#E1E3E8',
    border: '#17181D',
    rule: '#D9DBE1',
    track: '#E1E3E8',
    fill: '#17181D',
    accent: HIGHLIGHT,
    onAccent: '#17181D',
    heroBackground: '#17181D',
    heroText: '#F1F2F5',
    heroTextSecondary: '#B9BBC4',
    heroRule: '#34363F',
    credit: '#17181D',
    debit: '#17181D',
    over: '#C8372A',
    shadow: '#17181D',
    tabBar: 'rgba(255, 255, 255, 0.55)',
    tabBarBorder: 'rgba(23, 24, 29, 0.16)',
    tabSelected: 'rgba(23, 24, 29, 0.09)',
    tabText: '#3E414B',
    scrim: 'rgba(23, 24, 29, 0.42)',
  },
  dark: {
    text: '#ECEAF2',
    textSecondary: '#A3A2B0',
    textMuted: '#8E8FA0',
    background: '#16171C',
    backgroundElement: '#22242C',
    backgroundSelected: '#2A2C35',
    border: '#3A3C48',
    rule: '#2C2E37',
    track: '#2A2C35',
    fill: '#ECEAF2',
    accent: HIGHLIGHT,
    onAccent: '#16171C',
    heroBackground: '#ECEAF2',
    heroText: '#16171C',
    heroTextSecondary: '#4B4D57',
    heroRule: '#C9C7D1',
    credit: '#ECEAF2',
    debit: '#ECEAF2',
    over: '#FF7A66',
    shadow: '#0A0A0E',
    tabBar: 'rgba(236, 234, 242, 0.16)',
    tabBarBorder: 'rgba(236, 234, 242, 0.24)',
    tabSelected: 'rgba(10, 10, 14, 0.42)',
    tabText: '#D4D2DC',
    scrim: 'rgba(0, 0, 0, 0.6)',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

/**
 * Category stamps: the only place hue appears besides the highlighter.
 * `dot` marks the category; `tint`/`onTint` are the small tag pill.
 */
export const Categories = {
  light: {
    food: { dot: '#D9694B', tint: '#F7DDD7', onTint: '#9C2C1C' },
    rent: { dot: '#4F74B0', tint: '#DCE5F3', onTint: '#2A4A80' },
    groceries: { dot: '#6F9A45', tint: '#E3EED6', onTint: '#3D5C1F' },
    shopping: { dot: '#B8628A', tint: '#F3DDE8', onTint: '#7A2F55' },
    travel: { dot: '#3E9E91', tint: '#DDEFE9', onTint: '#1F5E55' },
    bills: { dot: '#B8962E', tint: '#FFF1C7', onTint: '#6B5000' },
  },
  dark: {
    food: { dot: '#E28F78', tint: '#3A221D', onTint: '#FF9A85' },
    rent: { dot: '#7FA0D8', tint: '#1D2639', onTint: '#A9C2EC' },
    groceries: { dot: '#A6C77A', tint: '#232E19', onTint: '#C2DD9C' },
    shopping: { dot: '#D795B4', tint: '#36202B', onTint: '#EDB3CE' },
    travel: { dot: '#6FC2B4', tint: '#18332E', onTint: '#7FD1C4' },
    bills: { dot: '#C9B26F', tint: '#3A3115', onTint: '#FFD36B' },
  },
} as const;

export type Category = keyof typeof Categories.light;

/**
 * Loaded in the root layout. React Native picks a face by family name, so each
 * weight is its own family; don't rely on fontWeight with these.
 */
export const Fonts = {
  sans: 'BricolageGrotesque_400Regular',
  sansSemiBold: 'BricolageGrotesque_600SemiBold',
  sansHeavy: 'BricolageGrotesque_800ExtraBold',
  mono: 'SpaceMono_400Regular',
  monoBold: 'SpaceMono_700Bold',
} as const;

export const Type = {
  /** Money as the hero of a card. */
  amountHero: { fontFamily: Fonts.monoBold, fontSize: 46, lineHeight: 46, letterSpacing: -1.8 },
  /** Money in rows and stats. */
  amount: { fontFamily: Fonts.monoBold, fontSize: 16, lineHeight: 22 },
  amountSmall: { fontFamily: Fonts.monoBold, fontSize: 13, lineHeight: 18 },
  screenTitle: { fontFamily: Fonts.sansHeavy, fontSize: 32, lineHeight: 36, letterSpacing: -1.28 },
  sectionTitle: { fontFamily: Fonts.sansHeavy, fontSize: 20, lineHeight: 24, letterSpacing: -0.4 },
  rowTitle: { fontFamily: Fonts.sansHeavy, fontSize: 16, lineHeight: 22 },
  body: { fontFamily: Fonts.sans, fontSize: 15, lineHeight: 22 },
  note: { fontFamily: Fonts.sans, fontSize: 13, lineHeight: 19 },
  label: { fontFamily: Fonts.sansSemiBold, fontSize: 12, lineHeight: 16 },
  tab: { fontFamily: Fonts.sansSemiBold, fontSize: 11, lineHeight: 14 },
} as const;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
  /** Side gutter for every screen. */
  gutter: 20,
  /** Gap between sections on a scrolling screen. */
  section: 28,
  /** Bottom padding so content scrolls clear of the floating tab bar. */
  tabBarClearance: 120,
} as const;

export const Radius = {
  bar: 5,
  tile: 12,
  control: 14,
  card: 18,
  hero: 22,
  pill: 999,
} as const;

/** Ink outlines. Light mode draws them in ink; dark mode uses `border`. */
export const Stroke = {
  ink: 2,
  hairline: 1.5,
} as const;

/**
 * Offset ink shadows: zero blur, printed rather than lit. Light mode only;
 * dark surfaces stay flat (see DESIGN.md, Elevation & Depth).
 */
export const Shadow = {
  press: '2px 3px 0 #17181D',
  card: '3px 4px 0 #17181D',
  lifted: '4px 5px 0 #17181D',
} as const;

export const Motion = {
  /** Expo-out. Reanimated: Easing.bezier(0.16, 1, 0.3, 1). */
  ease: [0.16, 1, 0.3, 1] as const,
  quick: 200,
  standard: 320,
  entrance: 480,
  deal: 640,
  /** Delay between items in a staggered list. */
  stagger: 60,
} as const;
