import { describe, expect, it } from 'vitest';
import { gridBeat, nextGridBeat, quantizeBeat, releaseBeat } from '../src/audio/timing';

describe('time lock', () => {
  it('snaps to the next 16th at 100%', () => {
    expect(quantizeBeat(0.3, 1, 0)).toBeCloseTo(0.5);
    expect(quantizeBeat(0.5, 1, 0)).toBeCloseTo(0.5);
    expect(quantizeBeat(0.01, 1, 0)).toBeCloseTo(0.25);
  });
  it('keeps raw timing at 0% and interpolates between', () => {
    expect(quantizeBeat(0.3, 0, 0)).toBeCloseTo(0.3);
    expect(quantizeBeat(0.3, 0.5, 0)).toBeCloseTo(0.4);
  });
  it('never moves an event earlier', () => {
    for (let b = 0; b < 8; b += 0.013) for (const s of [0, 0.5, 1]) expect(quantizeBeat(b, 1, s)).toBeGreaterThanOrEqual(b - 1e-9);
  });
  it('swing delays odd 16ths', () => {
    expect(gridBeat(1, 1)).toBeCloseTo(0.25 + 1 / 12);
    expect(gridBeat(2, 1)).toBeCloseTo(0.5);
    expect(nextGridBeat(0.26, 1)).toBeCloseTo(0.25 + 1 / 12);
  });
  it('sustains last at least an eighth', () => {
    expect(releaseBeat(1, 1.1, 1, 0)).toBeCloseTo(1.5);
    expect(releaseBeat(1, 2.1, 1, 0)).toBeCloseTo(2.25);
  });
});
