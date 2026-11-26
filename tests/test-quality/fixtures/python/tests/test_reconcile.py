import sys
import unittest
from unittest import mock
from unittest.mock import MagicMock, patch

import pytest

from batch.reconcile import unmatched


class UnmatchedTests(unittest.TestCase):
    # ok: a plain unittest assertion on the outcome
    def test_transfer_without_posting_is_reported(self) -> None:
        self.assertEqual(unmatched(["t1", "t2"], ["t2"]), ["t1"])

    # ok: the exact exception, as a context manager
    def test_rejects_a_blank_id(self) -> None:
        with self.assertRaises(ValueError):
            unmatched([""], [])

    # ruleid: shl-python-skipped
    @unittest.skip("later")
    def test_skipped(self) -> None:
        self.assertEqual(1, 1 + 0)

    # ruleid: shl-python-skipped-conditional
    @unittest.skipIf(sys.platform == "win32", "posix only")
    def test_posix_only(self) -> None:
        self.assertTrue(unmatched([], []) == [])

    def test_tautologies(self) -> None:
        # ruleid: shl-python-tautology
        self.assertTrue(True)
        # ruleid: shl-python-tautology
        self.assertEqual(result, result)

    def test_broad_error(self) -> None:
        # ruleid: shl-python-broad-error
        with self.assertRaises(Exception):
            unmatched([""], [])

    # ruleid: shl-python-empty-test
    def test_nothing(self) -> None:
        pass

    # ruleid: shl-python-no-assertion
    def test_runs_but_checks_nothing(self) -> None:
        unmatched(["t1"], [])


# ok: pytest style, an assertion and a named error with a message
def test_duplicate_is_reported_once():
    assert unmatched(["t1", "t1"], []) == ["t1"]


def test_error_has_a_message():
    with pytest.raises(ValueError, match="blank"):
        unmatched([""], [])


# ok: a helper named check_* counts as an assertion
def test_through_a_helper():
    check_report(unmatched(["t1"], []))


# ruleid: shl-python-skipped
@pytest.mark.skip(reason="later")
def test_skipped_by_marker():
    assert unmatched([], []) == []


# ruleid: shl-python-skipped
@pytest.mark.xfail
def test_expected_failure():
    assert unmatched([], ["x"]) == ["x"]


def test_skips_inside_the_body():
    # ruleid: shl-python-skipped
    pytest.skip("not today")
    assert unmatched([], []) == []


def test_conditional_skip():
    if not HAS_DB:
        # ruleid: shl-python-skipped-conditional
        pytest.skip("no database")
    assert unmatched([], []) == []


def test_assert_true_constant():
    # ruleid: shl-python-tautology
    assert True


def test_assert_same_value():
    # ruleid: shl-python-tautology
    assert total == total


# ok: the exception is captured, so the test inspects it
def test_captured_exception():
    with pytest.raises(Exception) as excinfo:
        unmatched([""], [])
    assert "blank" in str(excinfo.value)


def test_any_exception_is_enough():
    # ruleid: shl-python-broad-error
    with pytest.raises(Exception):
        unmatched([""], [])


# ruleid: shl-python-patch-stack
@patch("batch.a")
@patch("batch.b")
@patch("batch.c")
@patch("batch.d")
def test_stacked_patches(d, c, b, a):
    assert unmatched([], []) == []


# ruleid: shl-python-mock-heavy
def test_mocks_everything():
    a = MagicMock()
    b = MagicMock()
    c = MagicMock()
    d = MagicMock()
    e = mock.Mock()
    f = mock.Mock()
    g = mock.Mock()
    assert run(a, b, c, d, e, f, g) == 7
