package expo.modules.smsreader

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

private const val WAKE_PREFERENCES = "finance-bro.sms-reader.wake"
private const val EVENT_COUNT = "eventCount"
private const val LAST_RECEIVED_AT_MS = "lastReceivedAtMs"
private const val LAST_PART_COUNT = "lastPartCount"

class SmsWakeReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
    val settings = readImportSettings(context.smsImportSettingsPreferences())
    val partCount = readPartCountIfImportEnabled(settings.enabled) {
      Telephony.Sms.Intents.getMessagesFromIntent(intent)?.size ?: 0
    } ?: return

    if (partCount == 0) return

    val preferences = context.getSharedPreferences(WAKE_PREFERENCES, Context.MODE_PRIVATE)
    val eventCount = preferences.getLong(EVENT_COUNT, 0L)
    preferences.edit()
      .putLong(EVENT_COUNT, if (eventCount == Long.MAX_VALUE) eventCount else eventCount + 1)
      .putLong(LAST_RECEIVED_AT_MS, System.currentTimeMillis())
      .putInt(LAST_PART_COUNT, partCount)
      .apply()
  }
}

internal fun readPartCountIfImportEnabled(enabled: Boolean, readPartCount: () -> Int): Int? {
  if (!enabled) return null
  return runCatching(readPartCount).getOrDefault(0)
}
