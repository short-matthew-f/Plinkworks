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
/** Firing spends charge, so a cell keeps hitting only while balls keep feeding it. */
export const FIRE_COST = 0.5;

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

  clearCharge(): void { this.charge.fill(0); }

  /** Hits for one playhead column: pinned cells at full velocity, charged cells at their charge. */
  fireColumn(col: number, threshold = fireThreshold(0.5)): DrumHit[] {
    const hits: DrumHit[] = [];
    for (let row = 0; row < FLOOR_ROWS; row++) {
      const i = row * FLOOR_COLS + col;
      if (this.pinned[i]) hits.push({ row, col, velocity: 1 });
      else if (this.charge[i] >= threshold) {
        hits.push({ row, col, velocity: this.charge[i] });
        this.charge[i] = Math.max(0, this.charge[i] - FIRE_COST);
      }
    }
    return hits;
  }
}
