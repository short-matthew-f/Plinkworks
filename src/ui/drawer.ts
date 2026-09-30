// Parts drawer: a bottom sheet (swipe up to open). Drag a part onto the table to place it, or tap to drop
// it in the middle.
import { createPart, nextPartId, PART_INFO, PART_TYPES, TABLE_H, TABLE_W, type PartType } from '../model/machine';
import { Renderer } from '../render/renderer';
import type { App } from './app';
import { $, el } from './dom';

export class Drawer {
  private root = $('#drawer');

  constructor(private app: App) {
    this.bindHandle();
    const grid = $('#drawer-parts');
    for (const type of PART_TYPES) {
      const icon = el('canvas');
      const tile = el('div', { className: 'part-tile' }, icon, el('b', {}, PART_INFO[type].name), el('small', {}, PART_INFO[type].blurb));
      tile.setAttribute('role', 'button');
      tile.setAttribute('aria-label', `Add ${PART_INFO[type].name}`);
      grid.append(tile);
      requestAnimationFrame(() => Renderer.drawIcon(icon, type, app.machine));
      this.bindTile(tile, type);
    }
  }

  private isDesktop(): boolean {
    return matchMedia('(min-width: 900px)').matches;
  }

  setOpen(open: boolean): void {
    this.root.classList.toggle('open', open);
  }

  private bindHandle(): void {
    const h = $('#drawer-handle');
    let y0 = 0;
    let active = false;
    h.addEventListener('pointerdown', (e) => { y0 = e.clientY; active = true; h.setPointerCapture(e.pointerId); });
    h.addEventListener('pointerup', (e) => {
      if (!active) return;
      active = false;
      const dy = e.clientY - y0;
      if (dy < -20) this.setOpen(true);
      else if (dy > 20) this.setOpen(false);
      else this.setOpen(!this.root.classList.contains('open'));
    });
  }

  private bindTile(tile: HTMLElement, type: PartType): void {
    const app = this.app;
    let start: { x: number; y: number } | null = null;
    let dragging = false;
    const overTable = (e: PointerEvent) => {
      const r = app.renderer.canvas.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      if (sx < 0 || sy < 0 || sx > r.width || sy > r.height) return null;
      const x = app.renderer.view.wx(sx);
      const y = app.renderer.view.wy(sy);
      return x >= 0 && y >= 0 && x <= TABLE_W && y <= TABLE_H ? { x, y } : null;
    };
    tile.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, y: e.clientY };
      dragging = false;
      tile.setPointerCapture(e.pointerId);
    });
    tile.addEventListener('pointermove', (e) => {
      if (!start) return;
      if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) {
        dragging = true;
        if (!this.isDesktop()) this.setOpen(false);
      }
      if (!dragging) return;
      const w = overTable(e);
      // Lift the ghost above the finger so it isn't hidden under it.
      const lift = e.pointerType === 'touch' ? 0.9 : 0;
      app.ghost = w ? createPart(type, 'ghost', w.x, Math.min(TABLE_H - 0.2, w.y + lift)) : null;
    });
    const finish = (e: PointerEvent, cancelled: boolean) => {
      if (!start) return;
      start = null;
      const ghost = app.ghost;
      app.ghost = null;
      if (cancelled) return;
      if (dragging) {
        if (ghost && overTable(e)) app.addPart({ ...ghost, id: nextPartId(app.machine) });
      } else {
        // Tap: drop it in the middle of the table.
        app.addPart(createPart(type, nextPartId(app.machine), TABLE_W / 2, TABLE_H / 2));
        if (!this.isDesktop()) this.setOpen(false);
      }
    };
    tile.addEventListener('pointerup', (e) => finish(e, false));
    tile.addEventListener('pointercancel', (e) => finish(e, true));
  }
}
