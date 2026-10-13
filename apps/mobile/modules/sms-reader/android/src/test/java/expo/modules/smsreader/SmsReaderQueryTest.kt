package expo.modules.smsreader

import android.database.Cursor
import android.provider.BaseColumns
import android.provider.Telephony
import java.lang.reflect.InvocationHandler
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Proxy
import java.util.concurrent.CancellationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

/** Exercises the native query parser and cursor ordering without a provider or inbox access. */
class SmsReaderQueryTest {
  @Test
  fun acceptsExactNinetyDayRangeAndInclusiveCursorBounds() {
    val query = parseQuery(options(limit = 1L, after = cursor(START, "1")))
    assertEquals(START, field(query, "startDateMs"))
    assertEquals(END, field(query, "endDateMs"))
    assertEquals(1, field(query, "limit"))

    val maxLimit = parseQuery(options(limit = 100L, after = cursor(END, "1")))
    assertEquals(100, field(maxLimit, "limit"))
  }

  @Test
  fun acceptsCanonicalPlatformIdsBeyondJavaScriptSafeInteger() {
    val query = parseQuery(options(after = cursor(END, "9007199254740993")))
    val after = field(query, "after")!!
    assertEquals(9_007_199_254_740_993L, field(after, "id"))

    val largest = parseQuery(options(after = cursor(END, Long.MAX_VALUE.toString())))
    assertEquals(Long.MAX_VALUE, field(field(largest, "after")!!, "id"))
  }

  @Test
  fun ordersEqualDateCursorsByNumericPlatformId() {
    assertTrue(isAfter(END, 10L, END, 2L))
    assertFalse(isAfter(END, 2L, END, 10L))
    assertFalse(isAfter(END, 10L, END, 10L))
    assertTrue(isAfter(END, 2L, START, Long.MAX_VALUE))
    assertFalse(isAfter(START, Long.MAX_VALUE, END, 1L))

    assertTrue(isAfter(END, 9_007_199_254_740_993L, END, 9_007_199_254_740_992L))
    assertFalse(isAfter(END, 9_007_199_254_740_992L, END, 9_007_199_254_740_993L))
  }

  @Test
  fun rejectsInvalidFutureFractionalAndUnsafeDatesAndLimits() {
    listOf(
      options(start = 0L),
      options(start = -1L),
      options(start = END + 1L),
      options(end = START - 1L),
      options(start = 253_402_300_799_000L - MAX_RANGE_MS, end = 253_402_300_799_000L),
      options(start = START - 1L),
      options(start = START + 0.5),
      options(end = 9_007_199_254_740_991.0),
      options(end = 9_007_199_254_740_992.0),
      options(start = 9_007_199_254_740_992.0),
      options(start = Double.NaN),
      options(end = Double.POSITIVE_INFINITY),
      options(limit = 0L),
      options(limit = 101L),
      options(limit = 1.5),
      options(start = "1700000000000")
    ).forEach { invalid ->
      assertThrows(IllegalArgumentException::class.java) { parseQuery(invalid) }
    }
  }

  @Test
  fun rejectsMalformedOutOfRangeAndOverflowingCursors() {
    val malformed = listOf(
      "not-a-cursor",
      cursor(END, 1L),
      cursor(START - 1L, "1"),
      cursor(END + 1L, "1"),
      cursor(END + 0.5, "1"),
      cursor(END, ""),
      cursor(END, "0"),
      cursor(END, "-1"),
      cursor(END, "01"),
      cursor(END, "+1"),
      cursor(END, "1.0"),
      cursor(END, "9223372036854775808")
    )
    malformed.forEach { invalidAfter ->
      assertThrows(IllegalArgumentException::class.java) {
        parseQuery(options(after = invalidAfter))
      }
    }
  }

  @Test
  fun acceptsOnlyCanonicalPositivePlatformIds() {
    assertEquals(Long.MAX_VALUE, parsePlatformId(Long.MAX_VALUE.toString()))
    listOf("", "0", "-1", "01", "+1", "1.0", "9223372036854775808").forEach { id ->
      assertThrows(IllegalArgumentException::class.java) { parsePlatformId(id) }
    }
  }

  @Test
  fun readsOneMatchingMessageAndClosesItsCursor() {
    val fake = FakeCursor(listOf(Row(id = 42L)))

    val message = toInboxMessage(fake.cursor, 42L)!!

    assertEquals("42", message["id"])
    assertEquals(END.toDouble(), message["dateMs"])
    assertEquals("VM-EXAMPLE", message["sender"])
    assertEquals("Fictional payment of Rs 12.34", message["body"])
    assertEquals(1, fake.closeCount)
  }

  @Test
  fun preservesLargePlatformIdsAsStringsAndNormalizesNullText() {
    val platformId = 9_007_199_254_740_993L
    val fake = FakeCursor(listOf(Row(id = platformId, sender = null, body = null)))

    val message = toInboxMessage(fake.cursor, platformId)!!

    assertEquals(platformId.toString(), message["id"])
    assertEquals("", message["sender"])
    assertEquals("", message["body"])
    assertEquals(1, fake.closeCount)
  }

  @Test
  fun returnsNullOnlyForAnEmptyCursorAndClosesIt() {
    val fake = FakeCursor(emptyList())

    assertNull(toInboxMessage(fake.cursor, 42L))
    assertEquals(1, fake.closeCount)
    assertThrows(IllegalStateException::class.java) { toInboxMessage(null, 42L) }
  }

  @Test
  fun rejectsMismatchedInvalidOrDuplicateRowsAndClosesCursor() {
    listOf(
      listOf(Row(id = 43L)),
      listOf(Row(id = 42L, dateMs = 0L)),
      listOf(Row(id = 42L, dateMs = 9_007_199_254_740_992L)),
      listOf(Row(id = 42L), Row(id = 42L))
    ).forEach { rows ->
      val fake = FakeCursor(rows)
      val failure = assertThrows(IllegalStateException::class.java) {
        toInboxMessage(fake.cursor, 42L)
      }
      assertEquals("Could not read SMS inbox message", failure.message)
      assertEquals(1, fake.closeCount)
    }
  }

  @Test
  fun providerCursorFailureIsSanitizedAndClosed() {
    val fake = FakeCursor(emptyList(), moveFailure = IllegalStateException("Synthetic provider error contains private content"))

    val failure = assertThrows(IllegalStateException::class.java) {
      toInboxMessage(fake.cursor, 42L)
    }

    assertEquals("Could not read SMS inbox message", failure.message)
    assertEquals(1, fake.closeCount)
  }

  @Test
  fun permissionRevocationIsReportedWithoutProviderTextAndClosesCursor() {
    val fake = FakeCursor(emptyList(), moveFailure = SecurityException("Sensitive provider content"))

    val failure = assertThrows(Exception::class.java) {
      toInboxMessage(fake.cursor, 42L)
    }

    assertEquals("MissingPermissions", failure.javaClass.simpleName)
    assertTrue(failure.message?.contains("READ_SMS") == true)
    assertFalse(failure.toString().contains("Sensitive provider content"))
    assertEquals(1, fake.closeCount)
  }

  @Test
  fun coroutineCancellationPropagatesAndClosesCursor() {
    val cancellation = CancellationException("cancel read")
    val fake = FakeCursor(emptyList(), moveFailure = cancellation)

    val failure = assertThrows(CancellationException::class.java) {
      toInboxMessage(fake.cursor, 42L)
    }

    assertSame(cancellation, failure)
    assertEquals(1, fake.closeCount)
  }

  private fun options(
    start: Any? = START,
    end: Any? = END,
    limit: Any? = 1L,
    after: Any? = null
  ): Map<String, Any?> = mapOf(
    "startDateMs" to start,
    "endDateMs" to end,
    "limit" to limit,
    "after" to after
  )

  private fun cursor(dateMs: Any?, id: Any?): Map<String, Any?> = mapOf("dateMs" to dateMs, "id" to id)

  private fun parseQuery(options: Map<String, Any?>): Any = try {
    parseMethod.invoke(null, options)!!
  } catch (failure: InvocationTargetException) {
    throw failure.targetException
  }

  private fun isAfter(date: Long, id: Long, otherDate: Long, otherId: Long): Boolean =
    isAfterMethod.invoke(null, newCursor(date, id), newCursor(otherDate, otherId)) as Boolean

  private fun newCursor(date: Long, id: Long): Any = cursorConstructor.newInstance(date, id)

  private fun field(instance: Any, name: String): Any? =
    instance.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(instance)

  private data class Row(
    val id: Long = 42L,
    val sender: String? = "VM-EXAMPLE",
    val body: String? = "Fictional payment of Rs 12.34",
    val dateMs: Long = END
  )

  private class FakeCursor(private val rows: List<Row>, private val moveFailure: RuntimeException? = null) : InvocationHandler {
    private val columns = listOf(BaseColumns._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE)
    private var position = -1
    var closeCount = 0
      private set

    val cursor: Cursor = Proxy.newProxyInstance(
      Cursor::class.java.classLoader ?: ClassLoader.getSystemClassLoader(),
      arrayOf(Cursor::class.java),
      this
    ) as Cursor

    override fun invoke(proxy: Any?, method: java.lang.reflect.Method, args: Array<out Any?>?): Any? {
      val index = args?.firstOrNull() as? Int
      return when (method.name) {
        "getColumnIndexOrThrow" -> columns.indexOf(args?.firstOrNull() as String).also {
          if (it < 0) throw IllegalArgumentException("Missing column")
        }
        "moveToNext" -> {
          moveFailure?.let { throw it }
          position += 1
          position < rows.size
        }
        "getLong" -> when (index) {
          0 -> rows[position].id
          3 -> rows[position].dateMs
          else -> throw AssertionError("Unexpected long column")
        }
        "getString" -> when (index) {
          1 -> rows[position].sender
          2 -> rows[position].body
          else -> throw AssertionError("Unexpected string column")
        }
        "isNull" -> when (index) {
          1 -> rows[position].sender == null
          2 -> rows[position].body == null
          else -> false
        }
        "close" -> { closeCount += 1; null }
        "toString" -> "FakeCursor"
        "hashCode" -> System.identityHashCode(proxy)
        "equals" -> proxy === args?.firstOrNull()
        else -> throw AssertionError("Unexpected cursor call: ${method.name}")
      }
    }
  }

  companion object {
    private const val MAX_RANGE_MS = 90L * 24 * 60 * 60 * 1000
    private const val END = 1_700_000_000_000L
    private const val START = END - MAX_RANGE_MS

    private val parserClass = Class.forName("expo.modules.smsreader.SmsReaderModuleKt")
    private val parseMethod = parserClass.getDeclaredMethod("parseQuery", Map::class.java).apply { isAccessible = true }
    private val isAfterMethod = parserClass.declaredMethods.single {
      it.name == "isAfter" && it.parameterCount == 2
    }.apply { isAccessible = true }
    private val cursorClass = Class.forName("expo.modules.smsreader.InboxCursor")
    private val cursorConstructor = cursorClass.declaredConstructors.single {
      it.parameterCount == 2
    }.apply { isAccessible = true }
  }
}
