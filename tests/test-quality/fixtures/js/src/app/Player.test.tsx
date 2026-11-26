import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Player } from './Player';

describe('Player', () => {
  // ok: asserts through Testing Library's expect
  it('shows the title', () => {
    render(<Player title="Intro" />);
    expect(screen.getByText('Intro')).toBeInTheDocument();
  });

  // ok: an implicit assertion, because getBy* throws when the element is missing
  it('has a play button', () => {
    render(<Player title="Intro" />);
    screen.getByRole('button');
  });

  // ok: awaits a rejection with a message
  it('fails to load', async () => {
    await expect(load('x')).rejects.toThrow('not found');
  });

  it('rejects, but with what', async () => {
    // ruleid: shl-js-broad-error
    await expect(load('x')).rejects.toThrow();
  });

  // ruleid: shl-js-skipped
  it.only('is the only one that runs', () => {
    expect(1 + 1).toBe(2);
  });

  // ruleid: shl-js-mock-heavy
  it('mocks everything', () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    const d = vi.fn();
    const e = vi.spyOn(api, 'one');
    const f = vi.spyOn(api, 'two');
    const g = vi.spyOn(api, 'three');
    expect(run(a, b, c, d, e, f, g)).toBe(7);
  });
});
