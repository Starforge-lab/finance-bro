package expo.modules.smsreader

import android.content.SharedPreferences
import java.lang.reflect.Proxy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SmsImportSettingsTest {
  @Test
  fun settingsDefaultToDisabled() {
    assertEquals(SmsImportSettings(false, null), readImportSettings(fakePreferences(), NOW))
  }

  @Test
  fun firstEnableIsBoundedAndDisableRetainsTheConfirmedStartForResume() {
    val preferences = fakePreferences()
    val startDateMs = NOW - MAX_RANGE_MS

    assertEquals(
      SmsImportSettings(true, startDateMs),
      setImportSettings(
        preferences,
        mapOf("enabled" to true, "startDateMs" to startDateMs, "previewEndDateMs" to NOW),
        NOW
      )
    )
    assertEquals(
      SmsImportSettings(false, startDateMs),
      setImportSettings(preferences, mapOf("enabled" to false), NOW)
    )

    val resumedAt = NOW + MAX_RANGE_MS + 1
    assertEquals(
      SmsImportSettings(true, startDateMs),
      setImportSettings(
        preferences,
        mapOf("enabled" to true, "startDateMs" to startDateMs, "previewEndDateMs" to resumedAt),
        resumedAt
      )
    )
    assertEquals(SmsImportSettings(true, startDateMs), readImportSettings(preferences, resumedAt))
  }

  @Test
  fun firstEnableUsesTheFrozenPreviewEndAfterConfirmationDelay() {
    val startDateMs = NOW - MAX_RANGE_MS
    val confirmationTimeMs = NOW + 5 * 60 * 1000

    assertEquals(
      SmsImportSettings(true, startDateMs),
      setImportSettings(
        fakePreferences(),
        mapOf("enabled" to true, "startDateMs" to startDateMs, "previewEndDateMs" to NOW),
        confirmationTimeMs
      )
    )
  }

  @Test
  fun rejectsMalformedFutureUnsafeAndOverNinetyDayInitialPreviewRanges() {
    val invalid: List<Map<String, Any?>> = listOf(
      emptyMap(),
      mapOf("enabled" to "true", "startDateMs" to NOW - 1, "previewEndDateMs" to NOW),
      mapOf("enabled" to true),
      mapOf("enabled" to true, "startDateMs" to null),
      mapOf("enabled" to true, "startDateMs" to 0L, "previewEndDateMs" to NOW),
      mapOf("enabled" to true, "startDateMs" to -1L, "previewEndDateMs" to NOW),
      mapOf("enabled" to true, "startDateMs" to NOW + 1, "previewEndDateMs" to NOW),
      mapOf("enabled" to true, "startDateMs" to NOW - 1),
      mapOf("enabled" to true, "startDateMs" to NOW - 1, "previewEndDateMs" to null),
      mapOf("enabled" to true, "startDateMs" to NOW - MAX_RANGE_MS - 1, "previewEndDateMs" to NOW),
      mapOf("enabled" to true, "startDateMs" to NOW - 0.5, "previewEndDateMs" to NOW),
      mapOf("enabled" to true, "startDateMs" to 9_007_199_254_740_992.0, "previewEndDateMs" to NOW),
      mapOf("enabled" to true, "startDateMs" to "1700000000000", "previewEndDateMs" to NOW),
      mapOf("enabled" to true, "startDateMs" to NOW - 1, "previewEndDateMs" to NOW + 1),
      mapOf("enabled" to true, "startDateMs" to NOW - 1, "previewEndDateMs" to NOW - 2),
      mapOf("enabled" to true, "startDateMs" to NOW - 1, "previewEndDateMs" to NOW - 0.5),
      mapOf("enabled" to true, "startDateMs" to NOW - 1, "previewEndDateMs" to "1700000000000"),
      mapOf("enabled" to true, "startDateMs" to NOW - 1, "previewEndDateMs" to 9_007_199_254_740_992.0),
      mapOf("enabled" to true, "startDateMs" to NOW - 1, "previewEndDateMs" to null),
      mapOf("enabled" to true, "startDateMs" to NOW - 1, "previewEndDateMs" to NOW, "unexpected" to true)
    )
    invalid.forEach { options ->
      assertThrows(IllegalArgumentException::class.java) { setImportSettings(fakePreferences(), options, NOW) }
    }
  }

  @Test
  fun reenableMustReuseTheOriginalStartDate() {
    val preferences = fakePreferences()
    val startDateMs = NOW - 1
    setImportSettings(
      preferences,
      mapOf("enabled" to true, "startDateMs" to startDateMs, "previewEndDateMs" to NOW),
      NOW
    )
    setImportSettings(preferences, mapOf("enabled" to false), NOW)

    assertThrows(IllegalArgumentException::class.java) {
      setImportSettings(preferences, mapOf("enabled" to true, "startDateMs" to startDateMs - 1), NOW)
    }
    assertEquals(SmsImportSettings(false, startDateMs), readImportSettings(preferences, NOW))
  }

  @Test
  fun preferenceCommitFailureRejectsAndLeavesTheSettingDisabled() {
    val preferences = fakePreferences(commitResult = false)

    assertThrows(IllegalStateException::class.java) {
      setImportSettings(
        preferences,
        mapOf("enabled" to true, "startDateMs" to NOW - 1, "previewEndDateMs" to NOW),
        NOW
      )
    }
    assertFalse(readImportSettings(preferences, NOW).enabled)
  }

  @Test
  fun wakeMetadataKeepsTheMultipartFieldUnknownAndRecordsOnlyBodyFreeOutcomes() {
    val preferences = fakePreferences()
    recordSmsWakeReceived(preferences, NOW)
    assertEquals(0, readSmsWakeMetadata(preferences)["lastMultipartCount"])

    assertTrue(recordSmsWakeOutcome(preferences, SmsWakeOutcome.DEFERRED, failedAttempt = true, nowMs = NOW + 1))
    assertTrue(recordSmsWakeOutcome(preferences, SmsWakeOutcome.SUCCESS, failedAttempt = false, nowMs = NOW + 2))
    val metadata = readSmsWakeMetadata(preferences)
    assertEquals(NOW + 2.0, metadata["lastAttemptAtMs"])
    assertEquals("success", metadata["lastOutcome"])
    assertEquals(1.0, metadata["failedAttemptCount"])
  }

  @Test
  fun failedAttemptCounterSaturatesAtSafeInteger() {
    val preferences = fakePreferences()
    preferences.edit().putLong(FAILED_ATTEMPT_COUNT, MAX_SAFE_INTEGER).commit()

    recordSmsWakeOutcome(preferences, SmsWakeOutcome.FAILED, failedAttempt = true, nowMs = NOW)

    assertEquals(MAX_SAFE_INTEGER.toDouble(), readSmsWakeMetadata(preferences)["failedAttemptCount"])
  }

  private fun fakePreferences(commitResult: Boolean = true): SharedPreferences {
    val values = mutableMapOf<String, Any>()

    fun newEditor(): SharedPreferences.Editor {
      lateinit var editor: SharedPreferences.Editor
      val pending = mutableMapOf<String, Any>()
      val removed = mutableSetOf<String>()
      var clear = false
      fun save(): Boolean {
        if (clear) values.clear()
        removed.forEach(values::remove)
        values.putAll(pending)
        return commitResult
      }
      editor = Proxy.newProxyInstance(
        SharedPreferences.Editor::class.java.classLoader ?: ClassLoader.getSystemClassLoader(),
        arrayOf(SharedPreferences.Editor::class.java)
      ) { proxy, method, args ->
        val key = args?.firstOrNull() as? String
        when (method.name) {
          "putBoolean", "putLong", "putInt", "putString" -> {
            pending[key!!] = args[1]!!
            removed.remove(key)
            proxy
          }
          "remove" -> {
            removed += key!!
            pending.remove(key)
            proxy
          }
          "clear" -> { clear = true; proxy }
          "commit" -> save()
          "apply" -> { save(); null }
          else -> throw AssertionError("Unexpected SharedPreferences.Editor call: ${method.name}")
        }
      } as SharedPreferences.Editor
      return editor
    }

    return Proxy.newProxyInstance(
      SharedPreferences::class.java.classLoader ?: ClassLoader.getSystemClassLoader(),
      arrayOf(SharedPreferences::class.java)
    ) { proxy, method, args ->
      when (method.name) {
        "contains" -> values.containsKey(args?.firstOrNull() as String)
        "getBoolean" -> values[args!![0] as String]?.let { it as Boolean } ?: args[1] as Boolean
        "getLong" -> values[args!![0] as String]?.let { it as Long } ?: args[1] as Long
        "getInt" -> values[args!![0] as String]?.let { it as Int } ?: args[1] as Int
        "getString" -> values[args!![0] as String]?.let { it as String } ?: args[1] as String?
        "getAll" -> values.toMap()
        "edit" -> newEditor()
        "toString" -> "FakeSharedPreferences"
        "hashCode" -> System.identityHashCode(proxy)
        "equals" -> proxy === args?.firstOrNull()
        else -> throw AssertionError("Unexpected SharedPreferences call: ${method.name}")
      }
    } as SharedPreferences
  }

  companion object {
    private const val NOW = 1_700_000_000_000L
  }
}
