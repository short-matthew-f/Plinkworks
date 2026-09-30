import { describe, expect, it } from 'vitest';
import { DrumFloor, fireThreshold, rowsForIntensity, ROW_CAPS } from '../src/sim/floor';
import { FLOOR_COLS, TABLE_H, TABLE_W } from '../src/model/machine';

const ALL = rowsForIntensity(1);

describe('drum floor', () => {
  it('rows count up from the bottom (kick first)', () => {
    expect(DrumFloor.cellAt(0.1, 0.1)).toBe(0);
    expect(DrumFloor.cellAt(TABLE_W - 0.1, TABLE_H - 0.1)).toBe(127);
    expect(DrumFloor.cellAt(-1, 3)).toBe(-1);
  });

  it('needs repeated traffic, then loops bar after bar while the charge lasts', () => {
    const f = new DrumFloor();
    const t = fireThreshold(0.5);
    f.chargeCell(3, 7);
    f.planBar(t, 0.5, ALL);
    expect(f.fireColumn(3)).toEqual([]); // one pass is not a beat
    f.chargeCell(3, 7);
    f.planBar(t, 0.5, ALL);
    expect(f.fireColumn(3)).toHaveLength(1);
    f.planBar(t, 0.5, ALL); // the next bar repeats it
    expect(f.fireColumn(3)).toHaveLength(1);
    f.decay(24, 6); // fades out over the fade length
    f.planBar(t, 0.5, ALL);
    expect(f.fireColumn(3)).toEqual([]);
  });

  it('caps each row to its strongest cells', () => {
    const f = new DrumFloor();
    for (let col = 0; col < FLOOR_COLS; col++) for (let k = 0; k < 4; k++) f.chargeCell(FLOOR_COLS + col, 1 + col * 0.3); // snare row
    f.planBar(fireThreshold(0.5), 0.5, ALL);
    let hits = 0;
    for (let col = 0; col < FLOOR_COLS; col++) hits += f.fireColumn(col).length;
    expect(hits).toBe(ROW_CAPS[1]);
    expect(f.fireColumn(FLOOR_COLS - 1)).toHaveLength(1); // the most-charged cell wins
  });

  it('the arc gates rows: quiet sections are kick and shaker', () => {
    expect(rowsForIntensity(0.2)).toEqual([true, false, true, false, false, false, false, false]);
    expect(rowsForIntensity(0.9).every(Boolean)).toBe(true);
    const f = new DrumFloor();
    for (let k = 0; k < 4; k++) f.chargeCell(FLOOR_COLS + 2, 7);
    f.planBar(fireThreshold(0.5), 0.5, rowsForIntensity(0.2));
    expect(f.fireColumn(2)).toEqual([]);
  });

  it('pinned cells always play', () => {
    const f = new DrumFloor();
    f.togglePin(16 + 5);
    f.planBar(fireThreshold(0.5), 0.5, rowsForIntensity(0));
    expect(f.fireColumn(5)).toEqual([{ row: 1, col: 5, velocity: expect.closeTo(0.9) }]);
    f.togglePin(16 + 5);
    f.planBar(fireThreshold(0.5), 0.5, ALL);
    expect(f.fireColumn(5)).toEqual([]);
  });

  it('busier density fires on less charge', () => {
    expect(fireThreshold(1)).toBeLessThan(fireThreshold(0.5));
    expect(fireThreshold(0)).toBeGreaterThan(fireThreshold(0.5));
  });
});
