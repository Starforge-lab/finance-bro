package expo.modules.smsreader

import android.content.Context
import android.content.SharedPreferences

internal const val WAKE_PREFERENCES = "finance-bro.sms-reader.wake"
internal const val EVENT_COUNT = "eventCount"
internal const val LAST_RECEIVED_AT_MS = "lastReceivedAtMs"
internal const val LAST_PART_COUNT = "lastPartCount"
internal const val LAST_ATTEMPT_AT_MS = "lastAttemptAtMs"
internal const val LAST_OUTCOME = "lastOutcome"
internal const val FAILED_ATTEMPT_COUNT = "failedAttemptCount"

internal enum class SmsWakeOutcome(val value: String) {
  SUCCESS("success"),
  FAILED("failed"),
  DEFERRED("deferred")
}

internal fun Context.smsWakePreferences(): SharedPreferences =
  getSharedPreferences(WAKE_PREFERENCES, Context.MODE_PRIVATE)

internal fun recordSmsWakeReceived(preferences: SharedPreferences, nowMs: Long = System.currentTimeMillis()) {
  synchronized(preferences) {
    val eventCount = preferences.getLong(EVENT_COUNT, 0L)
    preferences.edit()
      .putLong(EVENT_COUNT, if (eventCount == Long.MAX_VALUE) eventCount else eventCount + 1)
      .putLong(LAST_RECEIVED_AT_MS, nowMs)
      .putInt(LAST_PART_COUNT, 0)
      .apply()
  }
}

internal fun recordSmsWakeOutcome(
  preferences: SharedPreferences,
  outcome: SmsWakeOutcome,
  failedAttempt: Boolean,
  nowMs: Long = System.currentTimeMillis()
): Boolean = try {
  synchronized(preferences) {
    val failures = preferences.getLong(FAILED_ATTEMPT_COUNT, 0L).coerceIn(0L, MAX_SAFE_INTEGER)
    val nextFailures = if (failedAttempt && failures < MAX_SAFE_INTEGER) failures + 1 else failures
    preferences.edit()
      .putLong(LAST_ATTEMPT_AT_MS, nowMs)
      .putString(LAST_OUTCOME, outcome.value)
      .putLong(FAILED_ATTEMPT_COUNT, nextFailures)
      .commit()
  }
} catch (_: Exception) {
  false
}

internal fun readSmsWakeMetadata(preferences: SharedPreferences): Map<String, Any?> {
  val lastOutcome = preferences.getString(LAST_OUTCOME, null)
    ?.takeIf { candidate -> SmsWakeOutcome.values().any { it.value == candidate } }
  return mapOf(
    "count" to preferences.getLong(EVENT_COUNT, 0L).coerceAtMost(MAX_SAFE_INTEGER).toDouble(),
    "lastReceivedAtMs" to preferences.getLong(LAST_RECEIVED_AT_MS, 0L).takeIf { it in 1L..MAX_SAFE_INTEGER }?.toDouble(),
    "lastMultipartCount" to 0,
    "lastAttemptAtMs" to preferences.getLong(LAST_ATTEMPT_AT_MS, 0L).takeIf { it in 1L..MAX_SAFE_INTEGER }?.toDouble(),
    "lastOutcome" to lastOutcome,
    "failedAttemptCount" to preferences.getLong(FAILED_ATTEMPT_COUNT, 0L).coerceIn(0L, MAX_SAFE_INTEGER).toDouble()
  ) + readSmsCaptureHealthMetadata(preferences)
}
