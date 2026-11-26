require 'rspec'

RSpec.describe 'billing' do
  # ruleid: hub-ruby-skipped
  xit 'is switched off' do
    expect(add(1, 1)).to eq(2)
  end

  it 'is pending' do
    # ruleid: hub-ruby-skipped
    skip 'later'
    expect(add(1, 1)).to eq(2)
  end

  it 'skips only on one platform' do
    # ok: hub-ruby-skipped
    skip 'not on CI' if ENV['CI']
    expect(add(1, 1)).to eq(2)
  end

  it 'is pending without a reason' do
    # ruleid: hub-ruby-skipped
    pending
    expect(add(1, 1)).to eq(2)
  end

  # ok: hub-ruby-skipped
  it 'runs' do
    expect(add(1, 1)).to eq(2)
  end

  it 'asserts constants' do
    # ruleid: hub-ruby-tautology
    expect(true).to be_truthy
    # ruleid: hub-ruby-tautology
    expect(add(1, 1)).to eq(add(1, 1))
    # ok: hub-ruby-tautology
    expect(add(1, 1)).to eq(2)
  end

  # ruleid: hub-ruby-empty-test
  it 'does nothing' do
  end

  # ok: hub-ruby-empty-test
  it 'does something' do
    expect(add(1, 2)).to eq(3)
  end

  def add(a, b)
    a + b
  end
end
