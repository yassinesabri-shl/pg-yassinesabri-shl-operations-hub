package com.example;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;

// ruleid: shl-java-disabled
@Disabled("whole class")
class SkippedSuiteTest {

    @Test
    void neverRuns() {
        org.junit.jupiter.api.Assertions.assertEquals(2, 1 + 1);
    }
}
