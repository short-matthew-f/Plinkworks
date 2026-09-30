// Canvas 2D renderer. Dark table, balls glowing in their degree color, rings that pulse when a note
// actually plays (not at impact), and floor cells that glow and fade with their charge.
import {
  FLOOR_COLS, FLOOR_ROWS, TABLE_H, TABLE_W, DRUM_ROWS, segmentEnds, isSegment, createPart,
  type Machine, type Part, type PartType,
} from '../model/machine';
import { BALL_RADIUS, bandStep, degreeHue, mod, scaleSize } from '../model/music';
import { CHORDS_PER_SECTION, type ChordSpan } from '../model/harmony';
import { PART_RADIUS, TRANSPOSER_DEPTH, GATE_THICKNESS, type Sim } from '../sim/sim';

export type Flash =
  | { kind: 'ring'; time: number; x: number; y: number; hue: number; strength: number; partId?: string }
  | { kind: 'cell'; time: number; cell: number; strength: number }
  | { kind: 'link'; time: number; from: string; to: string };

const FLASH_LIFE = 0.55;

export class View {
  scale = 40;
  ox = 0;
  oy = 0;
  fit(w: number, h: number): void {
    const pad = 10;
    this.scale = Math.min((w - pad * 2) / TABLE_W, (h - pad * 2) / TABLE_H);
    this.ox = (w - TABLE_W * this.scale) / 2;
    this.oy = (h - TABLE_H * this.scale) / 2;
  }
  sx(x: number): number { return this.ox + x * this.scale; }
  sy(y: number): number { return this.oy + (TABLE_H - y) * this.scale; }
  wx(sx: number): number { return (sx - this.ox) / this.scale; }
  wy(sy: number): number { return TABLE_H - (sy - this.oy) / this.scale; }
}

export interface RenderState {
  sim: Sim;
  machine: Machine;
  audioTime: number;
  audioBeat: number;
  playing: boolean;
  selected: string | null;
  linkFrom: string | null;
  showGrid: boolean;
  ghost: Part | null;
  /** The chord sounding now (conductor on), for the progression display. */
  chord: ChordSpan | null;
}

function hsl(h: number, s: number, l: number, a = 1): string {
  return `hsla(${h.toFixed(0)}, ${s}%, ${l}%, ${a})`;
}

/** The pitch-carrying hue of a part, if it has one. */
export function partHue(p: Part, m: Machine): number | null {
  const n = scaleSize(m.scale);
  switch (p.type) {
    case 'bumper': case 'chime': case 'rail': return degreeHue(mod(p.step, n));
    case 'band': return degreeHue(mod(bandStep(p.length, m.scale), n));
    case 'spawner': return p.noteMode === 'random' ? null : degreeHue(mod(p.degree, n));
    default: return null;
  }
}

export class Renderer {
  readonly view = new View();
  private ctx: CanvasRenderingContext2D;
  private flashes: Flash[] = [];
  private w = 0;
  private h = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const r = this.canvas.getBoundingClientRect();
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.view.fit(r.width, r.height);
  }

  flash(f: Flash): void { this.flashes.push(f); }
  clearFlashes(): void { this.flashes = []; }

  draw(s: RenderState): void {
    const { ctx, view: v } = this;
    const now = s.audioTime;
    this.flashes = this.flashes.filter((f) => now - f.time < FLASH_LIFE);
    ctx.clearRect(0, 0, this.w, this.h);

    // Table.
    const tx = v.sx(0), ty = v.sy(TABLE_H), tw = TABLE_W * v.scale, th = TABLE_H * v.scale;
    ctx.fillStyle = '#12141c';
    ctx.fillRect(tx, ty, tw, th);

    this.drawFloor(s, now);
    if (s.chord) this.drawChord(s.chord, s.audioBeat);

    ctx.strokeStyle = '#2a2f3d';
    ctx.lineWidth = 2;
    ctx.strokeRect(tx - 1, ty - 1, tw + 2, th + 2);

    // Links draw as faint wires and pulse when they fire.
    const byId = new Map(s.machine.parts.map((p) => [p.id, p]));
    for (const p of s.machine.parts) {
      for (const t of p.links ?? []) {
        const q = byId.get(t);
        if (!q) continue;
        const pulse = this.pulse(now, (f) => f.kind === 'link' && f.from === p.id && f.to === t);
        ctx.strokeStyle = `rgba(160, 200, 255, ${0.18 + 0.7 * pulse})`;
        ctx.lineWidth = 1 + 2 * pulse;
        ctx.setLineDash([4, 5]);
        ctx.beginPath();
        ctx.moveTo(v.sx(p.x), v.sy(p.y));
        ctx.lineTo(v.sx(q.x), v.sy(q.y));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Which sustainers are holding notes right now.
    const active = new Map<string, number>();
    for (const b of s.sim.balls) for (const id of b.inside) active.set(id, (active.get(id) ?? 0) + 1);

    for (const p of s.machine.parts) {
      const pulse = this.pulse(now, (f) => f.kind === 'ring' && f.partId === p.id);
      this.drawPart(p, s, pulse, active.get(p.id) ?? 0, p.id === s.selected, p.id === s.linkFrom);
    }
    if (s.ghost) {
      ctx.globalAlpha = 0.6;
      this.drawPart(s.ghost, s, 0, 0, true, false);
      ctx.globalAlpha = 1;
    }

    // Balls.
    for (const b of s.sim.balls) {
      const p = b.body.translation();
      const r = BALL_RADIUS[b.size] * v.scale;
      const hue = s.sim.ballHue(b);
      ctx.shadowColor = hsl(hue, 90, 60, 0.9);
      ctx.shadowBlur = r * 1.6;
      ctx.fillStyle = hsl(hue, 85, 62);
      ctx.beginPath();
      ctx.arc(v.sx(p.x), v.sy(p.y), r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(v.sx(p.x) - r * 0.3, v.sy(p.y) - r * 0.3, r * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }

    // Note rings, drawn only once the note is actually sounding.
    for (const f of this.flashes) {
      if (f.kind !== 'ring' || f.time > now) continue;
      const t = (now - f.time) / FLASH_LIFE;
      ctx.strokeStyle = hsl(f.hue, 90, 70, (1 - t) * (0.4 + 0.6 * f.strength));
      ctx.lineWidth = 2.5 * (1 - t) + 0.5;
      ctx.beginPath();
      ctx.arc(v.sx(f.x), v.sy(f.y), (0.25 + t * 0.9) * v.scale, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** Current chord, where the phrase is heading, and progress through the phrase. */
  private drawChord(c: ChordSpan, beat: number): void {
    const { ctx, view: v } = this;
    const x = v.sx(0) + 12;
    const y = v.sy(TABLE_H) + 10;
    ctx.save();
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(235,238,250,0.85)';
    ctx.font = '600 17px system-ui, sans-serif';
    ctx.fillText(c.name, x + 16, y);
    const w = ctx.measureText(c.name).width;
    ctx.fillStyle = 'rgba(160,170,200,0.7)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(c.cadence ? 'arrived' : `→ ${c.goalName}`, x + 16 + w + 8, y + 4);
    // Phrase progress: one dot per chord, the current one filling as it plays.
    const slot = c.index % CHORDS_PER_SECTION;
    const frac = Math.max(0, Math.min(1, (beat - c.startBeat) / (c.endBeat - c.startBeat)));
    for (let i = 0; i < CHORDS_PER_SECTION; i++) {
      const cx = x + 22 + i * 12;
      const cy = y + 28;
      ctx.fillStyle = i < slot ? 'rgba(143,179,255,0.8)' : 'rgba(143,179,255,0.18)';
      ctx.beginPath();
      ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
      ctx.fill();
      if (i === slot) {
        ctx.fillStyle = 'rgba(143,179,255,0.85)';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, 3.5, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.fill();
      }
    }
    // Intensity: a small vertical meter left of the chord name.
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x, y + 2, 4, 30);
    ctx.fillStyle = 'rgba(255,226,138,0.7)';
    ctx.fillRect(x, y + 2 + 30 * (1 - c.intensity), 4, 30 * c.intensity);
    ctx.restore();
  }

  private pulse(now: number, match: (f: Flash) => boolean): number {
    let best = 0;
    for (const f of this.flashes) {
      if (f.time > now || !match(f)) continue;
      best = Math.max(best, 1 - (now - f.time) / FLASH_LIFE);
    }
    return best;
  }

  private drawFloor(s: RenderState, now: number): void {
    const { ctx, view: v } = this;
    const cw = (TABLE_W / FLOOR_COLS) * v.scale;
    const ch = (TABLE_H / FLOOR_ROWS) * v.scale;
    const col = s.playing || s.audioBeat > 0 ? mod(Math.floor(s.audioBeat * 4), FLOOR_COLS) : -1;
    const hits = new Map<number, number>();
    for (const f of this.flashes) {
      if (f.kind === 'cell' && f.time <= now) hits.set(f.cell, Math.max(hits.get(f.cell) ?? 0, (1 - (now - f.time) / FLASH_LIFE) * f.strength));
    }
    const floor = s.sim.floor;
    for (let r = 0; r < FLOOR_ROWS; r++) {
      const hue = 200 + r * 18;
      for (let c = 0; c < FLOOR_COLS; c++) {
        const i = r * FLOOR_COLS + c;
        const x = v.ox + c * cw;
        const y = v.oy + (FLOOR_ROWS - 1 - r) * ch;
        const charge = floor.charge[i];
        const hit = hits.get(i) ?? 0;
        const pinned = floor.pinned[i] === 1;
        const a = (s.showGrid ? 0.22 : 0.1) * charge + (pinned && s.showGrid ? 0.14 : 0) + 0.5 * hit;
        if (a > 0.005) {
          ctx.fillStyle = hsl(hue, 70, 55, a);
          ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
        }
        if (pinned && s.showGrid) {
          ctx.strokeStyle = hsl(hue, 80, 65, 0.55);
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x + 2, y + 2, cw - 4, ch - 4);
        }
      }
    }
    if (s.showGrid) {
      ctx.strokeStyle = 'rgba(255,255,255,0.045)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 1; c < FLOOR_COLS; c++) {
        const x = Math.round(v.ox + c * cw) + 0.5;
        ctx.moveTo(x, v.oy);
        ctx.lineTo(x, v.oy + FLOOR_ROWS * ch);
      }
      for (let r = 1; r < FLOOR_ROWS; r++) {
        const y = Math.round(v.oy + r * ch) + 0.5;
        ctx.moveTo(v.ox, y);
        ctx.lineTo(v.ox + FLOOR_COLS * cw, y);
      }
      ctx.stroke();
      // Beat markers every 4 steps.
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      for (let c = 4; c < FLOOR_COLS; c += 4) {
        const x = Math.round(v.ox + c * cw) + 0.5;
        ctx.moveTo(x, v.oy);
        ctx.lineTo(x, v.oy + FLOOR_ROWS * ch);
      }
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.font = `${Math.max(8, Math.min(11, cw * 0.32))}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      for (let r = 0; r < FLOOR_ROWS; r++) {
        const label = DRUM_ROWS[r].split(' ').map((w) => w[0]).join('');
        ctx.fillText(label, v.ox + 3, v.oy + (FLOOR_ROWS - 1 - r) * ch + 3);
      }
    }
    if (col >= 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(v.ox + col * cw, v.oy, cw, FLOOR_ROWS * ch);
    }
  }

  private drawPart(p: Part, s: RenderState, pulse: number, residents: number, selected: boolean, linking: boolean): void {
    const { ctx, view: v } = this;
    const k = v.scale;
    const x = v.sx(p.x);
    const y = v.sy(p.y);
    const hue = partHue(p, s.machine);
    const col = (l: number, a = 1) => (hue === null ? `rgba(220,225,240,${a})` : hsl(hue, 70, l, a));
    ctx.save();
    if (pulse > 0 && hue !== null) {
      ctx.shadowColor = hsl(hue, 90, 65, 1);
      ctx.shadowBlur = 24 * pulse;
    }
    switch (p.type) {
      case 'spawner': {
        ctx.translate(x, y);
        ctx.rotate(-p.angle);
        ctx.fillStyle = col(55, 0.9);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0.42 * k, 0);
        ctx.lineTo(-0.28 * k, 0.32 * k);
        ctx.lineTo(-0.28 * k, -0.32 * k);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        if (hue === null) {
          ctx.rotate(p.angle);
          ctx.fillStyle = '#12141c';
          ctx.font = `bold ${0.3 * k}px system-ui`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('?', 0, 0);
        }
        break;
      }
      case 'drain': {
        const g = ctx.createRadialGradient(x, y, 0, x, y, p.radius * k);
        g.addColorStop(0, '#000');
        g.addColorStop(0.75, '#05060a');
        g.addColorStop(1, `rgba(120,140,200,${0.35 + 0.5 * pulse})`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, p.radius * k, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'bumper': {
        const r = PART_RADIUS.bumper * k * (1 + 0.12 * pulse);
        ctx.fillStyle = col(30 + 25 * pulse);
        ctx.strokeStyle = col(70);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = col(75, 0.8);
        ctx.beginPath();
        ctx.arc(x, y, r * 0.35, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'chime': {
        ctx.fillStyle = col(62 + 20 * pulse);
        ctx.beginPath();
        ctx.arc(x, y, PART_RADIUS.chime * k * (1.1 + 0.4 * pulse), 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'band': case 'rail': case 'gate': {
        const [a, b] = segmentEnds(p);
        const ax = v.sx(a.x), ay = v.sy(a.y), bx = v.sx(b.x), by = v.sy(b.y);
        if (p.type === 'band') {
          // A pulse makes the band visibly wobble.
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          const nx = -(by - ay), ny = bx - ax;
          const len = Math.hypot(nx, ny) || 1;
          const wob = Math.sin(s.audioTime * 60) * 0.12 * k * pulse;
          ctx.strokeStyle = col(60 + 15 * pulse);
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.quadraticCurveTo(mx + (nx / len) * wob, my + (ny / len) * wob, bx, by);
          ctx.stroke();
          ctx.fillStyle = '#c9cede';
          for (const [px, py] of [[ax, ay], [bx, by]]) {
            ctx.beginPath();
            ctx.arc(px, py, 0.1 * k, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (p.type === 'rail') {
          const on = residents > 0 ? 1 : 0;
          if (on && hue !== null) {
            ctx.shadowColor = hsl(hue, 90, 60);
            ctx.shadowBlur = 18;
          }
          ctx.strokeStyle = col(35 + 25 * on, 0.9);
          ctx.lineWidth = 0.22 * k;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
          ctx.shadowBlur = 0;
          ctx.strokeStyle = col(80, 0.9);
          ctx.lineWidth = 1.2;
          const nx = -(by - ay), ny = bx - ax;
          const len = Math.hypot(nx, ny) || 1;
          for (const o of [-0.05, 0.05]) {
            const vib = on ? Math.sin(s.audioTime * 90 + o * 40) * 1.2 : 0;
            ctx.beginPath();
            ctx.moveTo(ax + (nx / len) * (o * k + vib), ay + (ny / len) * (o * k + vib));
            ctx.lineTo(bx + (nx / len) * (o * k + vib), by + (ny / len) * (o * k + vib));
            ctx.stroke();
          }
        } else {
          const open = s.sim.gates.get(p.id)?.open ?? false;
          ctx.strokeStyle = open ? 'rgba(150,170,210,0.3)' : 'rgba(215,225,250,0.95)';
          ctx.lineWidth = GATE_THICKNESS * k;
          ctx.lineCap = 'butt';
          if (open) ctx.setLineDash([0.18 * k, 0.18 * k]);
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
          ctx.setLineDash([]);
          // Open-beat dots.
          const cur = mod(Math.floor(s.audioBeat), 4);
          for (let i = 0; i < 4; i++) {
            const t = 0.2 + i * 0.2;
            const px = ax + (bx - ax) * t;
            const py = ay + (by - ay) * t;
            ctx.fillStyle = p.openBeats[i] ? (i === cur && s.playing ? '#ffe28a' : '#8fb3ff') : '#394056';
            ctx.beginPath();
            ctx.arc(px, py - 0.2 * k, 0.06 * k, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        break;
      }
      case 'zone': {
        const glow = Math.min(1, residents * 0.35);
        const g = ctx.createRadialGradient(x, y, 0, x, y, p.radius * k);
        g.addColorStop(0, `rgba(150,120,255,${0.18 + 0.35 * glow})`);
        g.addColorStop(1, `rgba(90,70,200,${0.05 + 0.15 * glow})`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, p.radius * k, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(180,160,255,${0.35 + 0.4 * glow})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        break;
      }
      case 'transposer': {
        ctx.translate(x, y);
        ctx.rotate(-p.angle);
        const w = p.width * k, d = TRANSPOSER_DEPTH * k;
        ctx.fillStyle = 'rgba(120,230,190,0.1)';
        ctx.strokeStyle = 'rgba(120,230,190,0.55)';
        ctx.lineWidth = 1.5;
        ctx.fillRect(-w / 2, -d / 2, w, d);
        ctx.strokeRect(-w / 2, -d / 2, w, d);
        ctx.fillStyle = 'rgba(160,245,210,0.9)';
        ctx.font = `bold ${0.28 * k}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${p.dir > 0 ? '+' : '−'}${p.mode === 'octave' ? '8va' : '1'}`, 0, 0);
        break;
      }
    }
    ctx.restore();
    if (selected || linking) this.drawSelection(p, linking);
  }

  private drawSelection(p: Part, linking: boolean): void {
    const { ctx, view: v } = this;
    const k = v.scale;
    ctx.save();
    ctx.strokeStyle = linking ? '#8fd0ff' : 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    if (isSegment(p)) {
      const [a, b] = segmentEnds(p);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      for (const e of [a, b]) {
        ctx.beginPath();
        ctx.arc(v.sx(e.x), v.sy(e.y), HANDLE_RADIUS * k, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.arc(v.sx(p.x), v.sy(p.y), partHitRadius(p) * k + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Small icon for the parts drawer. */
  static drawIcon(canvas: HTMLCanvasElement, type: PartType, m: Machine): void {
    const r = new Renderer(canvas);
    const size = canvas.clientWidth || 48;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    r.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    r.view.scale = size / 2.4;
    r.view.ox = 0;
    r.view.oy = -(TABLE_H - 2.4) * r.view.scale;
    const iconParts: Record<PartType, Partial<Part>> = {
      spawner: { angle: -Math.PI / 2 }, drain: { radius: 0.7 }, bumper: {}, band: { length: 1.8, angle: -0.4 },
      chime: {}, rail: { length: 1.8, angle: 0.3 }, zone: { radius: 0.9 }, transposer: { width: 1.6 },
      gate: { length: 1.8, angle: 0 },
    };
    const p = { ...createPart(type, 'icon', 1.2, 1.2), ...iconParts[type] } as Part;
    const fakeSim = { balls: [], gates: new Map() } as unknown as Sim;
    r.drawPart(p, { sim: fakeSim, machine: m, audioTime: 0, audioBeat: 0, playing: false, selected: null, linkFrom: null, showGrid: false, ghost: null, chord: null }, 0, 0, false, false);
  }
}

export const HANDLE_RADIUS = 0.28;

/** Touch-friendly hit radius for a part (segments use distance to the segment instead). */
export function partHitRadius(p: Part): number {
  switch (p.type) {
    case 'bumper': return 0.55;
    case 'chime': return 0.35;
    case 'spawner': return 0.5;
    case 'drain': return Math.max(0.45, p.radius);
    case 'zone': return p.radius;
    case 'transposer': return Math.max(0.45, p.width / 2);
    default: return 0.35;
  }
}
