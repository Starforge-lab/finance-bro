package expo.modules.smsreader

import android.content.Context
import android.content.SharedPreferences

internal const val MAX_RANGE_MS = 90L * 24 * 60 * 60 * 1000
internal const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

private const val IMPORT_SETTINGS_PREFERENCES = "finance-bro.sms-reader.import-settings"
private const val IMPORT_ENABLED = "enabled"
private const val IMPORT_START_DATE_MS = "startDateMs"
private const val PREVIEW_END_DATE_MS = "previewEndDateMs"

internal data class SmsImportSettings(val enabled: Boolean, val startDateMs: Long?) {
  fun toMap() = mapOf("enabled" to enabled, "startDateMs" to startDateMs?.toDouble())
}

internal fun Context.smsImportSettingsPreferences(): SharedPreferences =
  getSharedPreferences(IMPORT_SETTINGS_PREFERENCES, Context.MODE_PRIVATE)

internal fun readImportSettings(
  preferences: SharedPreferences,
  nowMs: Long = System.currentTimeMillis()
): SmsImportSettings = try {
  val startDateMs = readStoredStartDate(preferences)
  SmsImportSettings(preferences.getBoolean(IMPORT_ENABLED, false) && startDateMs != null && startDateMs <= nowMs, startDateMs)
} catch (_: Exception) {
  SmsImportSettings(enabled = false, startDateMs = null)
}

internal fun setImportSettings(
  preferences: SharedPreferences,
  options: Map<String, Any?>,
  nowMs: Long = System.currentTimeMillis()
): SmsImportSettings = synchronized(preferences) {
  require(options.keys.all { it == IMPORT_ENABLED || it == IMPORT_START_DATE_MS || it == PREVIEW_END_DATE_MS }) {
    "SMS import settings contain an unsupported option"
  }
  val enabled = options[IMPORT_ENABLED] as? Boolean
    ?: throw IllegalArgumentException("enabled must be a boolean")
  val requestedStartDateMs = options[IMPORT_START_DATE_MS]?.let { parseStartDate(it, nowMs) }
  require(!options.containsKey(IMPORT_START_DATE_MS) || options[IMPORT_START_DATE_MS] != null) {
    "startDateMs must be a safe integer"
  }
  val previewEndDateMs = options[PREVIEW_END_DATE_MS]?.let { parseTimestamp(it, PREVIEW_END_DATE_MS, nowMs) }
  require(!options.containsKey(PREVIEW_END_DATE_MS) || options[PREVIEW_END_DATE_MS] != null) {
    "previewEndDateMs must be a safe integer"
  }

  val startDateMs = if (enabled) {
    require(requestedStartDateMs != null) { "startDateMs is required when enabling SMS import" }
    val existingStartDateMs = readStoredStartDate(preferences)
    if (existingStartDateMs == null) {
      require(previewEndDateMs != null) { "previewEndDateMs is required for the initial SMS import" }
      require(previewEndDateMs >= requestedStartDateMs) {
        "The SMS preview end cannot be earlier than its start"
      }
      require(previewEndDateMs - requestedStartDateMs <= MAX_RANGE_MS) {
        "The initial SMS import range cannot exceed 90 days"
      }
      requestedStartDateMs
    } else {
      require(previewEndDateMs == null || previewEndDateMs >= requestedStartDateMs) {
        "The SMS preview end cannot be earlier than its original start"
      }
      require(requestedStartDateMs == existingStartDateMs) {
        "SMS import must resume from its original start date"
      }
      existingStartDateMs
    }
  } else {
    readStoredStartDateFailSoft(preferences)
  }

  val editor = preferences.edit().putBoolean(IMPORT_ENABLED, enabled)
  if (enabled && !preferences.contains(IMPORT_START_DATE_MS)) {
    editor.putLong(IMPORT_START_DATE_MS, startDateMs!!)
  }
  commitFailClosed(preferences, editor)
  SmsImportSettings(enabled = enabled, startDateMs = startDateMs)
}

private fun parseStartDate(value: Any, nowMs: Long): Long {
  return parseTimestamp(value, IMPORT_START_DATE_MS, nowMs)
}

private fun parseTimestamp(value: Any, name: String, nowMs: Long): Long {
  val number = value as? Number ?: throw IllegalArgumentException("$name must be a safe integer")
  val timestamp = number.toDouble()
  require(
    timestamp.isFinite() && timestamp > 0.0 && timestamp <= MAX_SAFE_INTEGER.toDouble() && timestamp % 1.0 == 0.0
  ) { "$name must be a safe integer" }
  val parsed = timestamp.toLong()
  require(parsed <= nowMs) { "$name cannot be in the future" }
  return parsed
}

private fun readStoredStartDate(preferences: SharedPreferences): Long? {
  if (!preferences.contains(IMPORT_START_DATE_MS)) return null
  val startDateMs = preferences.getLong(IMPORT_START_DATE_MS, 0L)
  require(startDateMs in 1L..MAX_SAFE_INTEGER) { "Stored SMS import start date is invalid" }
  return startDateMs
}

private fun readStoredStartDateFailSoft(preferences: SharedPreferences): Long? = try {
  readStoredStartDate(preferences)
} catch (_: Exception) {
  null
}

private fun commitFailClosed(preferences: SharedPreferences, editor: SharedPreferences.Editor) {
  val failure = try {
    if (editor.commit()) return
    IllegalStateException("Could not persist SMS import settings")
  } catch (cause: Exception) {
    IllegalStateException("Could not persist SMS import settings", cause)
  }

  try {
    if (!preferences.edit().putBoolean(IMPORT_ENABLED, false).commit()) {
      failure.addSuppressed(IllegalStateException("Could not clear the in-memory SMS import setting"))
    }
  } catch (rollbackFailure: Exception) {
    failure.addSuppressed(rollbackFailure)
  }
  throw failure
}
