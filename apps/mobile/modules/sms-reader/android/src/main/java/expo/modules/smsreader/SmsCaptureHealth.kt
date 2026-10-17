package expo.modules.smsreader

import android.content.SharedPreferences

private const val CAPTURE_REVISION = "captureRevision"
private const val CAPTURE_PENDING_REVISION = "capturePendingRevision"
private const val CAPTURE_FINISHED_REVISION = "captureFinishedRevision"
private const val CAPTURE_FAILED_COUNT = "captureFailedCount"
private const val CAPTURE_UNAVAILABLE_COUNT = "captureUnavailableCount"
private const val CAPTURE_FAILURE_CODE = "currentFailureCode"
private const val CAPTURE_FAILURE_AT_MS = "currentFailureAtMs"

private val unavailableCaptureCodes = setOf(
  "permission_denied",
  "permission_unavailable",
  "invalid_consent",
  "source_unavailable",
  "key_unavailable",
  "duplicate_review_required",
  "background_unavailable"
)
private val failedCaptureCodes = setOf(
  "invalid_source_page",
  "stale_cursor",
  "storage_unavailable",
  "invalid_clock",
  "time_budget_exceeded",
  "unexpected"
)
private val allCaptureCodes = unavailableCaptureCodes + failedCaptureCodes

private data class CaptureHealthState(
  val revision: Long,
  val pendingRevision: Long,
  val finishedRevision: Long,
  val failedCount: Long,
  val unavailableCount: Long,
  val failureCode: String?,
  val failureAtMs: Long?
)

/** Begin a consented capture attempt without inferring an outcome for any superseded pending attempt. */
internal fun beginSmsCaptureAttempt(
  settingsPreferences: SharedPreferences,
  wakePreferences: SharedPreferences,
  nowMs: Long = System.currentTimeMillis()
): Long? = synchronized(settingsPreferences) {
  val settings = readImportSettings(settingsPreferences, nowMs)
  if (!settings.enabled) return@synchronized null
  val startDateMs = settings.startDateMs
  check(startDateMs != null && startDateMs in 1L..MAX_SAFE_INTEGER && startDateMs <= nowMs) {
    "SMS capture requires valid persisted consent"
  }

  synchronized(wakePreferences) {
    val before = readCaptureHealthState(wakePreferences)
    check(before.revision < MAX_SAFE_INTEGER) { "SMS capture revision exhausted" }
    val revision = before.revision + 1
    val after = before.copy(
      revision = revision,
      pendingRevision = revision
    )
    persistCaptureHealthState(wakePreferences, before, after)
    revision
  }
}

/** Finish only the latest pending attempt while consent is still enabled. */
internal fun finishSmsCaptureAttempt(
  settingsPreferences: SharedPreferences,
  wakePreferences: SharedPreferences,
  revisionValue: Double,
  outcomeValue: String,
  code: String?,
  nowMs: Long = System.currentTimeMillis()
) {
  val revision = parseCaptureRevision(revisionValue)
  val outcome = parseCaptureOutcome(outcomeValue, code)
  if (outcome == CaptureOutcome.FAILED || outcome == CaptureOutcome.UNAVAILABLE) {
    require(nowMs in 1L..MAX_SAFE_INTEGER) { "SMS capture failure time must be a safe timestamp" }
  }

  synchronized(settingsPreferences) {
    if (!readImportSettings(settingsPreferences, nowMs).enabled) return
    synchronized(wakePreferences) {
      val before = readCaptureHealthState(wakePreferences)
      if (before.pendingRevision != revision || revision <= before.finishedRevision) return

      val after = when (outcome) {
        CaptureOutcome.SUCCESS -> before.copy(
          pendingRevision = 0L,
          finishedRevision = revision,
          failureCode = null,
          failureAtMs = null
        )
        CaptureOutcome.FAILED -> before.copy(
          pendingRevision = 0L,
          finishedRevision = revision,
          failedCount = saturatingIncrement(before.failedCount),
          failureCode = code,
          failureAtMs = nowMs
        )
        CaptureOutcome.UNAVAILABLE -> before.copy(
          pendingRevision = 0L,
          finishedRevision = revision,
          unavailableCount = saturatingIncrement(before.unavailableCount),
          failureCode = code,
          failureAtMs = nowMs
        )
        CaptureOutcome.CANCELLED -> before.copy(pendingRevision = 0L, finishedRevision = revision)
      }
      persistCaptureHealthState(wakePreferences, before, after)
    }
  }
}

internal fun parseCaptureRevision(value: Double): Long {
  require(value.isFinite() && value % 1.0 == 0.0 && value in 1.0..MAX_SAFE_INTEGER.toDouble()) {
    "SMS capture revision must be a positive safe integer"
  }
  return value.toLong()
}

private enum class CaptureOutcome {
  SUCCESS,
  FAILED,
  UNAVAILABLE,
  CANCELLED
}

private fun parseCaptureOutcome(value: String, code: String?): CaptureOutcome {
  val outcome = when (value) {
    "success" -> CaptureOutcome.SUCCESS
    "failed" -> CaptureOutcome.FAILED
    "unavailable" -> CaptureOutcome.UNAVAILABLE
    "cancelled" -> CaptureOutcome.CANCELLED
    else -> throw IllegalArgumentException("Unknown SMS capture outcome")
  }

  when (outcome) {
    CaptureOutcome.SUCCESS, CaptureOutcome.CANCELLED -> require(code == null) {
      "Successful and cancelled SMS capture attempts cannot have a failure code"
    }
    CaptureOutcome.FAILED -> require(code != null && code in failedCaptureCodes) {
      "SMS capture failure code does not match its outcome"
    }
    CaptureOutcome.UNAVAILABLE -> require(code != null && code in unavailableCaptureCodes) {
      "SMS capture unavailable code does not match its outcome"
    }
  }
  return outcome
}

private fun readCaptureHealthState(preferences: SharedPreferences): CaptureHealthState {
  val revision = preferences.getLong(CAPTURE_REVISION, 0L)
  val pendingRevision = preferences.getLong(CAPTURE_PENDING_REVISION, 0L)
  val finishedRevision = preferences.getLong(CAPTURE_FINISHED_REVISION, 0L)
  check(revision in 0L..MAX_SAFE_INTEGER && pendingRevision in 0L..revision &&
    finishedRevision in 0L..revision && (pendingRevision == 0L || pendingRevision > finishedRevision)) {
    "Stored SMS capture revision is invalid"
  }
  val failureCode = preferences.getString(CAPTURE_FAILURE_CODE, null)?.takeIf { it in allCaptureCodes }
  val failureAtMs = if (failureCode == null) null else preferences.getLong(CAPTURE_FAILURE_AT_MS, 0L)
    .takeIf { it in 1L..MAX_SAFE_INTEGER }
  return CaptureHealthState(
    revision = revision,
    pendingRevision = pendingRevision,
    finishedRevision = finishedRevision,
    failedCount = safeStoredCount(preferences.getLong(CAPTURE_FAILED_COUNT, 0L)),
    unavailableCount = safeStoredCount(preferences.getLong(CAPTURE_UNAVAILABLE_COUNT, 0L)),
    failureCode = failureCode,
    failureAtMs = failureAtMs
  )
}

private fun safeStoredCount(value: Long): Long = value.coerceIn(0L, MAX_SAFE_INTEGER)

private fun saturatingIncrement(value: Long): Long =
  if (value >= MAX_SAFE_INTEGER) MAX_SAFE_INTEGER else value + 1

private fun persistCaptureHealthState(
  preferences: SharedPreferences,
  before: CaptureHealthState,
  after: CaptureHealthState
) {
  val committed = try { writeCaptureHealthState(preferences, after) } catch (_: Exception) { false }
  if (committed) return
  runCatching { writeCaptureHealthState(preferences, before) }
  throw IllegalStateException("Could not persist SMS capture health")
}

private fun writeCaptureHealthState(preferences: SharedPreferences, state: CaptureHealthState): Boolean {
  val editor = preferences.edit()
    .putLong(CAPTURE_REVISION, state.revision)
    .putLong(CAPTURE_PENDING_REVISION, state.pendingRevision)
    .putLong(CAPTURE_FINISHED_REVISION, state.finishedRevision)
    .putLong(CAPTURE_FAILED_COUNT, state.failedCount)
    .putLong(CAPTURE_UNAVAILABLE_COUNT, state.unavailableCount)
  if (state.failureCode == null) editor.remove(CAPTURE_FAILURE_CODE) else editor.putString(CAPTURE_FAILURE_CODE, state.failureCode)
  if (state.failureAtMs == null) editor.remove(CAPTURE_FAILURE_AT_MS) else editor.putLong(CAPTURE_FAILURE_AT_MS, state.failureAtMs)
  return editor.commit()
}

internal fun readSmsCaptureHealthMetadata(preferences: SharedPreferences): Map<String, Any?> {
  synchronized(preferences) {
    val state = readCaptureHealthState(preferences)
    return mapOf(
      "captureFailedCount" to state.failedCount.toDouble(),
      "captureUnavailableCount" to state.unavailableCount.toDouble(),
      "currentFailureCode" to state.failureCode,
      "currentFailureAtMs" to state.failureAtMs?.toDouble()
    )
  }
}
