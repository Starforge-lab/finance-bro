# iOS App Intent spike plan (#17)

Owner: Rohan. Status: plan only; nothing is built yet. This stays outside 2.0.

### Why this design

On 2026-10-25 a Shortcuts Message automation (trigger: Message contains "debited") was run on a real iPhone. It delivered the full text of an HDFC card SMS to Shortcuts. The link path on `feat/ios-shortcuts-import` then failed: the link went through Safari to a Google search and only then opened Expo Go, which landed on Home without the message. Even when fixed, a link always opens the app, so it can't update the ledger in the background.

Options considered:

| Option | Background ledger update | Verdict |
|---|---|---|
| Link to the app (current branch) | No, the app opens | Keep only as a fallback |
| `expo-app-intents` (alpha) | No | Saves the invocation natively and waits until JS runs on app open ([docs](https://docs.expo.dev/versions/v58.0.0/sdk/app-intents/)). The raw message would be persisted, which breaks the privacy rule. |
| Shortcuts writes the text to a file | No | Breaks the privacy rule |
| Parser rewritten in Swift | Yes | Forks the parser rules; CLAUDE.md forbids this |
| **Swift App Intent running the TS parser in JavaScriptCore, writing SQLite directly** | **Yes** | **Spike this** |

Apple: `supportedModes` (iOS 26) with `.background` runs an intent without opening the app ([supportedModes](https://developer.apple.com/documentation/appintents/appintent/supportedmodes.md)); `openAppWhenRun` is deprecated ([DTS](https://developer.apple.com/forums/thread/804015)).

### Proposed flow

1. A local Expo module, `modules/transaction-intent`, adds `LogBankMessageIntent` to the **main app target** (not an extension, so it uses the same container and needs no App Group). It takes `message: String` and runs with `supportedModes = .background`.
2. Automation: *Message contains "debited" → Log bank message (Message)*.
3. The intent loads a prebuilt `packages/sms-parser` bundle into a `JSContext`, passing in `receivedAt` and the locale (the parser stays pure). The text stays in memory only.
4. The intent writes the result to `finance-bro.db` (opened in JS with `openDatabaseAsync('finance-bro.db')`), using the same tables, keyed fingerprint dedupe and correction protection as paste import:
   - `transaction` result → posted entry
   - `review` result → extracted fields only, never the body, plus a local "1 to review" notification
   - `ignored` result → no write
5. Fail-safe: if the database or the fingerprint key can't be read, nothing is written and a "paste to import" notification is posted. No silent loss and no unkeyed matching.
6. When the app opens, the feed refreshes from the database.

### Questions the spike must answer (each go/no-go)

| # | Question | How to test | Pass |
|---|---|---|---|
| Q1 | Does a free Personal Team build an App Intent that shows up in Shortcuts? | Xcode on a Mac, free Apple ID, `npx expo run:ios --device` | The action is listed and runs. Record the 7-day expiry impact. |
| Q2 | Does a `.background` intent run with the app closed? | A test intent that writes one row; app force-quit | The row is present on next open and the app never came to the foreground |
| Q3 | Does it run while the phone is locked? | Same as Q2, with the phone locked after first unlock and also before first unlock | Record both. The fingerprint key is stored `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so a fail-safe "paste to import" while locked may be the correct result. |
| Q4 | Does the parser bundle run in JavaScriptCore with the same output? | Run all `packages/sms-parser` fixtures through `JSContext` and diff against the Node results | Identical results; no unsupported syntax |
| Q5 | Can Swift and the JS app write `finance-bro.db` safely at the same time? | Intent fires while the app is open on Home | No lock errors or corruption; the feed shows the new entry |
| Q6 | Does dedupe match paste import? | Same fictional message via the intent, then via paste | One entry |
| Q7 | Does the trigger fire for bank short-code senders, iMessage and unknown senders? | Real bank SMS (content not recorded) plus fictional iMessages | Record which senders fire, with the iOS version |
| Q8 | Is the message text absent from disk and logs? | Inspect the app container and the device console after Q2–Q7 | No body text found |
| Q9 | Time and memory | Measure the intent's run time, cold JSContext load included | Within the background budget; note it if `LongRunningIntent` is needed |

### Order of work

1. Q1 + Q2 with a minimal intent that writes a constant row (no parser). This is the cheapest kill switch.
2. Q4 on the Mac: build the parser bundle and run the fixtures in JavaScriptCore.
3. Join them: parse, then write. Run Q3 and Q5–Q9.
4. Write a go/no-go report on this issue, with follow-up issues if it's a go.

### Constraints

- Needs a Mac and a real iPhone. The free Apple ID path is acceptable for the spike; the $99 membership is not authorized by this plan.
- Only fictional message content in fixtures, logs and this issue.
- No hand edits to `ios/`; all native config goes through the module's config plugin.
- The fallback stays paste/manual, and the link path once it's fixed.

### Unknowns not answered by documentation

- Whether a free Personal Team can use App Intents. The capabilities table didn't list it either way.
- Locked-device behaviour and SQLite file protection (Q3).
- Whether Message automations fire reliably for every bank sender (Q7).
