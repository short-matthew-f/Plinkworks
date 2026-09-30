// The drum floor: ball traffic charges cells, a playhead sweeping once per bar fires charged cells as drum hits.
import { FLOOR_COLS, FLOOR_ROWS, TABLE_H, TABLE_W } from '../model/machine';

export const CELL_COUNT = FLOOR_COLS * FLOOR_ROWS;
/**
 * Charge a cell needs to fire, from the machine's drum density (0 = sparse, 1 = busy).
 * At the default (0.5) a single pass is not enough; steady traffic is.
 */
export function fireThreshold(density: number): number {
  return 0.2 + 0.6 * (1 - Math.max(0, Math.min(1, density)));
}
/**
 * Most hits each row may play per bar, before density scaling. Rows bottom to top:
 * kick, snare (rim), closed hat (shaker), open hat, clap (snap), low tom, high tom, perc.
 */
export const ROW_CAPS = [3, 2, 6, 1, 1, 1, 1, 2];

/**
 * Which rows the arc lets in at a given intensity: a quiet section is kick and shaker,
 * the peak is the whole kit.
 */
export function rowsForIntensity(intensity: number): boolean[] {
  const on = [0, 2];
  if (intensity >= 0.35) on.push(1, 7);
  if (intensity >= 0.6) on.push(3, 5, 6);
  if (intensity >= 0.8) on.push(4);
  return Array.from({ length: FLOOR_ROWS }, (_, r) => on.includes(r));
}

export interface DrumHit { row: number; col: number; velocity: number }

export class DrumFloor {
  readonly charge = new Float32Array(CELL_COUNT);
  readonly pinned = new Uint8Array(CELL_COUNT);

  /** Cell index under a table point; rows count up from the bottom (row 0 = kick). */
  static cellAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= TABLE_W || y >= TABLE_H) return -1;
    const col = Math.min(FLOOR_COLS - 1, Math.floor((x / TABLE_W) * FLOOR_COLS));
    const row = Math.min(FLOOR_ROWS - 1, Math.floor((y / TABLE_H) * FLOOR_ROWS));
    return row * FLOOR_COLS + col;
  }

  /** A ball entering a cell charges it; faster balls charge harder (and the cell hits louder). */
  chargeCell(cell: number, speed: number): void {
    if (cell < 0) return;
    this.charge[cell] = Math.min(1, this.charge[cell] + 0.08 + 0.17 * Math.min(1, speed / 7));
  }

  /** Charge fades linearly to zero over `fadeBars` bars. */
  decay(beats: number, fadeBars: number): void {
    const d = beats / (fadeBars * 4);
    for (let i = 0; i < CELL_COUNT; i++) if (this.charge[i] > 0) this.charge[i] = Math.max(0, this.charge[i] - d);
  }

  togglePin(cell: number): void {
    if (cell >= 0 && cell < CELL_COUNT) this.pinned[cell] = this.pinned[cell] ? 0 : 1;
  }

  setPins(cells: readonly number[]): void {
    this.pinned.fill(0);
    for (const c of cells) if (c >= 0 && c < CELL_COUNT) this.pinned[c] = 1;
  }

  pins(): number[] {
    const out: number[] = [];
    for (let i = 0; i < CELL_COUNT; i++) if (this.pinned[i]) out.push(i);
    return out;
  }

  clearCharge(): void {
    this.charge.fill(0);
    this.plan.fill(0);
  }

  /** The pattern for the current bar: velocity per cell (0 = silent). */
  readonly plan = new Float32Array(CELL_COUNT);

  /**
   * Plan the next bar. Each row plays only its most-charged cells (up to its cap), so the beat is a loop
   * that repeats and slowly morphs as ball traffic shifts, instead of every charged cell firing at once.
   * Pinned cells always play.
   */
  planBar(threshold: number, density: number, rows: readonly boolean[]): void {
    this.plan.fill(0);
    const scale = 0.5 + Math.max(0, Math.min(1, density));
    for (let row = 0; row < FLOOR_ROWS; row++) {
      const cap = rows[row] ? Math.round(ROW_CAPS[row] * scale) : 0;
      const cells: number[] = [];
      for (let col = 0; col < FLOOR_COLS; col++) {
        const i = row * FLOOR_COLS + col;
        if (this.charge[i] >= threshold) cells.push(i);
      }
      cells.sort((a, b) => this.charge[b] - this.charge[a] || a - b);
      for (const i of cells.slice(0, cap)) this.plan[i] = 0.3 + 0.5 * this.charge[i];
    }
    for (let i = 0; i < CELL_COUNT; i++) if (this.pinned[i]) this.plan[i] = 0.9;
  }

  /** Hits for one playhead column, from the current bar's plan. */
  fireColumn(col: number): DrumHit[] {
    const hits: DrumHit[] = [];
    for (let row = 0; row < FLOOR_ROWS; row++) {
      const v = this.plan[row * FLOOR_COLS + col];
      if (v > 0) hits.push({ row, col, velocity: v });
    }
    return hits;
  }
}
