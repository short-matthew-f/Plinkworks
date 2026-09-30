import { describe, expect, it } from 'vitest';
import { DrumFloor } from '../src/sim/floor';
import { TABLE_H, TABLE_W } from '../src/model/machine';

describe('drum floor', () => {
  it('rows count up from the bottom (kick first)', () => {
    expect(DrumFloor.cellAt(0.1, 0.1)).toBe(0);
    expect(DrumFloor.cellAt(TABLE_W - 0.1, TABLE_H - 0.1)).toBe(127);
    expect(DrumFloor.cellAt(-1, 3)).toBe(-1);
  });
  it('charges with traffic, fires and fades over the fade length', () => {
    const f = new DrumFloor();
    f.chargeCell(3, 7);
    expect(f.fireColumn(3)).toEqual([]); // one pass is not a beat
    f.chargeCell(3, 7);
    expect(f.fireColumn(3)).toEqual([{ row: 0, col: 3, velocity: expect.closeTo(0.5) }]);
    f.chargeCell(3, 7);
    f.chargeCell(3, 7);
    expect(f.charge[3]).toBe(1);
    f.decay(8, 4); // half the fade
    expect(f.charge[3]).toBeCloseTo(0.5);
    f.decay(8, 4);
    expect(f.fireColumn(3)).toEqual([]);
  });
  it('pinned cells fire at full velocity', () => {
    const f = new DrumFloor();
    f.togglePin(16 + 5);
    expect(f.fireColumn(5)).toEqual([{ row: 1, col: 5, velocity: 1 }]);
    f.togglePin(16 + 5);
    expect(f.fireColumn(5)).toEqual([]);
  });
});
