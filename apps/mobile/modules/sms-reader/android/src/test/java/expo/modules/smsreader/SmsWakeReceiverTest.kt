package expo.modules.smsreader

import android.provider.Telephony
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SmsWakeReceiverTest {
  @Test
  fun unrelatedBroadcastDoesNotReadConsentOrScheduleWork() {
    var consentRead = false
    var scheduled = false

    val handled = scheduleSmsCatchupIfEnabled(
      "unrelated.broadcast",
      { consentRead = true; true },
      { scheduled = true }
    )

    assertFalse(handled)
    assertFalse(consentRead)
    assertFalse(scheduled)
  }

  @Test
  fun disabledConsentDoesNotScheduleWork() {
    var scheduled = false

    val handled = scheduleSmsCatchupIfEnabled(
      Telephony.Sms.Intents.SMS_RECEIVED_ACTION,
      { false },
      { scheduled = true }
    )

    assertFalse(handled)
    assertFalse(scheduled)
  }

  @Test
  fun persistedConsentSchedulesOneBodyFreeWake() {
    var consentReads = 0
    var schedules = 0

    val handled = scheduleSmsCatchupIfEnabled(
      Telephony.Sms.Intents.SMS_RECEIVED_ACTION,
      { consentReads++; true },
      { schedules++ }
    )

    assertTrue(handled)
    assertEquals(1, consentReads)
    assertEquals(1, schedules)
  }
}
