# Android SMS foreground flow

The Settings import section extends the existing Ink and Stamps screens. This
is source implementation pending matching native-build and device validation,
not Android SMS 2.0 release acceptance.

## Consent and preview

Normal Android builds declare READ_SMS and RECEIVE_SMS. Neither declaration nor
an OS grant enables import. The native setting defaults off; the receiver checks
it before decoding PDUs. Manual entry and paste remain available.

The user starts the preview before either permission is requested. First use
counts a fixed 90-day interval in batches of at most 100. No preview write or
fingerprint-key creation occurs. Cancel discards the preview; a separate
confirmation records the body-free enabled flag and original start date. The
native setter validates the frozen preview interval, so delayed confirmation
does not change or invalidate the window the user saw.

Disable aborts the shared foreground import and writes the setting off, including
when enable is still pending. It preserves the original start date and committed
cursor for explicit resume. Earlier committed pages remain; the in-flight page
must roll back. The native provider cannot interrupt an already running query,
so cancellation is checked again when it returns.

## Catch-up and review

While enabled, opening or foregrounding the app runs the bounded coordinator
from the stored range/cursor. Permission and consent are checked at write
boundaries. Backgrounding aborts foreground catch-up and source counting. A
user-started OS permission dialog may finish, but preview reads begin only while
Settings is focused and the app is active; leaving Settings cancels that
continuation. Settings shows the last
successful catch-up, pending reviews, permission state and body-free failures.

Review pages hold at most 100 source references. Selecting one re-reads its exact
inbox row in memory. The existing correction form confirms through the SMS
review API, including stale-selection, duplicate, edit and tombstone checks;
it does not save the item as a paste. The parsed transaction date is the default,
with receipt time used only when no parsed date exists. A missing original or
unavailable key offers manual/paste recovery. Raw text is never displayed by
this flow or saved in its status state.

The verified rule list is still empty: uncertain formats remain in review.
Receiver-triggered processing and best-effort background scheduling are not yet
connected. Live/multipart delivery, permission lifecycle, restart/reboot,
installer/source-build eligibility and release gates remain open. The row-ID
reuse, unreadable-row progress and date-order recovery concerns in #83 must also
be resolved before this flow is ready to merge. See #16, #43, #44, #46 and #56.

Automated preview/controller checks use fictional readers. The earlier 12-check
Android storage result in `android-sms-ingestion.md` does not verify this new UI,
consent API or normal-build permission configuration.
