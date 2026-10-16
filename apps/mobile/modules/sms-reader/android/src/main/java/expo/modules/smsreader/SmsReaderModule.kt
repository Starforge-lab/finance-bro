package expo.modules.smsreader

import android.Manifest
import android.content.Context
import android.database.Cursor
import android.os.SystemClock
import android.provider.BaseColumns
import android.provider.Telephony
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.interfaces.taskManager.TaskManagerInterface
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val MAX_BATCH_SIZE = 100
private val SMS_PERMISSIONS = arrayOf(Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS)

private data class InboxCursor(val dateMs: Long, val id: Long) {
  fun toMap() = mapOf("dateMs" to dateMs.toDouble(), "id" to id.toString())
}

private data class InboxQuery(
  val startDateMs: Long,
  val endDateMs: Long,
  val after: InboxCursor?,
  val limit: Int,
  val newestFirst: Boolean
)

class SmsReaderModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SmsReader")

    AsyncFunction("getPermissionsAsync") { promise: Promise ->
      val manager = appContext.permissions ?: throw Exceptions.PermissionsModuleNotFound()
      manager.getPermissions(permissionResult(promise), *SMS_PERMISSIONS)
    }

    AsyncFunction("requestPermissionsAsync") { promise: Promise ->
      val manager = appContext.permissions ?: throw Exceptions.PermissionsModuleNotFound()
      manager.askForPermissions(permissionResult(promise), *SMS_PERMISSIONS)
    }

    AsyncFunction("getImportSettingsAsync") Coroutine { ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      withContext(Dispatchers.IO) { readImportSettings(context.smsImportSettingsPreferences()).toMap() }
    }

    AsyncFunction("setImportSettingsAsync") Coroutine { options: Map<String, Any?> ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      withContext(Dispatchers.IO) { setImportSettings(context.smsImportSettingsPreferences(), options).toMap() }
    }

    AsyncFunction("registerWakeTaskAsync") {
      val taskManager = appContext.legacyModule<TaskManagerInterface>()
        ?: throw IllegalStateException("TaskManager is unavailable")
      taskManager.registerTask(SMS_WAKE_TASK_NAME, SmsCatchupWakeTaskConsumer::class.java, emptyMap())
    }

    AsyncFunction("unregisterWakeTaskAsync") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      SmsCatchupWakeWork.cancel(context.applicationContext)
      appContext.legacyModule<TaskManagerInterface>()?.let { taskManager ->
        if (taskManager.taskHasConsumerOfClass(SMS_WAKE_TASK_NAME, SmsCatchupWakeTaskConsumer::class.java)) {
          taskManager.unregisterTask(SMS_WAKE_TASK_NAME, SmsCatchupWakeTaskConsumer::class.java)
        }
      }
    }

    AsyncFunction("queryInboxAsync") Coroutine { options: Map<String, Any?> ->
      val query = parseQuery(options)
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val permissions = appContext.permissions ?: throw Exceptions.PermissionsModuleNotFound()
      if (!permissions.hasGrantedPermissions(Manifest.permission.READ_SMS)) {
        throw Exceptions.MissingPermissions(Manifest.permission.READ_SMS)
      }
      withContext(Dispatchers.IO) { queryInbox(context, query) }
    }

    AsyncFunction("readInboxMessageAsync") Coroutine { platformId: String ->
      val id = parsePlatformId(platformId)
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val permissions = appContext.permissions ?: throw Exceptions.PermissionsModuleNotFound()
      if (!permissions.hasGrantedPermissions(Manifest.permission.READ_SMS)) {
        throw Exceptions.MissingPermissions(Manifest.permission.READ_SMS)
      }
      withContext(Dispatchers.IO) { readInboxMessage(context, id) }
    }

    AsyncFunction("getWakeMetadataAsync") Coroutine { ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      readSmsWakeMetadata(context.smsWakePreferences())
    }

    AsyncFunction("getElapsedRealtimeAsync") {
      SystemClock.elapsedRealtime().toDouble()
    }
  }

  private fun permissionResult(promise: Promise) = PermissionsResponseListener { results ->
    val readSms = results[Manifest.permission.READ_SMS]?.status == PermissionsStatus.GRANTED
    val receiveSms = results[Manifest.permission.RECEIVE_SMS]?.status == PermissionsStatus.GRANTED
    promise.resolve(mapOf("readSms" to readSms, "receiveSms" to receiveSms, "granted" to (readSms && receiveSms)))
  }
}

private fun parseQuery(options: Map<String, Any?>): InboxQuery {
  val startDateMs = options.safeInteger("startDateMs")
  val endDateMs = options.safeInteger("endDateMs")
  val now = System.currentTimeMillis()
  require(startDateMs > 0L && endDateMs >= startDateMs && endDateMs <= now) {
    "SMS query dates must be positive, ordered, and no later than now"
  }
  require(endDateMs - startDateMs <= MAX_RANGE_MS) { "SMS query range cannot exceed 90 days" }

  val limitValue = options.safeInteger("limit")
  require(limitValue in 1L..MAX_BATCH_SIZE.toLong()) { "SMS query limit must be from 1 to 100" }

  val newestFirst = if (options.containsKey("newestFirst")) {
    options["newestFirst"] as? Boolean
      ?: throw IllegalArgumentException("newestFirst must be a boolean")
  } else {
    false
  }

  val after = when (val value = options["after"]) {
    null -> null
    is Map<*, *> -> {
      val dateMs = value.safeInteger("dateMs")
      val rawId = value["id"] as? String
        ?: throw IllegalArgumentException("SMS cursor id must be a positive integer string")
      val id = parsePlatformId(rawId)
      require(dateMs in startDateMs..endDateMs) {
        "SMS cursor date must be inside the query range"
      }
      InboxCursor(dateMs, id)
    }
    else -> throw IllegalArgumentException("SMS cursor must be an object")
  }
  require(!newestFirst || after == null) { "newestFirst cannot be combined with an after cursor" }

  return InboxQuery(startDateMs, endDateMs, after, limitValue.toInt(), newestFirst)
}

private fun Map<*, *>.safeInteger(name: String): Long {
  val value = this[name] as? Number ?: throw IllegalArgumentException("$name must be a safe integer")
  val number = value.toDouble()
  require(number.isFinite() && number >= 0.0 && number <= MAX_SAFE_INTEGER.toDouble() && number % 1.0 == 0.0) {
    "$name must be a safe integer"
  }
  return number.toLong()
}

private fun queryInbox(context: Context, query: InboxQuery): Map<String, Any?> {
  val dateColumn = Telephony.Sms.DATE
  val idColumn = BaseColumns._ID
  val selection = buildString {
    append("$dateColumn >= ? AND $dateColumn <= ?")
    if (query.after != null) append(" AND ($dateColumn > ? OR ($dateColumn = ? AND $idColumn > ?))")
  }
  val selectionArgs = buildList {
    add(query.startDateMs.toString())
    add(query.endDateMs.toString())
    query.after?.let {
      add(it.dateMs.toString())
      add(it.dateMs.toString())
      add(it.id.toString())
    }
  }.toTypedArray()
  val messages = mutableListOf<Map<String, Any?>>()
  var lastCursor: InboxCursor? = null
  var previousCursor: InboxCursor? = query.after
  var hasMore = false
  val projection = arrayOf(idColumn, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, dateColumn)

  val cursor = context.contentResolver.query(
    Telephony.Sms.Inbox.CONTENT_URI,
    projection,
    selection,
    selectionArgs,
    smsInboxSortOrder(query.newestFirst)
  ) ?: throw IllegalStateException("SMS inbox provider did not return a cursor")

  cursor.use {
    val idIndex = cursor.getColumnIndexOrThrow(idColumn)
    val senderIndex = cursor.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
    val bodyIndex = cursor.getColumnIndexOrThrow(Telephony.Sms.BODY)
    val dateIndex = cursor.getColumnIndexOrThrow(dateColumn)

    while (cursor.moveToNext()) {
      if (messages.size == query.limit) {
        hasMore = true
        break
      }
      val rowCursor = cursor.toInboxCursor(idIndex, dateIndex)
      require(rowCursor.dateMs in query.startDateMs..query.endDateMs) { "SMS provider returned a date outside the requested range" }
      val isInOrder = previousCursor?.let { previous ->
        if (query.newestFirst) rowCursor.isBefore(previous) else rowCursor.isAfter(previous)
      } ?: true
      require(isInOrder) {
        "SMS provider returned rows outside the requested cursor order"
      }
      previousCursor = rowCursor
      messages += mapOf(
        "id" to rowCursor.id.toString(),
        "dateMs" to rowCursor.dateMs.toDouble(),
        "sender" to cursor.getStringOrNull(senderIndex).orEmpty(),
        "body" to cursor.getStringOrNull(bodyIndex).orEmpty()
      )
      lastCursor = rowCursor
    }
  }

  return mapOf(
    "messages" to messages,
    "next" to if (query.newestFirst) null else lastCursor?.takeIf { hasMore }?.toMap()
  )
}

internal fun smsInboxSortOrder(newestFirst: Boolean): String {
  val direction = if (newestFirst) "DESC" else "ASC"
  return "${Telephony.Sms.DATE} $direction, ${BaseColumns._ID} $direction"
}

private fun readInboxMessage(context: Context, id: Long): Map<String, Any?>? {
  val idColumn = BaseColumns._ID
  val projection = arrayOf(idColumn, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE)
  val cursor = try {
    context.contentResolver.query(
      Telephony.Sms.Inbox.CONTENT_URI,
      projection,
      "$idColumn = ?",
      arrayOf(id.toString()),
      null
    )
  } catch (failure: CancellationException) {
    throw failure
  } catch (_: SecurityException) {
    throw Exceptions.MissingPermissions(Manifest.permission.READ_SMS)
  } catch (_: Exception) {
    throw IllegalStateException("Could not query SMS inbox")
  }
  return toInboxMessage(cursor, id)
}

internal fun parsePlatformId(platformId: String): Long {
  val id = platformId.toLongOrNull()
    ?: throw IllegalArgumentException("SMS platform id must be a canonical positive integer string")
  require(id > 0L && id.toString() == platformId) {
    "SMS platform id must be a canonical positive integer string"
  }
  return id
}

internal fun toInboxMessage(cursor: Cursor?, requestedId: Long): Map<String, Any?>? {
  val resultCursor = cursor ?: throw IllegalStateException("SMS inbox provider did not return a cursor")
  return try {
    resultCursor.use {
      val idIndex = resultCursor.getColumnIndexOrThrow(BaseColumns._ID)
      val senderIndex = resultCursor.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
      val bodyIndex = resultCursor.getColumnIndexOrThrow(Telephony.Sms.BODY)
      val dateIndex = resultCursor.getColumnIndexOrThrow(Telephony.Sms.DATE)
      if (!resultCursor.moveToNext()) return@use null

      val rowCursor = resultCursor.toInboxCursor(idIndex, dateIndex)
      require(rowCursor.id == requestedId) { "SMS provider returned a different message id" }
      val message = mapOf(
        "id" to rowCursor.id.toString(),
        "dateMs" to rowCursor.dateMs.toDouble(),
        "sender" to resultCursor.getStringOrNull(senderIndex).orEmpty(),
        "body" to resultCursor.getStringOrNull(bodyIndex).orEmpty()
      )
      require(!resultCursor.moveToNext()) { "SMS provider returned duplicate message rows" }
      message
    }
  } catch (failure: CancellationException) {
    throw failure
  } catch (_: SecurityException) {
    throw Exceptions.MissingPermissions(Manifest.permission.READ_SMS)
  } catch (_: Exception) {
    throw IllegalStateException("Could not read SMS inbox message")
  }
}

private fun Cursor.toInboxCursor(idIndex: Int, dateIndex: Int): InboxCursor {
  val id = getLong(idIndex)
  val dateMs = getLong(dateIndex)
  require(id > 0L && dateMs > 0L && dateMs <= MAX_SAFE_INTEGER) {
    "SMS provider returned an invalid id or timestamp"
  }
  return InboxCursor(dateMs, id)
}

private fun InboxCursor.isAfter(other: InboxCursor): Boolean =
  dateMs > other.dateMs || (dateMs == other.dateMs && id > other.id)

private fun InboxCursor.isBefore(other: InboxCursor): Boolean =
  dateMs < other.dateMs || (dateMs == other.dateMs && id < other.id)

private fun Cursor.getStringOrNull(index: Int): String? = if (isNull(index)) null else getString(index)
