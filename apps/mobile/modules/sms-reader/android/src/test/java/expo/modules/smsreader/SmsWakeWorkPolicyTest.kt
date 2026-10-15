package expo.modules.smsreader

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SmsWakeWorkPolicyTest {
  @Test
  fun workRequiresPersistedConsentAndBothSmsPermissions() {
    val settings = SmsImportSettings(enabled = true, startDateMs = NOW - 1)

    assertTrue(canRunSmsCatchup(settings, hasReadSms = true, hasReceiveSms = true, nowMs = NOW))
    assertFalse(canRunSmsCatchup(settings, hasReadSms = false, hasReceiveSms = true, nowMs = NOW))
    assertFalse(canRunSmsCatchup(settings, hasReadSms = true, hasReceiveSms = false, nowMs = NOW))
    assertFalse(canRunSmsCatchup(settings.copy(enabled = false), hasReadSms = true, hasReceiveSms = true, nowMs = NOW))
    assertFalse(canRunSmsCatchup(settings.copy(startDateMs = null), hasReadSms = true, hasReceiveSms = true, nowMs = NOW))
    assertFalse(canRunSmsCatchup(settings.copy(startDateMs = NOW + 1), hasReadSms = true, hasReceiveSms = true, nowMs = NOW))
    assertFalse(canRunSmsCatchup(settings.copy(startDateMs = MAX_SAFE_INTEGER + 1), hasReadSms = true, hasReceiveSms = true, nowMs = NOW))
  }

  @Test
  fun retryBudgetIsBoundedToThreeAttempts() {
    assertTrue(shouldRetrySmsCatchup(runAttemptCount = 0))
    assertTrue(shouldRetrySmsCatchup(runAttemptCount = 1))
    assertFalse(shouldRetrySmsCatchup(runAttemptCount = 2))
    assertFalse(shouldRetrySmsCatchup(runAttemptCount = 3))
  }

  @Test
  fun onlyANumericSuccessResultWithAnEventIdCompletesTheTaskSuccessfully() {
    assertTrue(isSuccessfulSmsCatchupResponse(mapOf("eventId" to "event", "result" to 1)))
    assertTrue(isSuccessfulSmsCatchupResponse(mapOf("eventId" to "event", "result" to 1.0)))
    assertFalse(isSuccessfulSmsCatchupResponse(mapOf("eventId" to "event", "result" to "1")))
    assertFalse(isSuccessfulSmsCatchupResponse(mapOf("eventId" to "event", "result" to true)))
    assertFalse(isSuccessfulSmsCatchupResponse(mapOf("eventId" to "", "result" to 1)))
    assertFalse(isSuccessfulSmsCatchupResponse(mapOf("result" to 1)))
    assertFalse(isSuccessfulSmsCatchupResponse(emptyMap()))
  }

  companion object {
    private const val NOW = 1_700_000_000_000L
  }
}
