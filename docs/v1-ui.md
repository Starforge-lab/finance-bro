# Connected manual-first UI

## Scope

The frontend connects the shared local data API to Home, entry/edit/delete, paste review/save, category budgets, bills, Insights, account/category management and CSV export. It follows Rohan's PR #33 Ink and Stamps typography, colors, outlines, fanned cards, category tiles and screen compositions. Quicksave is retired.

The user requested minimal text, minimal overwhelm and low effort after a full workday. Home names the purpose; new entries require only an amount. Date defaults to today and preserves the current India clock; edits preserve the original clock. Category, account and note are optional details. Filters, the full entry list, additional insights and calculation explanations start collapsed. Validation, explicit save errors and discard protection remain.

Android uses Router tabs for the reference floating capsule, with symmetric side insets and fully visible labels. Entry and paste hide that capsule. The entry footer avoids the keyboard and bottom system area. iOS retains NativeTabs and requires Rohan's device validation.

## Observed validation

On 2026-10-08, a Motorola Edge 60 Pro running Android 17 rendered the connected screens against a temporary, separate fictional ledger:

- Home displayed the purpose, three fanned entries, real monthly totals, category tiles and collapsed controls.
- Add opened the decimal keyboard. A ₹12.34 expense saved with no optional details and raised monthly spending from ₹7,598.00 to ₹7,610.34.
- After fixing keyboard overlap, Save was visibly above the keyboard and worked without dismissing it first.
- After a process restart, the capsule had equal side insets and all four labels were visible; tab navigation worked.
- Budgets displayed the overall remaining limit and Food's ₹50 overspend using the fictional recorded entries.
- Insights started with the summary and one factual category statement; More insights revealed the six-month chart.
- Settings displayed concise local-data and paste-text handling copy plus the fictional account.
- Light Home showed the expected paper, ink outlines, hard shadows and category stamps; dark Home and the other screens were also observed. This is a targeted visual check, not exhaustive accessibility or device certification.

The temporary source hook was restored, the isolated database and device test captures were deleted, and the phone's original dark-mode setting was restored. Normal financial data was not inspected. Local screenshots are development evidence and are not published to GitHub.

The current exported browser build was exercised on 2026-10-08 with fictional data: amount-only form, rejection of ₹12.345 with input retained, successful ₹12.34 save, immediate spending update from ₹550.25 to ₹562.59, and persistence after reload. Earlier browser checks covered edit, a category budget and paid bill, and CSV download; those broader flows preceded the latest disclosure refinements.

The calmer paste flow was also exercised with fictional data on 2026-10-08:

- Browser: ambiguous input kept required fields open and Save disabled until corrected; the corrected entry survived reload. OTP input offered no Save and Paste another cleared the input. A previously deleted paste returned Already handled without adding a record. Checked choices exposed their selected state, and Keep editing retained an unsaved message.
- Before the disclosure refinements, browser replay tests confirmed that re-pasting preserved a corrected amount and did not resurrect a deleted entry. These replay cases still need repetition at the final release revision.
- Android: a valid paste saved. Losing only an isolated test fingerprint key exposed Duplicate risk outside optional details, blocked Save until acknowledged, and allowed an explicitly acknowledged save. Back offered a discard dialog; Keep editing retained the prepared transaction.
- The development APK from run 37776174519, built at 4f920d0, installed successfully and retained the isolated fictional ledger. Current source was served through Metro. A fresh restart after the navigation-readiness fix rendered Home without the earlier navigation initialization error.
- The isolated key was deleted and its absence confirmed; the isolated database and device captures were removed. Both temporary source hooks were restored. Normal financial records and fingerprint keys were not inspected or changed.

After restoring normal source configuration, frozen install, pnpm check (28 mobile/data and 31 parser tests), Expo dependency check, Expo Doctor (20/20), Android/iOS/web bundle exports and git diff --check passed again. CI and native APK checks remain revision-specific.

The accessibility checkpoint adds explicit web pressed/expanded/busy and progress-value attributes while retaining native states. Focus rings cover buttons, radios, checkboxes and tabs. Empty Home avoids repeating Paste when More is open. Targeted fictional-data checks on 2026-10-08 observed:

- Browser: Home Cards/Chart and filters announced selection; More and entry disclosures announced expanded/collapsed states. Enter opened Add, Space selected Income, and the focused choice had a visible outline. Discard was a one-shot action, not a toggle.
- A fictional expense category saved. A three-decimal budget amount was rejected with input retained; a ₹1,000 category limit saved and persisted after reload. The overall progress announced 75% for ₹750 recorded spending, and the category progress announced zero.
- A ₹499.99 fictional bill saved, changed to Paid and stayed paid after reload. Recorded spending remained ₹750 and the ledger still contained one entry.
- The browser downloaded a CSV containing that one posted ₹750.00 paste expense. Its columns contained no raw message body, and the paid bill was not exported as a ledger entry. This download check does not prove every CSV edge case or platform destination.
- Android: on a separate empty test database, Cards was selected; Expense/Income native selected states followed the chosen type. Opening More left exactly one Paste action. The isolated database and device hierarchy capture were removed and the temporary filename restored; normal financial data was not inspected.

These are targeted keyboard/accessibility-tree checks, not a complete screen-reader or large-text certification. The local screenshot contains fictional data and is not published to GitHub.

## Requested visual demo

On 2026-10-08, the user requested seeded data to inspect the full visuals and confirmed the development app would not be used for real finances until later. A first fixture (31 entries over six months) was seeded on the Motorola.

The fixture was then replaced by a realistic one in `apps/mobile/src/dev/seed-demo.ts` (ids `demo-v2-*`). It covers the three previous calendar months plus the current month to date for a fictional first-job IT fresher in Noida: ₹32,000 take-home on the 1st, ₹9,500 PG rent in Sector 62, office cafeteria, chai, weekend Swiggy/Zomato, Blinkit/Zepto, Rapido, Delhi Metro outings, Jio, Spotify, Netflix, a pharmacy run, a haircut and a monthly movie. About 230 entries for a run in early October. Five accounts (SBI salary, Kotak 811 savings, an SBI credit card, Paytm UPI Lite, cash), eight expense and four income categories, monthly budgets for every month and six bills (upcoming, overdue and paid). Brands are real so screens look like the shipped app; the person, employer, account digits and UPI references are invented.

Second-order cases are deliberate and tested: monthly savings and UPI Lite top-ups as two-leg own-account transfers, the credit-card bill paying the previous month's card spend, an ATM withdrawal funding cash spends, two failed UPI payments each followed by a successful retry, a pending order, a reimbursable cab excluded from stats, a returned purchase refunded and linked to its original, freelance income, quarterly savings interest and small cashback. The second month raises the Travel budget for a train trip home; the third month's festive sale puts Shopping, and only Shopping, over budget.

The plan is a pure function of the current time with a per-month seeded random generator, so earlier months don't change from day to day and nothing is dated in the future; today always gets three entries for Home's fanned cards. Loading runs inside one transaction through the validated data API, only into an empty ledger (real entries or the older fixture make it refuse instead of mixing in fake data), and is a no-op once loaded, so edited or deleted demo entries stay as they are. Development builds show **Settings → Test data** with *Load test data* and *Remove test data*; removal deletes demo rows, detaches real entries that pointed at demo accounts or categories, and retains any demo categories (and their parents) still used by real budgets, along with all other real data. To move a phone from the first fixture to this one, remove test data and then load it. The section and the fixture code are compiled out of release builds. Six tests cover determinism, coverage, totals against the ledger rules, the single over-budget category, load-once/refusal/removal, and rollback after a simulated storage failure.

Physical Android checks observed populated Home, Budgets, the six-month Insights chart and Settings after restart. Home was left open for the user. Local development screenshots are not published to GitHub. Project checks now include 30 mobile/data tests plus 31 parser tests; all passed, along with typecheck and lint.

## Save feedback and export recovery checkpoint — 2026-10-08

Android confirms committed manual entry saves/edits, newly inserted pastes, and budget/bill writes with the platform Confirm haptic. Validation failures and duplicate paste outcomes do not trigger it. Feedback runs without delaying navigation or refresh; unavailable haptics cannot change a successful write into a save error. Expo Haptics 58.0.5 requires a rebuilt development client. The missing-native-runtime recovery test passes; physical haptic behavior remains unverified until that client is installed. iOS feedback remains Rohan's work; web retains visual confirmation.

CSV write failures now attempt deletion of the created file. If deletion also fails, a typed error reaches Settings with a warning to check the chosen folder for an incomplete CSV. Three injected tests cover successful write, successful cleanup and failed cleanup. Account/category saves clear stale notices at the start of a new action. Web export reports a download request rather than claiming a completed save; browser verification observed the notice and an actual one-row fictional CSV download with the expected exact amount and columns.

Frozen installation, typecheck, lint, 34 mobile/data tests plus 31 parser tests, SDK dependency check, Expo Doctor (20/20), and Android/iOS/web exports passed. These checks do not prove Android destination cancellation, filesystem error behavior or physical haptics. Android's existing folder picker retains persisted directory grants; replacing it with a single-file destination or releasing grants is still required. Rohan's design-system PR #33 is now merged into dev; #31 and #37 remain open.

## Identical no-reference paste collisions — 2026-10-09

When the sender/body identity already exists and the parsed message has no UPI reference, review offers “Same message” by default or an explicit “Separate payment” choice. The separate path exposes the existing India date/time and requires a different actual time to the nearest second; two purchases in the same second must be entered manually. A selected timestamp produces a stable retry identity. UPI-reference matches remain unsplittable. Automated SQLite tests cover two identical purchases, a retry of the selected timestamp, corrected/deleted replay protection, same-second validation, key identity and absence of raw message text. This source revision has not yet had a browser or physical-device interaction check.

## Remaining release gates

- Complete Android ambiguous/ignored/corrected/deleted replay and failure-recovery checks; repeat browser corrected/deleted replay after the latest disclosure refinements.
- Complete the current entry/edit/delete, discard, reload, failure recovery, accounts/categories, budget/bill mutations and CSV destination matrix on supported platforms.
- Rohan owns all iOS-specific work and physical-device checks, including keyboard, navigation, persistence and CSV (issue #34).
- Verify large text, screen-reader navigation, responsive web and long/large ledgers.
- Purposeful motion and reduced-motion behavior remain to be implemented/verified; Android save haptics need a matching client and device check, and iOS feedback belongs to Rohan.
- Review dependency PRs #31, #33 and #37, obtain peer review and pass CI at the exact frontend revision before promotion. Do not infer release readiness from bundle exports or screenshots.
