package expo.modules.smsreader

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.SystemClock
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import expo.modules.core.interfaces.DoNotStrip
import expo.modules.interfaces.taskManager.TaskConsumer
import expo.modules.interfaces.taskManager.TaskExecutionCallback
import expo.modules.interfaces.taskManager.TaskInterface
import expo.modules.interfaces.taskManager.TaskManagerUtilsInterface
import expo.modules.interfaces.taskManager.TaskServiceProviderHelper
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

internal const val SMS_WAKE_TASK_NAME = "finance-bro-android-sms-wake"
internal const val SMS_WAKE_WORK_NAME = "finance-bro-android-sms-wake"
private const val JS_TASK_SUCCESS = 1.0
private const val MAX_ATTEMPTS = 3
private const val JS_TASK_BUDGET_MS = 7 * 60 * 1000L
private const val TASK_TIMEOUT_MS = 8 * 60 * 1000L
private const val WORK_QUERY_TIMEOUT_MS = 2_000L
private const val SCHEDULING_LOCK_TIMEOUT_MS = 1_500L
private const val WAKE_DEADLINE_KEY = "deadlineElapsedRealtimeMs"

// Expo persists this class name and reconstructs its consumer through reflection after process restart.
@DoNotStrip
class SmsCatchupWakeTaskConsumer @DoNotStrip constructor(context: Context, taskManagerUtils: TaskManagerUtilsInterface) :
  TaskConsumer(context, taskManagerUtils) {

  private var task: TaskInterface? = null

  override fun taskType(): String = "finance-bro-sms-catchup-wake"

  override fun didRegister(task: TaskInterface) {
    this.task = task
  }

  override fun didUnregister() {
    task = null
  }

  fun executeTask(deadlineElapsedRealtimeMs: Long, callback: TaskExecutionCallback) {
    val registeredTask = task ?: throw IllegalStateException("SMS wake task is not registered")
    val data = Bundle().apply { putLong(WAKE_DEADLINE_KEY, deadlineElapsedRealtimeMs) }
    registeredTask.execute(data, null, callback)
  }

  companion object {
    @field:DoNotStrip
    @JvmField
    val VERSION = 0
  }
}

internal object SmsCatchupWakeWork {
  private val receiverScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val schedulingLock = ReentrantLock()

  fun enqueue(context: Context, action: String?, pendingResult: BroadcastReceiver.PendingResult) {
    receiverScope.launch {
      try {
        scheduleSmsCatchupIfEnabled(
          action,
          { readImportSettings(context.smsImportSettingsPreferences()).enabled },
          {
            runCatching { recordSmsWakeReceived(context.smsWakePreferences()) }
            enqueueBounded(context)
          }
        )
      } catch (_: Exception) {
        recordSmsWakeOutcome(context.smsWakePreferences(), SmsWakeOutcome.DEFERRED, failedAttempt = true)
      } finally {
        runCatching { pendingResult.finish() }
      }
    }
  }

  private fun enqueueBounded(context: Context) {
    if (!schedulingLock.tryLock(SCHEDULING_LOCK_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
      throw TimeoutException("SMS wake scheduling lock timed out")
    }
    try {
      val workManager = WorkManager.getInstance(context)
      val states = workManager.getWorkInfosForUniqueWork(SMS_WAKE_WORK_NAME)
        .get(WORK_QUERY_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .map { it.state.toSmsWakeWorkChainState() }
      when (decideSmsWakeEnqueue(states)) {
        SmsWakeEnqueueDecision.COALESCE -> return
        SmsWakeEnqueueDecision.ENQUEUE, SmsWakeEnqueueDecision.APPEND_TRAILING -> {
          val request = OneTimeWorkRequestBuilder<SmsCatchupWakeWorker>()
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
          workManager.enqueueUniqueWork(
            SMS_WAKE_WORK_NAME,
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            request
          // Keep the process lock until WorkManager has published the chain entry.
          ).result.get(WORK_QUERY_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        }
      }
    } finally {
      schedulingLock.unlock()
    }
  }

  fun cancel(context: Context) {
    WorkManager.getInstance(context).cancelUniqueWork(SMS_WAKE_WORK_NAME)
  }
}

internal enum class SmsWakeWorkChainState { RUNNING, QUEUED, TERMINAL }
internal enum class SmsWakeEnqueueDecision { ENQUEUE, APPEND_TRAILING, COALESCE }

internal fun decideSmsWakeEnqueue(states: Iterable<SmsWakeWorkChainState>): SmsWakeEnqueueDecision = when {
  states.any { it == SmsWakeWorkChainState.QUEUED } -> SmsWakeEnqueueDecision.COALESCE
  states.any { it == SmsWakeWorkChainState.RUNNING } -> SmsWakeEnqueueDecision.APPEND_TRAILING
  else -> SmsWakeEnqueueDecision.ENQUEUE
}

private fun WorkInfo.State.toSmsWakeWorkChainState(): SmsWakeWorkChainState = when (this) {
  WorkInfo.State.ENQUEUED, WorkInfo.State.BLOCKED -> SmsWakeWorkChainState.QUEUED
  WorkInfo.State.RUNNING -> SmsWakeWorkChainState.RUNNING
  else -> SmsWakeWorkChainState.TERMINAL
}

class SmsCatchupWakeWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
  override suspend fun doWork(): Result {
    val context = applicationContext
    val metadataDecision = decideSmsWakeOutcomeWrite(
      persisted = recordSmsWakeOutcome(context.smsWakePreferences(), SmsWakeOutcome.DEFERRED, failedAttempt = false),
      runAttemptCount = runAttemptCount
    )
    if (metadataDecision != SmsWakeOutcomeWriteDecision.CONTINUE) {
      return when (metadataDecision) {
        SmsWakeOutcomeWriteDecision.CONTINUE -> error("A persisted outcome is not a metadata write failure")
        SmsWakeOutcomeWriteDecision.RETRY -> Result.retry()
        SmsWakeOutcomeWriteDecision.FAIL -> Result.failure()
      }
    }
    if (!isEligible(context)) return Result.success()

    return try {
      val taskService = TaskServiceProviderHelper.getTaskServiceImpl(context)
        ?: return finishFailure(context)
      val consumer = taskService.getTaskConsumers(context.packageName)
        .filterIsInstance<SmsCatchupWakeTaskConsumer>()
        .singleOrNull()
        ?: return finishFailure(context)

      val deadlineElapsedRealtimeMs = SystemClock.elapsedRealtime() + JS_TASK_BUDGET_MS
      val success = withTimeoutOrNull(TASK_TIMEOUT_MS) {
        awaitTaskSuccess(consumer, deadlineElapsedRealtimeMs)
      } ?: false
      if (success) {
        finish(SmsWakeOutcome.SUCCESS, failedAttempt = false)
      } else {
        finishFailure(context)
      }
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: Exception) {
      finishFailure(context)
    }
  }

  private suspend fun awaitTaskSuccess(
    consumer: SmsCatchupWakeTaskConsumer,
    deadlineElapsedRealtimeMs: Long
  ): Boolean =
    suspendCancellableCoroutine { continuation ->
      val callbackResumed = AtomicBoolean(false)
      consumer.executeTask(deadlineElapsedRealtimeMs, TaskExecutionCallback { response ->
        if (callbackResumed.compareAndSet(false, true)) {
          continuation.resume(isSuccessfulSmsCatchupResponse(response))
        }
      })
    }

  private fun finishFailure(context: Context): Result {
    if (!isEligible(context)) return finish(SmsWakeOutcome.DEFERRED, failedAttempt = false)
    val willRetry = shouldRetrySmsCatchup(runAttemptCount)
    val outcome = if (willRetry) SmsWakeOutcome.DEFERRED else SmsWakeOutcome.FAILED
    val decision = decideSmsWakeOutcomeWrite(
      persisted = recordSmsWakeOutcome(applicationContext.smsWakePreferences(), outcome, failedAttempt = true),
      runAttemptCount = runAttemptCount
    )

    // Keep later receiver wakes in an APPEND_OR_REPLACE chain runnable after this bounded attempt.
    return when (decision) {
      SmsWakeOutcomeWriteDecision.CONTINUE -> if (willRetry) Result.retry() else Result.success()
      SmsWakeOutcomeWriteDecision.RETRY -> Result.retry()
      SmsWakeOutcomeWriteDecision.FAIL -> Result.failure()
    }
  }

  private fun finish(outcome: SmsWakeOutcome, failedAttempt: Boolean): Result {
    val decision = decideSmsWakeOutcomeWrite(
      persisted = recordSmsWakeOutcome(applicationContext.smsWakePreferences(), outcome, failedAttempt),
      runAttemptCount = runAttemptCount
    )
    return when (decision) {
      SmsWakeOutcomeWriteDecision.CONTINUE -> Result.success()
      SmsWakeOutcomeWriteDecision.RETRY -> Result.retry()
      SmsWakeOutcomeWriteDecision.FAIL -> Result.failure()
    }
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

internal enum class SmsWakeOutcomeWriteDecision { CONTINUE, RETRY, FAIL }

internal fun decideSmsWakeOutcomeWrite(persisted: Boolean, runAttemptCount: Int): SmsWakeOutcomeWriteDecision = when {
  persisted -> SmsWakeOutcomeWriteDecision.CONTINUE
  shouldRetrySmsCatchup(runAttemptCount) -> SmsWakeOutcomeWriteDecision.RETRY
  else -> SmsWakeOutcomeWriteDecision.FAIL
}

internal fun isSuccessfulSmsCatchupResponse(response: Map<String, *>): Boolean {
  val eventId = response["eventId"] as? String
  val result = response["result"] as? Number
  return !eventId.isNullOrEmpty() && result?.toDouble() == JS_TASK_SUCCESS
}
