package com.example

import org.junit.Ignore
import org.junit.Test
import org.junit.jupiter.api.Disabled
import org.junit.jupiter.api.Assertions
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.assertFalse

class OrderServiceTest {
    // ruleid: hub-kotlin-disabled
    @Ignore
    @Test
    fun skippedWithJUnit4() {
        assertEquals(2, add(1, 1))
    }

    // ruleid: hub-kotlin-disabled
    @Disabled("flaky")
    @Test
    fun skippedWithJUnit5() {
        assertEquals(2, add(1, 1))
    }

    // ok: hub-kotlin-disabled
    @Test
    fun runs() {
        assertEquals(2, add(1, 1))
    }

    @Test
    fun constantAssertions() {
        // ruleid: hub-kotlin-tautology
        assertTrue(true)
        // ruleid: hub-kotlin-tautology
        assertFalse(false)
        // ruleid: hub-kotlin-tautology
        assertEquals(add(1, 1), add(1, 1))
        // ruleid: hub-kotlin-tautology
        Assertions.assertTrue(true)
        // ok: hub-kotlin-tautology
        assertEquals(2, add(1, 1))
        // ok: hub-kotlin-tautology
        assertTrue(add(1, 1) == 2)
    }

    // ruleid: hub-kotlin-empty-test
    @Test
    fun doesNothing() {}

    // ok: hub-kotlin-empty-test
    @Test
    fun doesSomething() {
        assertEquals(3, add(1, 2))
    }

    private fun add(a: Int, b: Int) = a + b
}
