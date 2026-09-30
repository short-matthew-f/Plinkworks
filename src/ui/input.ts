// Table input: one finger places and moves, two fingers adjust.
// Drag to move, two-finger twist to rotate, drag a segment's endpoint to stretch it,
// long-press for settings, tap the floor to pin or unpin a drum cell.
import { isSegment, segmentEnds, setSegmentEnds, TABLE_H, TABLE_W, type Part } from '../model/machine';
import { DrumFloor } from '../sim/floor';
import { distToSegment } from '../sim/sim';
import { HANDLE_RADIUS, partHitRadius } from '../render/renderer';
import type { App } from './app';

type Gesture =
  | { kind: 'drag'; part: Part; dx: number; dy: number; moved: boolean }
  | { kind: 'handle'; part: Part & { length: number }; end: 0 | 1 }
  | { kind: 'twist'; part: Part; a0: number; angle0: number }
  | { kind: 'tap'; x: number; y: number };

const LONG_PRESS_MS = 450;
const MOVE_SLOP = 7;

const clampX = (x: number) => Math.max(0.1, Math.min(TABLE_W - 0.1, x));
const clampY = (y: number) => Math.max(0.1, Math.min(TABLE_H - 0.1, y));

export class Input {
  private pointers = new Map<number, { x: number; y: number; x0: number; y0: number }>();
  private g: Gesture | null = null;
  private longTimer = 0;
  private longFired = false;

  constructor(private app: App) {
    const c = app.renderer.canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('pointercancel', (e) => this.cancel(e));
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const hit = this.hit(e.offsetX, e.offsetY);
      if (hit) app.openSettings(hit.part);
    });
    c.addEventListener('dblclick', (e) => {
      const hit = this.hit(e.offsetX, e.offsetY);
      if (hit) app.openSettings(hit.part);
    });
    c.addEventListener('wheel', (e) => {
      const p = this.hit(e.offsetX, e.offsetY)?.part ?? app.part(app.selected);
      if (!p) return;
      e.preventDefault();
      p.angle += e.deltaY * 0.003;
      app.changed(p);
    }, { passive: false });
  }

  private world(sx: number, sy: number): { x: number; y: number } {
    const v = this.app.renderer.view;
    return { x: v.wx(sx), y: v.wy(sy) };
  }

  /** Topmost part (or selected segment endpoint) under a screen point. */
  hit(sx: number, sy: number): { part: Part; end?: 0 | 1 } | null {
    const w = this.world(sx, sy);
    const sel = this.app.part(this.app.selected);
    if (sel && isSegment(sel)) {
      const ends = segmentEnds(sel);
      for (const i of [0, 1] as const) if (Math.hypot(w.x - ends[i].x, w.y - ends[i].y) <= HANDLE_RADIUS * 1.3) return { part: sel, end: i };
    }
    const parts = this.app.machine.parts;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (isSegment(p)) {
        const [a, b] = segmentEnds(p);
        if (distToSegment(w.x, w.y, a.x, a.y, b.x, b.y) <= 0.35) return { part: p };
      } else if (Math.hypot(w.x - p.x, w.y - p.y) <= partHitRadius(p)) return { part: p };
    }
    return null;
  }

  private down(e: PointerEvent): void {
    const c = this.app.renderer.canvas;
    c.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY, x0: e.offsetX, y0: e.offsetY });
    clearTimeout(this.longTimer);

    if (this.pointers.size === 2) {
      // Second finger: twist rotates the part being dragged, or the selected part.
      const target = this.g && this.g.kind !== 'tap' ? this.g.part : this.app.part(this.app.selected);
      this.g = target ? { kind: 'twist', part: target, a0: this.pointerAngle(), angle0: target.angle } : null;
      return;
    }
    if (this.pointers.size > 2) return;

    this.longFired = false;
    const hit = this.hit(e.offsetX, e.offsetY);
    const w = this.world(e.offsetX, e.offsetY);
    if (hit && hit.end !== undefined && isSegment(hit.part)) {
      this.g = { kind: 'handle', part: hit.part, end: hit.end };
    } else if (hit) {
      this.g = { kind: 'drag', part: hit.part, dx: w.x - hit.part.x, dy: w.y - hit.part.y, moved: false };
      if (!this.app.linkFrom) this.app.selected = hit.part.id;
      this.longTimer = window.setTimeout(() => {
        if (this.g?.kind === 'drag' && !this.g.moved) {
          this.longFired = true;
          navigator.vibrate?.(10);
          this.app.openSettings(hit.part);
        }
      }, LONG_PRESS_MS);
    } else {
      this.g = { kind: 'tap', x: w.x, y: w.y };
    }
  }

  private pointerAngle(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  private move(e: PointerEvent): void {
    const pt = this.pointers.get(e.pointerId);
    if (!pt) return;
    pt.x = e.offsetX;
    pt.y = e.offsetY;
    const g = this.g;
    if (!g) return;
    const w = this.world(e.offsetX, e.offsetY);
    if (g.kind === 'twist' && this.pointers.size >= 2) {
      // Screen y points down, table y points up: screen rotation is negated.
      g.part.angle = g.angle0 - (this.pointerAngle() - g.a0);
      this.app.changed(g.part);
    } else if (g.kind === 'drag') {
      if (!g.moved && Math.hypot(pt.x - pt.x0, pt.y - pt.y0) < MOVE_SLOP) return;
      g.moved = true;
      clearTimeout(this.longTimer);
      g.part.x = clampX(w.x - g.dx);
      g.part.y = clampY(w.y - g.dy);
      this.app.changed(g.part);
    } else if (g.kind === 'handle') {
      const p = g.part as Part;
      if (!isSegment(p)) return;
      const ends = segmentEnds(p);
      ends[g.end] = { x: clampX(w.x), y: clampY(w.y) };
      setSegmentEnds(p, ends[0], ends[1]);
      this.app.changed(p);
    }
  }

  private up(e: PointerEvent): void {
    const pt = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    clearTimeout(this.longTimer);
    const g = this.g;
    if (!g || !pt) return;
    if (g.kind === 'twist') {
      // Lifting one finger ends the twist; don't let the remaining finger snap into a drag.
      if (this.pointers.size === 0) this.g = null;
      return;
    }
    this.g = null;
    const tapped = Math.hypot(pt.x - pt.x0, pt.y - pt.y0) < MOVE_SLOP;
    if (g.kind === 'drag' && !g.moved && !this.longFired && this.app.linkFrom) {
      this.app.finishLink(g.part);
    } else if (g.kind === 'tap' && tapped) {
      if (this.app.linkFrom) {
        this.app.linkFrom = null;
        this.app.updateBanner();
      } else if (this.app.selected) {
        this.app.selected = null;
      } else if (this.app.showGrid) {
        this.app.togglePin(DrumFloor.cellAt(g.x, g.y));
      }
    }
  }

  private cancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    clearTimeout(this.longTimer);
    if (this.pointers.size === 0) this.g = null;
  }
}
