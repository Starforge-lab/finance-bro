package expo.modules.smsreader

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import expo.modules.interfaces.taskManager.TaskConsumer
import expo.modules.interfaces.taskManager.TaskExecutionCallback
import expo.modules.interfaces.taskManager.TaskInterface
import expo.modules.interfaces.taskManager.TaskManagerUtilsInterface
import expo.modules.interfaces.taskManager.TaskServiceProviderHelper
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

internal const val SMS_WAKE_TASK_NAME = "finance-bro-android-sms-wake"
internal const val SMS_WAKE_WORK_NAME = "finance-bro-android-sms-wake"
private const val JS_TASK_SUCCESS = 1.0
private const val MAX_ATTEMPTS = 3
private const val TASK_TIMEOUT_MS = 8 * 60 * 1000L

class SmsCatchupWakeTaskConsumer(context: Context, taskManagerUtils: TaskManagerUtilsInterface) :
  TaskConsumer(context, taskManagerUtils) {

  private var task: TaskInterface? = null

  override fun taskType(): String = "finance-bro-sms-catchup-wake"

  override fun didRegister(task: TaskInterface) {
    this.task = task
  }

  override fun didUnregister() {
    task = null
  }

  fun executeTask(callback: TaskExecutionCallback) {
    val registeredTask = task ?: throw IllegalStateException("SMS wake task is not registered")
    registeredTask.execute(Bundle(), null, callback)
  }

  companion object {
    @JvmField
    val VERSION = 0
  }
}

internal object SmsCatchupWakeWork {
  fun enqueue(context: Context) {
    val request = OneTimeWorkRequestBuilder<SmsCatchupWakeWorker>()
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
      .build()
    WorkManager.getInstance(context).enqueueUniqueWork(
      SMS_WAKE_WORK_NAME,
      ExistingWorkPolicy.APPEND_OR_REPLACE,
      request
    )
  }

  fun cancel(context: Context) {
    WorkManager.getInstance(context).cancelUniqueWork(SMS_WAKE_WORK_NAME)
  }
}

class SmsCatchupWakeWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
  override suspend fun doWork(): Result {
    val context = applicationContext
    recordSmsWakeOutcome(context.smsWakePreferences(), SmsWakeOutcome.DEFERRED, failedAttempt = false)
    if (!isEligible(context)) return finish(SmsWakeOutcome.DEFERRED, failedAttempt = false)

    return try {
      val taskService = TaskServiceProviderHelper.getTaskServiceImpl(context)
        ?: return finishFailure(context)
      val consumer = taskService.getTaskConsumers(context.packageName)
        .filterIsInstance<SmsCatchupWakeTaskConsumer>()
        .singleOrNull()
        ?: return finishFailure(context)

      val success = withTimeoutOrNull(TASK_TIMEOUT_MS) { awaitTaskSuccess(consumer) } ?: false
      if (success) {
        finish(SmsWakeOutcome.SUCCESS, failedAttempt = false)
      } else {
        finishFailure(context)
      }
    } catch (cancelled: CancellationException) {
      finish(SmsWakeOutcome.DEFERRED, failedAttempt = false)
      throw cancelled
    } catch (_: Exception) {
      finishFailure(context)
    }
  }

  @OptIn(ExperimentalCoroutinesApi::class)
  private suspend fun awaitTaskSuccess(consumer: SmsCatchupWakeTaskConsumer): Boolean =
    suspendCancellableCoroutine { continuation ->
      consumer.executeTask(TaskExecutionCallback { response ->
        continuation.tryResume(isSuccessfulSmsCatchupResponse(response))?.let(continuation::completeResume)
      })
    }

  private fun finishFailure(context: Context): Result {
    if (!isEligible(context)) return finish(SmsWakeOutcome.DEFERRED, failedAttempt = false)
    val willRetry = shouldRetrySmsCatchup(runAttemptCount)
    val outcome = if (willRetry) SmsWakeOutcome.DEFERRED else SmsWakeOutcome.FAILED
    finish(outcome, failedAttempt = true)

    // Keep later receiver wakes in an APPEND_OR_REPLACE chain runnable after this bounded attempt.
    return if (willRetry) Result.retry() else Result.success()
  }

  private fun finish(outcome: SmsWakeOutcome, failedAttempt: Boolean): Result {
    recordSmsWakeOutcome(applicationContext.smsWakePreferences(), outcome, failedAttempt)
    return Result.success()
  }

  private fun isEligible(context: Context): Boolean {
    val settings = readImportSettings(context.smsImportSettingsPreferences())
    return canRunSmsCatchup(
      settings,
      hasReadSms = context.checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED,
      hasReceiveSms = context.checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED,
      nowMs = System.currentTimeMillis()
    )
  }
}

internal fun canRunSmsCatchup(
  settings: SmsImportSettings,
  hasReadSms: Boolean,
  hasReceiveSms: Boolean,
  nowMs: Long
): Boolean {
  val startDateMs = settings.startDateMs
  return settings.enabled && hasReadSms && hasReceiveSms && startDateMs != null &&
    startDateMs in 1L..MAX_SAFE_INTEGER && startDateMs <= nowMs
}

internal fun shouldRetrySmsCatchup(runAttemptCount: Int): Boolean = runAttemptCount < MAX_ATTEMPTS - 1

internal fun isSuccessfulSmsCatchupResponse(response: Map<String, *>): Boolean {
  val eventId = response["eventId"] as? String
  val result = response["result"] as? Number
  return !eventId.isNullOrEmpty() && result?.toDouble() == JS_TASK_SUCCESS
}
