require 'minitest/autorun'

class InvoiceTest < Minitest::Test
  def test_skipped
    # ruleid: hub-ruby-skipped
    skip 'later'
    assert_equal 2, 1 + 1
  end

  def test_constant
    # ruleid: hub-ruby-tautology
    assert true
    # ruleid: hub-ruby-tautology
    assert_equal total, total
    # ok: hub-ruby-tautology
    assert_equal 2, total
  end

  # ruleid: hub-ruby-empty-minitest
  def test_nothing
  end

  # ok: hub-ruby-empty-minitest
  def helper
  end

  def total
    1 + 1
  end
end
