package expo.modules.smsreader

import org.junit.Assert.assertEquals
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
  fun unpersistedOutcomeNeverContinuesAsSuccessAndFailsAfterTheRetryBudget() {
    assertEquals(SmsWakeOutcomeWriteDecision.CONTINUE, decideSmsWakeOutcomeWrite(persisted = true, runAttemptCount = 0))
    assertEquals(SmsWakeOutcomeWriteDecision.RETRY, decideSmsWakeOutcomeWrite(persisted = false, runAttemptCount = 0))
    assertEquals(SmsWakeOutcomeWriteDecision.RETRY, decideSmsWakeOutcomeWrite(persisted = false, runAttemptCount = 1))
    assertEquals(SmsWakeOutcomeWriteDecision.FAIL, decideSmsWakeOutcomeWrite(persisted = false, runAttemptCount = 2))
  }

  @Test
  fun receiverWakeQueueAllowsOnlyOneTrailingPass() {
    assertEquals(SmsWakeEnqueueDecision.ENQUEUE, decideSmsWakeEnqueue(emptyList()))
    assertEquals(
      SmsWakeEnqueueDecision.ENQUEUE,
      decideSmsWakeEnqueue(listOf(SmsWakeWorkChainState.TERMINAL))
    )
    assertEquals(
      SmsWakeEnqueueDecision.APPEND_TRAILING,
      decideSmsWakeEnqueue(listOf(SmsWakeWorkChainState.RUNNING))
    )
    assertEquals(
      SmsWakeEnqueueDecision.COALESCE,
      decideSmsWakeEnqueue(listOf(SmsWakeWorkChainState.RUNNING, SmsWakeWorkChainState.QUEUED))
    )
    assertEquals(
      SmsWakeEnqueueDecision.COALESCE,
      decideSmsWakeEnqueue(listOf(SmsWakeWorkChainState.QUEUED))
    )
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
