using Xunit;
using NUnit.Framework;

namespace Billing.Tests
{
    public class InvoiceTests
    {
        // ruleid: hub-csharp-skipped
        [Fact(Skip = "flaky")]
        public void SkippedWithXunit()
        {
            Assert.Equal(2, Add(1, 1));
        }

        // ruleid: hub-csharp-skipped
        [Test, Ignore("later")]
        public void IgnoredWithNunit()
        {
            Assert.AreEqual(2, Add(1, 1));
        }

        // ruleid: hub-csharp-skipped
        [Ignore]
        [TestMethod]
        public void IgnoredWithMstest()
        {
            Assert.AreEqual(2, Add(1, 1));
        }

        // ok: hub-csharp-skipped
        [Fact]
        public void Runs()
        {
            Assert.Equal(2, Add(1, 1));
        }

        [Fact]
        public void ConstantAssertions()
        {
            // ruleid: hub-csharp-tautology
            Assert.True(true);
            // ruleid: hub-csharp-tautology
            Assert.Equal(Add(1, 1), Add(1, 1));
            // ok: hub-csharp-tautology
            Assert.Equal(2, Add(1, 1));
            // ok: hub-csharp-tautology
            Assert.True(Add(1, 1) == 2);
        }

        // ruleid: hub-csharp-empty-test
        [Fact]
        public void DoesNothing() { }

        // ruleid: hub-csharp-empty-test
        [Test]
        [Category("slow")]
        public async Task AlsoNothing()
        {
        }

        // ok: hub-csharp-empty-test
        [Fact]
        public void DoesSomething()
        {
            Assert.Equal(3, Add(1, 2));
        }

        private static int Add(int a, int b) => a + b;
    }
}
