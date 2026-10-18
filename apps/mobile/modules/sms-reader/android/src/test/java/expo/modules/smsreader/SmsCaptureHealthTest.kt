package expo.modules.smsreader

import android.content.SharedPreferences
import java.lang.reflect.Proxy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class SmsCaptureHealthTest {
  @Test
  fun beginRequiresPersistedConsentAndDoesNotTouchWakeMetadata() {
    val settings = fakePreferences()
    val wake = fakePreferences()
    wake.preferences.edit()
      .putLong(EVENT_COUNT, 7L)
      .putLong(LAST_RECEIVED_AT_MS, NOW - 3)
      .putLong(FAILED_ATTEMPT_COUNT, 2L)
      .commit()

    assertNull(beginSmsCaptureAttempt(settings.preferences, wake.preferences, NOW))
    enable(settings.preferences)
    assertEquals(1L, beginSmsCaptureAttempt(settings.preferences, wake.preferences, NOW))

    val metadata = readSmsWakeMetadata(wake.preferences)
    assertEquals(7.0, metadata["count"])
    assertEquals(NOW - 3.0, metadata["lastReceivedAtMs"])
    assertEquals(2.0, metadata["failedAttemptCount"])
    assertEquals(0.0, metadata["captureFailedCount"])
  }

  @Test
  fun onlyLatestPendingAttemptCanFinishAndAcceptedFailuresAreCountedOnce() {
    val (settings, wake) = enabledPair()
    assertEquals(1L, beginSmsCaptureAttempt(settings, wake, NOW))
    assertEquals(2L, beginSmsCaptureAttempt(settings, wake, NOW + 1))

    finishSmsCaptureAttempt(settings, wake, 1.0, "failed", "storage_unavailable", NOW + 2)
    assertEquals(0.0, readSmsCaptureHealthMetadata(wake)["captureFailedCount"])
    finishSmsCaptureAttempt(settings, wake, 2.0, "failed", "storage_unavailable", NOW + 3)
    finishSmsCaptureAttempt(settings, wake, 2.0, "failed", "storage_unavailable", NOW + 4)

    val metadata = readSmsCaptureHealthMetadata(wake)
    assertEquals(1.0, metadata["captureFailedCount"])
    assertEquals("storage_unavailable", metadata["currentFailureCode"])
    assertEquals(NOW + 3.0, metadata["currentFailureAtMs"])
  }

  @Test
  fun unavailableAndFailedCodesAreCategorizedAndConsentOffIgnoresFinishes() {
    val (settings, wake) = enabledPair()
    val revision = beginSmsCaptureAttempt(settings, wake, NOW)!!
    finishSmsCaptureAttempt(settings, wake, revision.toDouble(), "unavailable", "permission_denied", NOW + 1)
    assertEquals(1.0, readSmsCaptureHealthMetadata(wake)["captureUnavailableCount"])

    val next = beginSmsCaptureAttempt(settings, wake, NOW + 2)!!
    assertEquals("permission_denied", readSmsCaptureHealthMetadata(wake)["currentFailureCode"])
    setImportSettings(settings, mapOf("enabled" to false), NOW + 3)
    finishSmsCaptureAttempt(settings, wake, next.toDouble(), "failed", "unexpected", NOW + 4)
    val metadata = readSmsCaptureHealthMetadata(wake)
    assertEquals(0.0, metadata["captureFailedCount"])
    assertEquals("permission_denied", metadata["currentFailureCode"])
    assertEquals(NOW + 1.0, metadata["currentFailureAtMs"])
  }

  @Test
  fun cancellationPreservesFailureAndOnlySuccessClearsIt() {
    val (settings, wake) = enabledPair()
    val failed = beginSmsCaptureAttempt(settings, wake, NOW)!!
    finishSmsCaptureAttempt(settings, wake, failed.toDouble(), "failed", "invalid_clock", NOW + 1)

    val cancelled = beginSmsCaptureAttempt(settings, wake, NOW + 2)!!
    finishSmsCaptureAttempt(settings, wake, cancelled.toDouble(), "cancelled", null, NOW + 3)
    assertEquals("invalid_clock", readSmsCaptureHealthMetadata(wake)["currentFailureCode"])
    assertEquals(NOW + 1.0, readSmsCaptureHealthMetadata(wake)["currentFailureAtMs"])

    val successful = beginSmsCaptureAttempt(settings, wake, NOW + 4)!!
    finishSmsCaptureAttempt(settings, wake, successful.toDouble(), "success", null, NOW + 5)
    val metadata = readSmsCaptureHealthMetadata(wake)
    assertNull(metadata["currentFailureCode"])
    assertNull(metadata["currentFailureAtMs"])
    assertEquals(1.0, metadata["captureFailedCount"])
  }

  @Test
  fun validatesRevisionsOutcomesAndFailureCodeCategories() {
    listOf(Double.NaN, Double.POSITIVE_INFINITY, 0.0, -1.0, 1.5, MAX_SAFE_INTEGER.toDouble() + 1.0)
      .forEach { revision -> assertThrows(IllegalArgumentException::class.java) { parseCaptureRevision(revision) } }

    val (settings, wake) = enabledPair()
    val revision = beginSmsCaptureAttempt(settings, wake, NOW)!!
    assertThrows(IllegalArgumentException::class.java) {
      finishSmsCaptureAttempt(settings, wake, revision.toDouble(), "failed", "permission_denied", NOW + 1)
    }
    assertThrows(IllegalArgumentException::class.java) {
      finishSmsCaptureAttempt(settings, wake, revision.toDouble(), "unavailable", "stale_cursor", NOW + 1)
    }
    assertThrows(IllegalArgumentException::class.java) {
      finishSmsCaptureAttempt(settings, wake, revision.toDouble(), "success", "unexpected", NOW + 1)
    }
    assertThrows(IllegalArgumentException::class.java) {
      finishSmsCaptureAttempt(settings, wake, revision.toDouble(), "unavailable", "permission_denied", 0L)
    }
    assertEquals(0.0, readSmsCaptureHealthMetadata(wake)["captureFailedCount"])
    assertEquals(0.0, readSmsCaptureHealthMetadata(wake)["captureUnavailableCount"])
  }

  @Test
  fun countersSaturateAndRevisionExhaustionFailsClosed() {
    val (settings, wake) = enabledPair()
    wake.edit()
      .putLong("captureFailedCount", MAX_SAFE_INTEGER)
      .commit()
    val revision = beginSmsCaptureAttempt(settings, wake, NOW)!!
    finishSmsCaptureAttempt(settings, wake, revision.toDouble(), "failed", "unexpected", NOW + 1)
    val metadata = readSmsCaptureHealthMetadata(wake)
    assertEquals(MAX_SAFE_INTEGER.toDouble(), metadata["captureFailedCount"])

    wake.edit().putLong("captureRevision", MAX_SAFE_INTEGER).commit()
    assertThrows(IllegalStateException::class.java) {
      beginSmsCaptureAttempt(settings, wake, NOW + 2)
    }
    assertEquals(MAX_SAFE_INTEGER.toDouble(), readSmsCaptureHealthMetadata(wake)["captureFailedCount"])
  }

  @Test
  fun unknownPersistedCodeIsNotExposed() {
    val wake = fakePreferences()
    wake.preferences.edit().putString("currentFailureCode", "unknown_code")
      .putLong("currentFailureAtMs", NOW).commit()

    val metadata = readSmsCaptureHealthMetadata(wake.preferences)
    assertNull(metadata["currentFailureCode"])
    assertNull(metadata["currentFailureAtMs"])
  }

  @Test
  fun failedPreferenceCommitDoesNotClaimBeginOrFinishAndCanRetry() {
    val settings = fakePreferences()
    val wake = fakePreferences()
    enable(settings.preferences)
    wake.commitResults.addAll(listOf(false, true))
    assertThrows(IllegalStateException::class.java) {
      beginSmsCaptureAttempt(settings.preferences, wake.preferences, NOW)
    }

    val revision = beginSmsCaptureAttempt(settings.preferences, wake.preferences, NOW)!!
    wake.commitResults.addAll(listOf(false, true))
    assertThrows(IllegalStateException::class.java) {
      finishSmsCaptureAttempt(settings.preferences, wake.preferences, revision.toDouble(), "failed", "unexpected", NOW + 1)
    }
    assertEquals(0.0, readSmsCaptureHealthMetadata(wake.preferences)["captureFailedCount"])
    finishSmsCaptureAttempt(settings.preferences, wake.preferences, revision.toDouble(), "failed", "unexpected", NOW + 2)
    assertEquals(1.0, readSmsCaptureHealthMetadata(wake.preferences)["captureFailedCount"])
  }

  @Test
  fun malformedPersistedConsentDoesNotStartAnAttempt() {
    val settings = fakePreferences()
    val wake = fakePreferences()
    settings.preferences.edit().putBoolean("enabled", true).putLong("startDateMs", 0L).commit()

    assertFalse(readImportSettings(settings.preferences, NOW).enabled)
    assertNull(beginSmsCaptureAttempt(settings.preferences, wake.preferences, NOW))
  }

  private fun enabledPair(): Pair<SharedPreferences, SharedPreferences> {
    val settings = fakePreferences()
    val wake = fakePreferences()
    enable(settings.preferences)
    return settings.preferences to wake.preferences
  }

  private fun enable(settings: SharedPreferences) {
    setImportSettings(
      settings,
      mapOf("enabled" to true, "startDateMs" to NOW - MAX_RANGE_MS, "previewEndDateMs" to NOW),
      NOW
    )
  }

  private data class PreferenceFixture(
    val preferences: SharedPreferences,
    val commitResults: MutableList<Boolean>
  )

  private fun fakePreferences(): PreferenceFixture {
    val values = mutableMapOf<String, Any>()
    val commitResults = mutableListOf<Boolean>()

    fun newEditor(): SharedPreferences.Editor {
      val pending = mutableMapOf<String, Any>()
      val removed = mutableSetOf<String>()
      var clear = false
      fun save(): Boolean {
        if (clear) values.clear()
        removed.forEach(values::remove)
        values.putAll(pending)
        return if (commitResults.isEmpty()) true else commitResults.removeAt(0)
      }
      return Proxy.newProxyInstance(
        SharedPreferences.Editor::class.java.classLoader ?: ClassLoader.getSystemClassLoader(),
        arrayOf(SharedPreferences.Editor::class.java)
      ) { proxy, method, args ->
        val key = args?.firstOrNull() as? String
        when (method.name) {
          "putBoolean", "putLong", "putInt" -> {
            pending[key!!] = args[1]!!
            removed.remove(key)
            proxy
          }
          "putString" -> {
            if (args!![1] == null) {
              removed.add(key!!)
              pending.remove(key)
            } else {
              pending[key!!] = args[1]!!
              removed.remove(key)
            }
            proxy
          }
          "remove" -> {
            removed.add(key!!)
            pending.remove(key)
            proxy
          }
          "clear" -> { clear = true; proxy }
          "commit" -> save()
          "apply" -> { save(); null }
          else -> throw AssertionError("Unexpected SharedPreferences.Editor call: ${method.name}")
        }
      } as SharedPreferences.Editor
    }

    val preferences = Proxy.newProxyInstance(
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
    return PreferenceFixture(preferences, commitResults)
  }

  companion object {
    private const val NOW = 1_700_000_000_000L
  }
}
