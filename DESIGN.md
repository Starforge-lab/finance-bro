---
name: Finance Bro
description: A local expense tracker with manual entry and optional paste imports.
colors:
  ink: "#17181D"
  ink-secondary: "#4B4E58"
  ink-muted: "#8B8E98"
  cool-paper: "#F1F2F5"
  card-white: "#FFFFFF"
  rule-grey: "#D9DBE1"
  track-grey: "#E1E3E8"
  highlighter: "#FFC83D"
  over-red: "#C8372A"
  night-paper: "#16171C"
  night-card: "#22242C"
  night-ink: "#ECEAF2"
  night-ink-secondary: "#A3A2B0"
  night-border: "#3A3C48"
  night-rule: "#2C2E37"
  night-track: "#2A2C35"
  night-over: "#FF7A66"
  stamp-food: "#D9694B"
  stamp-rent: "#4F74B0"
  stamp-groceries: "#6F9A45"
  stamp-shopping: "#B8628A"
  stamp-travel: "#3E9E91"
  stamp-bills: "#B8962E"
typography:
  amount-hero:
    fontFamily: "Space Mono, monospace"
    fontSize: "46px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Bricolage Grotesque, sans-serif"
    fontSize: "32px"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.04em"
  title:
    fontFamily: "Bricolage Grotesque, sans-serif"
    fontSize: "20px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  row-title:
    fontFamily: "Bricolage Grotesque, sans-serif"
    fontSize: "16px"
    fontWeight: 800
    lineHeight: 1.35
  body:
    fontFamily: "Bricolage Grotesque, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
  note:
    fontFamily: "Bricolage Grotesque, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Bricolage Grotesque, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.3
  amount:
    fontFamily: "Space Mono, monospace"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.35
rounded:
  bar: "5px"
  tile: "12px"
  control: "14px"
  card: "18px"
  hero: "22px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  gutter: "20px"
  lg: "24px"
  section: "28px"
  tab-clearance: "120px"
components:
  button-add:
    backgroundColor: "{colors.highlighter}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    size: "52px"
  button-pill:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "44px"
    padding: "0 14px"
  button-pill-dark:
    backgroundColor: "{colors.night-card}"
    textColor: "{colors.night-ink}"
    rounded: "{rounded.pill}"
    height: "44px"
    padding: "0 14px"
  card:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "16px"
  card-dark:
    backgroundColor: "{colors.night-card}"
    textColor: "{colors.night-ink}"
    rounded: "{rounded.card}"
    padding: "16px"
  hero-card:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.cool-paper}"
    rounded: "{rounded.hero}"
    padding: "22px"
  hero-card-dark:
    backgroundColor: "{colors.night-ink}"
    textColor: "{colors.night-paper}"
    rounded: "{rounded.hero}"
    padding: "22px"
  segmented-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.cool-paper}"
    rounded: "{rounded.pill}"
    height: "44px"
  progress-bar:
    backgroundColor: "{colors.track-grey}"
    rounded: "{rounded.bar}"
    height: "10px"
  date-tile:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.tile}"
    size: "44px"
---

# Design System: Finance Bro

The reference screenshots predate the current naming decision. Their app-name and version footers are retired and must not be copied into the shipped UI. Finance Bro is the repository's working name; Ink and Stamps remains the approved visual direction.

## Overview

**Creative North Star: "Ink and Stamps"**

Finance Bro looks like a printed binder you carry in your pocket. Every surface is paper, every edge is drawn in ink, and colour arrives only the way a rubber stamp would: small, deliberate, and meaning something. A transaction is a card pulled from a bank text and filed; a month is a binder; a category is a stamp on the corner. The app never glows, never gradients, and never decorates a number to make it feel exciting. Money is set in a typewriter face because it is data, and the words around it are set in a warm grotesque because they are talking to a person.

The light world (C2) is cool off-white paper with 2px ink outlines and zero-blur offset shadows that read as print registration, not light. The dark world (C3) is the same binder at night: flat charcoal surfaces, outlines softened to a slate border, no offset shadows, and stamp colours lifted and muted so they don't vibrate on a dark ground. Both worlds share one highlighter yellow, and it is rationed.

Density is a pocket notebook: one column, 20px gutters, generous 28px breaks between sections, rows tall enough to tap. The floating glass tab bar is the only translucent surface, because it is the one piece of system chrome; everything under it is opaque paper.

**Key Characteristics:**
- Ink outlines (2px) and offset ink shadows in light mode; flat tonal layers in dark mode.
- Colour lives in category stamps and one highlighter. Charts, bars and chips are ink.
- Money is always Space Mono bold; prose is Bricolage Grotesque.
- Facts in plain sentences ("₹420 over. Swiggy is 6 of the 23 entries.") instead of chart walls.
- One authored motion per screen: cards deal in, bars grow, stamps land.

## Colors

A monochrome ink-on-paper palette with one highlighter and six quiet category stamps.

### Primary
- **Ink** (`ink`): text, outlines, offset shadows, every bar and chip in a chart, the hero card background, selected segments. The system's real primary colour.
- **Highlighter Yellow** (`highlighter`): the one thing to look at on a screen. The Add button, the pace tick on a budget bar, "Kept" or "Free" in a hero card, a renewal due soon, the "Set ₹1,300" suggestion, the "0 texts stored" figure.

### Secondary
- **Over Red** (`over-red`, `night-over` in dark): only for a budget that has gone over, and for destructive actions such as "Erase everything". It is never used for ordinary spending.

### Tertiary
- **Category Stamps** (`stamp-food`, `stamp-rent`, `stamp-groceries`, `stamp-shopping`, `stamp-travel`, `stamp-bills`): a 10px dot beside a category name, the outline of a pulled card in dark mode, and the tag pill on an insight card (tint and text pairs live in `theme.ts` `Categories`). Never fill a bar or a large area with a stamp colour.

### Neutral
- **Cool Paper** (`cool-paper`): light screen background.
- **Card White** (`card-white`): cards, pills, toggles, the unselected segment.
- **Ink Secondary** (`ink-secondary`): supporting sentences, units, asides.
- **Ink Muted** (`ink-muted`): ranks after first, dashed average lines, ghost ticks for last month.
- **Rule Grey** (`rule-grey`): 1.5px dividers between rows.
- **Track Grey** (`track-grey`): the empty part of a progress bar, switch tracks when off.
- **Night Paper / Night Card / Night Ink / Night Ink Secondary / Night Border / Night Rule / Night Track**: the C3 equivalents, in the same roles.

### Named Rules
**The One Highlighter Rule.** Yellow appears on at most two elements per screen, and one of them is usually the pace tick. If a third thing wants yellow, it is not the most important thing.

**The Ink Chart Rule.** Charts are drawn in ink. A chart that needs a legend of colours is the wrong chart; label the row instead.

**The Red Means Over Rule.** Spending is not an error. Amounts are ink. Red appears only when a budget is exceeded or an action destroys data.

## Typography

**Display and Body Font:** Bricolage Grotesque (400, 600, 800; fallback system sans)
**Data Font:** Space Mono (400, 700; fallback monospace)

**Character:** A warm, slightly quirky grotesque for everything that speaks, against a typewriter mono for everything that counts. The pairing is the stamp-and-ledger idea in type.

### Hierarchy
- **Amount Hero** (Space Mono 700, 46px, line-height 1, −0.04em): the one figure a hero card exists for (₹18,240 spent, ₹490 safe today).
- **Headline** (Bricolage 800, 32px, −0.04em): screen titles ("Insights", "Budgets").
- **Title** (Bricolage 800, 20px, −0.02em): section headings ("Six months", "Coming up").
- **Row Title** (Bricolage 800, 16px): merchant, category and setting names.
- **Body** (Bricolage 400, 15px, 1.45): hero sentences and insight-card bodies.
- **Note** (Bricolage 400, 13px, 1.45): the explanatory line under a chart or row.
- **Label** (Bricolage 600, 12px): asides, stat labels, axis labels; 11px only in the tab bar.
- **Amount** (Space Mono 700, 13–16px): every rupee value in rows and stats, right-aligned in lists.

### Named Rules
**The Money Is Mono Rule.** Every rupee amount, count and date numeral is Space Mono. Prose never is.

**The Whole Rupee Rule.** Show whole rupees (₹11,134) and paise only when there are some (₹139.50). Entry detail and forms always show exact paise.

**The No Eyebrow Rule.** Headings carry themselves. No small caps label above a title, no section numbers.

## Layout

A single column on a 390pt-wide phone with 20px gutters (`gutter`) and 52px top padding under the status bar. Sections are separated by 28px (`section`); inside a section, title to content is 12px and list rows are 10–14px tall padding with 1.5px rules between them (none after the last). Content scrolls under a floating tab bar, so every scroll view ends with 120px of bottom padding (`tab-clearance`). Horizontal card rails (insight cards) bleed to the screen edge with 20px inner padding and snap to card starts. Grids are used only for small fixed sets: three hero stats, six month bars, seven weekdays, five September stamps.

## Elevation & Depth

Light mode uses printed depth: zero-blur ink shadows offset down and right, so a card looks like it sits on the page with a registration offset. Dark mode is flat: depth comes from tonal steps (paper → card → selected), and the only shadows are the deep tinted ones under pulled cards in the hero stack. The tab bar is the single glass surface.

### Shadow Vocabulary
- **Press** (`box-shadow: 2px 3px 0 #17181D`): small buttons such as the "Set ₹1,300" suggestion.
- **Card** (`box-shadow: 3px 4px 0 #17181D`): cards, grouped settings lists, the Add button.
- **Lifted** (`box-shadow: 4px 5px 0 #17181D`): the top card in the pulled-card stack, the newest entry.
- **Dark pulled card** (`box-shadow: 3px 3px 0 <deep category tone>`, e.g. `#7A4A3D` for food): dark mode only, under a card outlined in its stamp colour.
- **Glass tab bar** (`backdrop-filter: blur(20px) saturate(180%)`, `rgba(255,255,255,0.55)` light / `rgba(236,234,242,0.16)` dark, 1px border, inset top highlight): the floating navigation only. On iOS 26+ this is the system Liquid Glass tab bar; elsewhere, the bottom navigation is tinted to match.

### Named Rules
**The Printed Not Lit Rule.** Shadows never blur in light mode. A soft drop shadow means something is wrong.

**The Night Is Flat Rule.** Dark mode drops offset ink shadows entirely; depth comes from surface tone.

## Shapes

Soft-cornered paper with drawn edges. Cards are 18px, hero cards 22px, controls 14px, date tiles 12px, bar ends 5px, and every pill, segmented control, switch and tab is fully round (999px). Outlines are 2px ink in light mode and 2px slate (`night-border`) in dark; row dividers are 1.5px hairlines. Pulled transaction cards are the only rotated shapes (−8° to 7°), fanned like a hand of cards; stamps land rotated −8°.

## Components

### Buttons
- **Add (signature):** 52px square, 18px corners, highlighter fill, 2px ink outline, card shadow. One per screen, top right of Home.
- **Pill:** 44px tall, fully round, card-white fill with a 2px ink outline, Bricolage 700 14px. Used for the month picker and secondary actions.
- **Suggestion:** a highlighter pill with press shadow for the one recommended action inside an empty state.
- **Stepper:** 44px square, 12px corners, outlined, − and + at Bricolage 800 22px.
- **Press feedback:** scale to 0.96 and drop the shadow offset by 1px over 120ms; restore with the standard ease.

### Segmented Control
- 44–48px tall, round, outlined track; the selected segment is an ink thumb (night-ink in dark) that slides 320ms with the standard ease and a selection haptic. Selected text inverts to paper. Used for Cards/Chart, entry direction, and Settings → Appearance (Auto / Light / Dark, with glyphs).

### Motion
- One authored moment: today's cards deal into the fan (640ms, 60ms stagger). Supporting motion only explains change: the pace line draws in (480ms) and budget bars grow after it; segmented thumbs slide; the month sheet slides up and its rows fade in; month content fades in on change; pressed controls scale to 0.96. Reduced motion uses existing keyframe fades for Home card, month sheet, and chart/bar entrances; pace-line and bar-fill timings settle at their final geometry, and the segmented thumb fades at its static selected position. Pressed controls use opacity feedback instead of scale. Reanimated samples the system preference at app launch; OS setting changes while the app is open require relaunch. Fades use native keyframes to avoid the Android invisible-preset issue and the web FadeIn preset to retain normal layout (`src/utils/motion.ts`).

### Switch
- 52×32 round track with a 2px outline. Off: track grey, white thumb. On: ink track with a highlighter thumb in light; night-ink track with a night-paper thumb in dark. The thumb slides 20px.

### Cards / Containers
- **Card:** 18px corners, card-white, 2px ink outline, card shadow, 16px padding. Never nest a card in a card.
- **Hero card:** 22px corners, ink fill (night-ink in dark), 22px padding, one Amount Hero, one sentence, then a ruled row of three stats. One per screen, at the top.
- **Empty state:** 2px dashed outline (ink-muted), 18px corners, no fill, a sentence and one suggestion pill.

### Progress Bars
- **Budget bar:** 10px tall (14px in a hero), track grey, ink fill, 5px ends. A 3–4px highlighter tick marks where spending would be on pace. Fixed costs have no pace tick. Over budget turns the fill and the note over-red.
- **Month pace chart (Home → Chart):** a running-total line for this month (2.5px ink, ink dot on today) over last month's (1.5px dashed secondary ink), one shared rupee axis with two recessive gridlines, and a two-item legend. The step a fixed-cost category makes (rent) is labelled "Rent · fixed", and the sentence above compares *flexible* spend with last month on the same day. Dragging the line shows that day's figures; screen readers step days with the adjust gesture. Below it, the three biggest categories plus "Other" as budget bars; a bar with no budget is muted and scaled to the largest unbudgeted spend. Tapping a category bar filters the entries; "Other" groups the remaining categories and is informational only, not tappable.

### Icons
- One glyph set: SF Symbols on iOS, Material Symbols on Android and web (`expo-symbols`, `src/components/icon.tsx`). Every category, account type and repeated action has a glyph; use the glyph instead of a word when the meaning survives (filter, add, paste, edit, chevrons). Glyphs in a filled stamp take paper ink; outlined glyph tiles are 36–40px with a 2px outline.

### Month Picker
- The month is a sheet-first control, not exposed as a pair of previous/next buttons. On Home it is the screen title itself ("October ⌄"); elsewhere a pill beside the title. The sheet lists entry months newest first, plus the current and viewed month even without entries; each row shows spend and entry count. Compact previous/next controls inside the sheet reach empty and future months for budget planning.

### Lists
- Entries are grouped under day labels (Today, Yesterday, "Tue, 6 Oct") in Label type. Each row: a 40px outlined glyph tile, a Row Title, one Label line of meta, and the amount in Space Mono on the right. Transfers and cash withdrawals carry no sign and sit in muted ink; failed amounts are struck through. 1.5px rules between rows in a group.

### Navigation
- A floating capsule 64px tall, 16px from the sides, 24px above the bottom, four tabs (Home, Budgets, Insights, Settings) with 22px stroked icons and 11px labels. The selected tab sits on a round tint (`rgba(23,24,29,0.09)` light, `rgba(10,10,14,0.42)` dark) with an 800-weight label. The app retains NativeTabs on iOS and web; Android uses Router tabs to match the floating capsule because the native Material bar cannot float. Hide the Android capsule during entry/paste. On web, reserve tab-bar clearance below manual-entry actions so both buttons stay above the floating capsule. iOS requires Rohan’s device verification.

### Pulled Cards (signature)
- 148×194 cards fanned in a stack under Today on Home, rotated, each with a category glyph stamp, merchant and amount; back cards keep their words in the part the front card leaves visible. The newest is larger (166×216), lifted, and carries a rotated "New" stamp. They deal in with a 640ms expo-out arc.

## Do's and Don'ts

### Do:
- **Do** set every rupee value in Space Mono 700 and right-align it in lists.
- **Do** draw charts, bars and chips in ink, and name each row instead of using a colour legend.
- **Do** spend yellow on one or two things per screen: the Add button, a pace tick, the single best figure.
- **Do** write insights as one plain sentence with numbers ("Food already passed September").
- **Do** use the expo-out ease (`cubic-bezier(0.16, 1, 0.3, 1)`) and fade instead of move when reduced motion is on.
- **Do** keep 120px of scroll clearance under the floating tab bar.

### Don't:
- **Don't** use red or green for ordinary debits and credits; red means over budget or destructive.
- **Don't** blur a shadow in light mode, or add offset shadows in dark mode.
- **Don't** fill bars, chart areas or backgrounds with category colours.
- **Don't** use gradients, glows, or glass anywhere except the tab bar.
- **Don't** put a label or eyebrow above a heading, or number sections.
- **Don't** nest cards, or wrap every section in a card; most sections are open rows on paper.

## Low-energy default views

Preserve the approved Ink and Stamps visual system while shortening copy and hiding secondary controls. Home says Expense tracker; the primary path is Add → amount → Save. Date defaults to today, with category/account/note behind Add details. Filters and paste sit under More; the entry list and deeper insights start collapsed. Keep keyboard-visible Save, discard protection, accessible controls, exact money and recoverable errors.
