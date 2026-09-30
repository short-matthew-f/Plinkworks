import { describe, expect, it } from 'vitest';
import { bandStep, ballStep, degreeHue, stepToMidi, SCALES, SCALE_IDS } from '../src/model/music';

describe('scale lock', () => {
  it('maps steps to MIDI inside the scale', () => {
    expect(stepToMidi(0, 0, 'majorPent')).toBe(60);
    expect(stepToMidi(3, 0, 'majorPent')).toBe(67);
    expect(stepToMidi(5, 0, 'majorPent')).toBe(72);
    expect(stepToMidi(-1, 0, 'majorPent')).toBe(57);
    expect(stepToMidi(0, 2, 'minor')).toBe(62);
  });

  it('never produces a note outside the scale', () => {
    for (const id of SCALE_IDS) {
      const iv = new Set(SCALES[id].intervals);
      for (let key = 0; key < 12; key++) {
        for (let s = -20; s <= 20; s++) {
          const pc = (((stepToMidi(s, key, id) - 60 - key) % 12) + 12) % 12;
          expect(iv.has(pc)).toBe(true);
        }
      }
    }
  });

  it('ball size is octave: small is high, large is low', () => {
    expect(ballStep(2, 0, 'majorPent')).toBe(7);
    expect(ballStep(2, 1, 'majorPent')).toBe(2);
    expect(ballStep(2, 2, 'majorPent')).toBe(-3);
  });

  it('degree 1 is always the same hue', () => {
    expect(degreeHue(0)).toBe(degreeHue(7));
  });

  it('halving a rubber band raises it an octave', () => {
    expect(bandStep(3, 'majorPent')).toBe(0);
    expect(bandStep(1.5, 'majorPent')).toBe(5);
    expect(bandStep(6, 'major')).toBe(-7);
  });
});
