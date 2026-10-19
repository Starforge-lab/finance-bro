package expo.modules.smsreader

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

class SmsWakeReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
    SmsCatchupWakeWork.enqueue(context.applicationContext, intent.action, goAsync())
  }
}

internal fun scheduleSmsCatchupIfEnabled(
  action: String?,
  readImportEnabled: () -> Boolean,
  scheduleWake: () -> Unit
): Boolean {
  if (action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION || !readImportEnabled()) return false
  scheduleWake()
  return true
}
