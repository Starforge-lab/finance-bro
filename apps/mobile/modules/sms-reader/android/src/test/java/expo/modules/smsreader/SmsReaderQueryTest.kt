package expo.modules.smsreader

import java.lang.reflect.InvocationTargetException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
