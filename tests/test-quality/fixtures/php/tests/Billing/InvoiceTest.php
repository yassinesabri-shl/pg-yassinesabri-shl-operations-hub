<?php

use PHPUnit\Framework\TestCase;

class InvoiceTest extends TestCase
{
    // ok: a behavioural test with PHPUnit assertions
    public function testTotalIncludesTax()
    {
        $this->assertEquals(110, (new Invoice(100))->totalWithTax());
    }

    // ok: the exact exception class, and a Mockery expectation as the verification
    public function testRejectsUnknownCustomer(): void
    {
        $this->expectException(CustomerNotFound::class);
        $repo = Mockery::mock(CustomerRepository::class);
        $repo->shouldReceive('find')->once()->andReturn(null);
        (new Invoice(100, $repo))->bill('x');
    }

    // ok: only an environment-gated skip, which is a warning
    public function testNeedsRedis()
    {
        if (!extension_loaded('redis')) {
            // ruleid: shl-php-skipped-conditional
            $this->markTestSkipped('redis missing');
        }
        $this->assertTrue((new Cache())->ping());
    }

    public function testSkippedForGood()
    {
        // ruleid: shl-php-skipped
        $this->markTestSkipped('later');
        $this->assertSame(1, 1 + 0);
    }

    public function testIncomplete()
    {
        // ruleid: shl-php-skipped
        $this->markTestIncomplete('todo');
    }

    public function testTautologies()
    {
        // ruleid: shl-php-tautology
        $this->assertTrue(true);
        // ruleid: shl-php-tautology
        $this->assertEquals($total, $total);
        // ruleid: shl-php-tautology
        self::assertSame(1, 1);
    }

    // ok: Exception::class, but narrowed by its message
    public function testNarrowedByMessage()
    {
        $this->expectException(Exception::class);
        $this->expectExceptionMessage('unknown customer');
        (new Invoice(0))->bill('x');
    }

    // ok: a check* helper counts as the assertion
    public function testThroughAHelper()
    {
        $this->checkTotal(110, new Invoice(100));
    }

    public function testAnyException()
    {
        // ruleid: shl-php-broad-error
        $this->expectException(\Exception::class);
        (new Invoice(0))->bill('x');
    }

    /**
     * // ruleid: shl-php-broad-error-annotation
     * @expectedException Exception
     */
    // ruleid: shl-php-no-assertion
    public function testLegacyAnnotation()
    {
        (new Invoice(0))->bill('x');
    }

    // ruleid: shl-php-empty-test
    public function testNothing() {}

    // ruleid: shl-php-empty-test
    public function testNothingTyped(): void {}

    // ruleid: shl-php-no-assertion
    public function testRunsButChecksNothing()
    {
        $invoice = new Invoice(100);
        $invoice->bill('x');
    }

    public function testMocksEverything()
    {
        // ruleid: shl-php-mock-heavy
        $a = $this->createMock(A::class);
        $a->method('one')->willReturn(1);
        $b = $this->createMock(B::class);
        $b->method('two')->willReturn(2);
        $c = $this->createMock(C::class);
        $c->method('three')->willReturn(3);
        $this->assertSame(6, (new Sum($a, $b, $c))->total());
    }

    // ok: not a test method, so not judged
    private function buildInvoice()
    {
        return new Invoice(100);
    }
}
