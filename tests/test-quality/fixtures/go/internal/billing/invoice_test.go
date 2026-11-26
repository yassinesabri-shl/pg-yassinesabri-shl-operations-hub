package billing

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
)

// ok: a table test with testify assertions on the outcome
func TestTotalIncludesTax(t *testing.T) {
	cases := []struct {
		name string
		net  int
		want int
	}{{"zero", 0, 0}, {"hundred", 100, 110}}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, Total(tc.net))
		})
	}
}

// ok: the standard library way, failing through t.Errorf and t.Fatalf
func TestParseRejectsEmpty(t *testing.T) {
	_, err := Parse("")
	if !errors.Is(err, ErrEmpty) {
		t.Fatalf("want ErrEmpty, got %v", err)
	}
}

// ok: delegating the assertion to a helper that takes t
func TestViaHelper(t *testing.T) {
	checkInvoice(t, Invoice{ID: "a"})
}

// ok: an environment-gated skip is only a warning
func TestNeedsRedis(t *testing.T) {
	if testing.Short() {
		// ruleid: shl-go-skip-conditional
		t.Skip("needs redis")
	}
	require.NoError(t, Ping())
}

func TestAlwaysSkipped(t *testing.T) {
	// ruleid: shl-go-skip
	t.Skip("later")
	assert.Equal(t, 1, One())
}

func TestTautologies(t *testing.T) {
	// ruleid: shl-go-tautology
	assert.True(t, true)
	// ruleid: shl-go-tautology
	assert.Equal(t, got, got)
	// ruleid: shl-go-tautology
	require.Equal(t, 1, 1, "one is one")
}

// ruleid: shl-go-empty-test
func TestNothing(t *testing.T) {}

// ruleid: shl-go-no-assertion
func TestOnlyLogs(t *testing.T) {
	got := Total(100)
	t.Log(got)
}

// ruleid: shl-go-mock-heavy
func TestStubsEverything(t *testing.T) {
	m := new(mocks.Gateway)
	m.On("A").Return(1)
	m.On("B").Return(2)
	m.On("C").Return(3)
	m.On("D").Return(4)
	m.On("E").Return(5)
	m.On("F", mock.Anything).Return(6)
	assert.Equal(t, 21, Sum(m))
}

// ok: a benchmark is not a test, and TestMain is not an assertion-less test
func BenchmarkTotal(b *testing.B) {
	for i := 0; i < b.N; i++ {
		Total(100)
	}
}
