package com.example;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class OrderServiceTest {

    @Mock
    private OrderRepository repository;

    // ok: a plain behavioural test, an assertion on the outcome
    @Test
    void totalIncludesTax() {
        assertEquals(110, new Order(100).totalWithTax());
    }

    // ok: the exact exception type, and a verification on a mock
    @Test
    void rejectsAnUnknownOrder() {
        when(repository.find("x")).thenReturn(null);
        assertThrows(OrderNotFoundException.class, () -> service.cancel("x"));
        verify(repository).find("x");
    }

    // ok: Spring's smoke test is exempt from the empty-test rule
    @Test
    void contextLoads() {
    }

    // ruleid: shl-java-disabled
    @Disabled("flaky")
    @Test
    void sometimesFails() {
        assertTrue(service.ping());
    }

    // ruleid: shl-java-empty-test
    @Test
    void emptyOne() {
    }

    // ruleid: shl-java-empty-test
    @Test
    void emptyWithThrows() throws Exception {
    }

    @Test
    void tautologies() {
        // ruleid: shl-java-tautology
        assertTrue(true);
        // ruleid: shl-java-tautology
        assertEquals(order, order);
        // ruleid: shl-java-tautology
        Assertions.assertEquals(1, 1);
    }

    // ok: the exception is captured, so the test inspects it
    @Test
    void capturedException() {
        Exception thrown = assertThrows(Exception.class, () -> service.cancel("x"));
        assertEquals("unknown order", thrown.getMessage());
    }

    @Test
    void anyExceptionWillDo() {
        // ruleid: shl-java-broad-error
        assertThrows(Exception.class, () -> service.cancel("x"));
    }

    @Test
    void runtimeExceptionIsBroad() {
        // ruleid: shl-java-runtime-error
        assertThrows(RuntimeException.class, () -> service.cancel("x"));
    }

    // ruleid: shl-java-no-assertion
    @Test
    void runsButChecksNothing() {
        service.cancel("1");
    }

    // ok: asserts through a MockMvc expectation
    @Test
    void getsTheStatus() throws Exception {
        mockMvc.perform(get("/status")).andExpect(status().isOk());
    }

    // ok: the exact JUnit 4 expected exception
    @Test(expected = IllegalStateException.class)
    void junit4Expected() {
        service.fail();
    }

    // ruleid: shl-java-broad-error
    @Test(expected = Exception.class)
    void junit4AnyException() {
        service.fail();
    }

    @Test
    void conditional() {
        // ruleid: shl-java-assumption
        Assumptions.assumeTrue(System.getenv("CI") == null);
        assertTrue(service.ping());
    }

    // ruleid: shl-java-mock-heavy
    @Test
    void stubsEverything() {
        var service = new Service(a, b, c);
        when(a.one()).thenReturn(1);
        when(a.two()).thenReturn(2);
        when(b.one()).thenReturn(3);
        when(b.two()).thenReturn(4);
        when(c.one()).thenReturn(5);
        when(c.two()).thenReturn(6);
        assertEquals(21, service.sum());
    }
}
