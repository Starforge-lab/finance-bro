package expo.modules.smsreader

import android.content.SharedPreferences
import java.lang.reflect.Proxy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
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
  fun disabledReceiverDoesNotReadPduParts() {
    var decoded = false

    assertNull(readPartCountIfImportEnabled(enabled = false) { decoded = true; 1 })
    assertFalse(decoded)
    assertEquals(1L, readPartCountIfImportEnabled(enabled = true) { 1 }?.toLong() ?: 0L)
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
          "putBoolean", "putLong" -> {
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
