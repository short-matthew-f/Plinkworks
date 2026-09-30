// The simulation: deterministic Rapier physics at a fixed 120 Hz step, pegged to musical time (beats).
// It knows nothing about audio: every contact, sustain and drum hit becomes a SimEvent at a raw beat,
// and the audio scheduler quantizes them before they sound.
import RAPIER from '@dimforge/rapier2d-deterministic-compat';
import {
  LINK_TARGETS, TABLE_H, TABLE_W, FLOOR_COLS, segmentEnds,
  type Machine, type Part, type Spawner, type Voice, type Gate,
} from '../model/machine';
import { BALL_RADIUS, bandStep, ballStep, degreeHue, scaleSize, mod, type BallSize } from '../model/music';
import { DrumFloor, fireThreshold, rowsForIntensity } from './floor';
import { Conductor } from '../model/harmony';
import { Rng } from './rng';

export const PHYS_HZ = 120;
export const DT = 1 / PHYS_HZ;
export const BALL_CAP = 24;
/** Impacts slower than this (table units per second) make no sound, so resting balls never buzz. */
export const SILENCE_SPEED = 1.0;
/** A ball cannot sound again within one grid step (a 16th). */
export const RETRIGGER_BEATS = 0.25;
/** Gravity at full tilt: tilt angle scales it by sin(tilt). */
const G = 30;

export const PART_RADIUS = { bumper: 0.42, chime: 0.12 } as const;
export const BAND_THICKNESS = 0.06;
export const GATE_THICKNESS = 0.12;
export const TRANSPOSER_DEPTH = 0.7;
const RAIL_REACH = 0.08;

export type SimVoice = Voice | 'bass';

export type SimEvent =
  | { kind: 'note'; beat: number; voice: SimVoice; step: number; velocity: number; x: number; y: number; hue: number; partId?: string }
  | { kind: 'sustainStart'; beat: number; key: string; voice: Voice; step: number; velocity: number; x: number; y: number; hue: number; partId: string }
  | { kind: 'sustainEnd'; beat: number; key: string }
  | { kind: 'drum'; step16: number; row: number; col: number; velocity: number }
  | { kind: 'link'; beat: number; from: string; to: string };

export interface Ball {
  id: number;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  degree: number;
  size: BallSize;
  voice: Voice;
  lastSound: number;
  cell: number;
  inside: Set<string>;
  vx: number; // velocity before the current step, for impact speed
  vy: number;
}

type Owner = { kind: 'ball'; ball: Ball } | { kind: 'part'; part: Part } | { kind: 'wall' };

interface SpawnerState { next: number; arp: number }
interface GateState { open: boolean; forcedUntil: number }

let ready: Promise<void> | null = null;
/** Load the Rapier WASM module once. */
export function initPhysics(): Promise<void> {
  return (ready ??= RAPIER.init());
}

export function impactVelocity(speed: number): number {
  const t = Math.min(1, Math.max(0, (speed - SILENCE_SPEED) / 7));
  return 0.18 + 0.82 * t ** 0.7;
}

export class Sim {
  machine: Machine;
  world!: RAPIER.World;
  private queue!: RAPIER.EventQueue;
  floor = new DrumFloor();
  /** Chord progression and intensity arc, shared with the audio engine. */
  conductor!: Conductor;
  rng!: Rng;
  beat = 0;
  steps = 0;
  /** Next 16th the playhead will fire (absolute count since reset). */
  step16 = 0;
  balls: Ball[] = [];
  energy = 0;
  private nextBallId = 1;
  private owners = new Map<number, Owner>();
  private partColliders = new Map<string, RAPIER.Collider[]>();
  private spawners = new Map<string, SpawnerState>();
  gates = new Map<string, GateState>();
  private railCount = new Map<string, number>();
  private events: SimEvent[] = [];

  constructor(machine: Machine) {
    this.machine = machine;
    this.build();
  }

  /** Rebuild the world from the machine definition: reset makes the song replay exactly. */
  reset(): void {
    this.world.free();
    this.queue.free();
    this.build();
  }

  replaceMachine(m: Machine): void {
    this.machine = m;
    this.reset();
  }

  private build(): void {
    const m = this.machine;
    this.world = new RAPIER.World({ x: 0, y: -G * Math.sin((m.tilt * Math.PI) / 180) });
    this.world.timestep = DT;
    this.queue = new RAPIER.EventQueue(true);
    this.owners.clear();
    this.partColliders.clear();
    this.spawners.clear();
    this.gates.clear();
    this.railCount.clear();
    this.balls = [];
    this.nextBallId = 1;
    this.beat = 0;
    this.steps = 0;
    this.step16 = 0;
    this.energy = 0;
    this.events = [];
    this.rng = new Rng(m.seed);
    this.conductor = new Conductor(m.seed);
    this.floor.clearCharge();
    this.floor.setPins(m.pins);
    // Walls on all four edges; they are sounding surfaces.
    const t = 1;
    const walls: [number, number, number, number][] = [
      [TABLE_W / 2, -t, TABLE_W / 2 + t, t],
      [TABLE_W / 2, TABLE_H + t, TABLE_W / 2 + t, t],
      [-t, TABLE_H / 2, t, TABLE_H / 2 + t],
      [TABLE_W + t, TABLE_H / 2, t, TABLE_H / 2 + t],
    ];
    for (const [x, y, hx, hy] of walls) {
      const c = this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy).setTranslation(x, y).setRestitution(0.55).setFriction(0));
      this.owners.set(c.handle, { kind: 'wall' });
    }
    for (const p of m.parts) this.addPartBody(p, 0);
  }

  setTilt(deg: number): void {
    this.machine.tilt = deg;
    this.world.gravity = { x: 0, y: -G * Math.sin((deg * Math.PI) / 180) };
    for (const b of this.balls) b.body.wakeUp();
  }

  // ---- parts ------------------------------------------------------------------------------

  private addPartBody(p: Part, atBeat: number): void {
    const cs: RAPIER.Collider[] = [];
    const make = (desc: RAPIER.ColliderDesc) => {
      const c = this.world.createCollider(desc);
      this.owners.set(c.handle, { kind: 'part', part: p });
      cs.push(c);
      return c;
    };
    switch (p.type) {
      case 'bumper':
        make(RAPIER.ColliderDesc.ball(PART_RADIUS.bumper).setTranslation(p.x, p.y).setRestitution(0.9).setFriction(0));
        break;
      case 'chime':
        make(RAPIER.ColliderDesc.ball(PART_RADIUS.chime).setTranslation(p.x, p.y).setRestitution(0.7).setFriction(0));
        break;
      case 'band':
        make(RAPIER.ColliderDesc.cuboid(p.length / 2, BAND_THICKNESS).setTranslation(p.x, p.y).setRotation(p.angle).setRestitution(1).setFriction(0));
        break;
      case 'gate': {
        const c = make(RAPIER.ColliderDesc.cuboid(p.length / 2, GATE_THICKNESS / 2).setTranslation(p.x, p.y).setRotation(p.angle).setRestitution(0.5).setFriction(0));
        const st = this.gates.get(p.id) ?? { open: false, forcedUntil: -1 };
        st.open = this.gateShouldOpen(p, st, this.beat);
        c.setEnabled(!st.open);
        this.gates.set(p.id, st);
        break;
      }
      case 'spawner':
        if (!this.spawners.has(p.id)) {
          const next = atBeat <= 0 ? 0 : Math.ceil(atBeat / p.interval) * p.interval;
          this.spawners.set(p.id, { next, arp: 0 });
        }
        break;
      default:
        break;
    }
    this.partColliders.set(p.id, cs);
  }

  private removePartBody(id: string): void {
    for (const c of this.partColliders.get(id) ?? []) {
      this.owners.delete(c.handle);
      this.world.removeCollider(c, true);
    }
    this.partColliders.delete(id);
  }

  /** Call after adding a part to machine.parts. */
  addPart(p: Part): void { this.addPartBody(p, this.beat); }

  /** Call after mutating a part in place (moved, rotated, stretched, retuned). */
  updatePart(p: Part): void {
    this.removePartBody(p.id);
    if (p.type === 'spawner') {
      const st = this.spawners.get(p.id);
      if (st && st.next > this.beat + p.interval) st.next = Math.ceil(this.beat / p.interval) * p.interval;
    }
    this.addPartBody(p, this.beat);
    for (const b of this.balls) b.body.wakeUp();
  }

  /** Call after removing a part from machine.parts. */
  removePart(id: string): void {
    this.removePartBody(id);
    this.spawners.delete(id);
    this.gates.delete(id);
    for (const b of this.balls) if (b.inside.delete(id)) this.emit({ kind: 'sustainEnd', beat: this.beat, key: `${id}:${b.id}` });
    if (this.railCount.get(id)) this.emit({ kind: 'sustainEnd', beat: this.beat, key: id });
    this.railCount.delete(id);
    for (const p of this.machine.parts) if (p.links) p.links = p.links.filter((l) => l !== id);
  }

  private part(id: string): Part | undefined {
    return this.machine.parts.find((p) => p.id === id);
  }

  // ---- balls ------------------------------------------------------------------------------

  private spawnBall(s: Spawner, beat: number): void {
    if (this.balls.length >= BALL_CAP) this.removeBall(this.balls[0], beat);
    const n = scaleSize(this.machine.scale);
    const st = this.spawners.get(s.id);
    let degree = s.degree;
    if (s.noteMode === 'arp' && st) degree = s.degree + 2 * st.arp++;
    else if (s.noteMode === 'random') degree = this.rng.int(n);
    degree = mod(degree, n);
    const dx = Math.cos(s.angle);
    const dy = Math.sin(s.angle);
    const r = BALL_RADIUS[s.size];
    const x = Math.min(TABLE_W - r, Math.max(r, s.x + dx * 0.35));
    const y = Math.min(TABLE_H - r, Math.max(r, s.y + dy * 0.35));
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y).setLinvel(dx * s.speed * 2, dy * s.speed * 2)
        .setLinearDamping(0.12).lockRotations().setCcdEnabled(true),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.ball(r).setRestitution(0.75).setFriction(0).setDensity(1)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body,
    );
    const ball: Ball = {
      id: this.nextBallId++, body, collider, degree, size: s.size, voice: s.voice,
      lastSound: -1, cell: DrumFloor.cellAt(x, y), inside: new Set(), vx: 0, vy: 0,
    };
    this.owners.set(collider.handle, { kind: 'ball', ball });
    this.balls.push(ball);
  }

  private removeBall(b: Ball, beat: number): void {
    for (const id of b.inside) {
      const p = this.part(id);
      if (p?.type === 'zone') this.emit({ kind: 'sustainEnd', beat, key: `${id}:${b.id}` });
      else if (p?.type === 'rail') this.leaveRail(id, beat);
    }
    this.owners.delete(b.collider.handle);
    this.world.removeRigidBody(b.body);
    this.balls.splice(this.balls.indexOf(b), 1);
  }

  ballStep(b: Ball): number {
    return ballStep(b.degree, b.size, this.machine.scale);
  }

  ballHue(b: Ball): number {
    return this.stepHue(b.degree);
  }

  /** Color of a pitch: the fixed wheel indexed by its scale degree. */
  stepHue(step: number): number {
    return degreeHue(mod(step, scaleSize(this.machine.scale)));
  }

  // ---- stepping ---------------------------------------------------------------------------

  private emit(e: SimEvent): void { this.events.push(e); }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  beatsPerStep(): number { return (this.machine.bpm / 60) * DT; }

  /** Run fixed steps until the simulation reaches `targetBeat`. Returns the number of steps taken. */
  advanceTo(targetBeat: number, maxSteps = PHYS_HZ): number {
    let n = 0;
    while (this.beat + this.beatsPerStep() <= targetBeat && n < maxSteps) {
      this.step();
      n++;
    }
    // Too far behind (tab was hidden): skip time rather than spiral.
    if (n === maxSteps && this.beat + this.beatsPerStep() <= targetBeat) this.beat = targetBeat;
    return n;
  }

  private gateShouldOpen(g: Gate, st: GateState, beat: number): boolean {
    return g.openBeats[mod(Math.floor(beat), 4)] || beat < st.forcedUntil;
  }

  private fireLinks(p: Part, beat: number): void {
    for (const id of p.links ?? []) {
      const t = this.part(id);
      if (!t || !LINK_TARGETS.includes(t.type)) continue;
      this.emit({ kind: 'link', beat, from: p.id, to: id });
      if (t.type === 'spawner') this.spawnBall(t, beat);
      else if (t.type === 'gate') {
        const st = this.gates.get(t.id);
        if (st) st.forcedUntil = Math.max(st.forcedUntil, beat + 1);
      }
    }
  }

  step(): void {
    const m = this.machine;
    const beat = this.beat + this.beatsPerStep();

    // Spawners drop on their beat grid (in part order, so replays are exact).
    for (const p of m.parts) {
      if (p.type !== 'spawner') continue;
      const st = this.spawners.get(p.id);
      if (!st) continue;
      while (st.next <= beat) {
        this.spawnBall(p, st.next);
        st.next += p.interval;
      }
    }

    // Beat gates open on their chosen beats; opening fires their links.
    for (const p of m.parts) {
      if (p.type !== 'gate') continue;
      const st = this.gates.get(p.id);
      if (!st) continue;
      const open = this.gateShouldOpen(p, st, beat);
      if (open !== st.open) {
        st.open = open;
        for (const c of this.partColliders.get(p.id) ?? []) c.setEnabled(!open);
        if (open) this.fireLinks(p, beat);
      }
    }

    for (const b of this.balls) {
      const v = b.body.linvel();
      b.vx = v.x;
      b.vy = v.y;
    }

    this.world.step(this.queue);
    this.beat = beat;
    this.steps++;

    this.queue.drainCollisionEvents((h1, h2, started) => {
      if (started) this.onContact(h1, h2);
    });

    this.checkZones();

    // Drum floor: fade, then fire each column the playhead crossed.
    this.floor.decay(this.beatsPerStep(), m.fadeBars);
    while (this.step16 / 4 <= this.beat) {
      const col = mod(this.step16, FLOOR_COLS);
      if (col === 0) {
        // Each bar's pattern is planned from the floor's charge, with the arc deciding which rows play.
        const bar = this.step16 / FLOOR_COLS;
        const intensity = m.chords ? this.conductor.intensityAtBar(bar, m) : 1;
        this.floor.planBar(fireThreshold(m.drumDensity), m.drumDensity, rowsForIntensity(intensity));
      }
      for (const h of this.floor.fireColumn(col)) this.emit({ kind: 'drum', step16: this.step16, ...h });
      this.step16++;
    }

    let e = 0;
    for (const b of this.balls) {
      const v = b.body.linvel();
      e += 0.5 * (v.x * v.x + v.y * v.y);
    }
    this.energy = e;
  }

  private canSound(b: Ball): boolean {
    return this.beat - b.lastSound >= RETRIGGER_BEATS || b.lastSound < 0;
  }

  private impactSpeed(a: Ball, bVel: { x: number; y: number }, c1: RAPIER.Collider, c2: RAPIER.Collider): number {
    const rx = a.vx - bVel.x;
    const ry = a.vy - bVel.y;
    let n: { x: number; y: number } | null = null;
    this.world.contactPair(c1, c2, (manifold) => { n = manifold.normal(); });
    const nn = n as { x: number; y: number } | null;
    if (nn && (nn.x !== 0 || nn.y !== 0)) return Math.abs(rx * nn.x + ry * nn.y);
    return Math.hypot(rx, ry) * 0.7;
  }

  private onContact(h1: number, h2: number): void {
    let o1 = this.owners.get(h1);
    let o2 = this.owners.get(h2);
    if (!o1 || !o2) return;
    if (o1.kind !== 'ball') [o1, o2] = [o2, o1];
    if (o1.kind !== 'ball') return;
    const a = o1.ball;
    const pos = a.body.translation();
    const beat = this.beat;

    if (o2.kind === 'ball') {
      // Ball hits ball: both notes play together as a dyad.
      const b = o2.ball;
      const speed = this.impactSpeed(a, { x: b.vx, y: b.vy }, a.collider, b.collider);
      if (speed < SILENCE_SPEED) return;
      const vel = impactVelocity(speed) * 0.7; // ball-on-ball clicks sit under the melody
      const pb = b.body.translation();
      for (const [ball, p] of [[a, pos], [b, pb]] as const) {
        if (!this.canSound(ball)) continue;
        ball.lastSound = beat;
        this.emit({ kind: 'note', beat, voice: ball.voice, step: this.ballStep(ball), velocity: vel, x: p.x, y: p.y, hue: this.ballHue(ball) });
      }
      return;
    }

    const other = o2.kind === 'part' ? this.partColliders.get(o2.part.id)?.[0] : undefined;
    const c2 = o2.kind === 'wall' ? this.world.getCollider(h1 === a.collider.handle ? h2 : h1) : other;
    const speed = c2 ? this.impactSpeed(a, { x: 0, y: 0 }, a.collider, c2) : Math.hypot(a.vx, a.vy);

    if (o2.kind === 'part' && o2.part.type === 'bumper') {
      // Bumpers kick balls away regardless of whether they sound.
      const p = o2.part;
      const dx = pos.x - p.x;
      const dy = pos.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      const v = a.body.linvel();
      a.body.setLinvel({ x: v.x + (dx / d) * p.kick, y: v.y + (dy / d) * p.kick }, true);
    }

    if (speed < SILENCE_SPEED || !this.canSound(a)) return;
    a.lastSound = beat;
    const vel = impactVelocity(speed);
    if (o2.kind === 'wall' || (o2.kind === 'part' && o2.part.type === 'gate')) {
      this.emit({ kind: 'note', beat, voice: a.voice, step: this.ballStep(a), velocity: vel, x: pos.x, y: pos.y, hue: this.ballHue(a) });
      return;
    }
    const p = (o2 as { part: Part }).part;
    if (p.type === 'bumper' || p.type === 'chime') {
      this.emit({ kind: 'note', beat, voice: p.voice, step: p.step, velocity: vel, x: p.x, y: p.y, hue: this.stepHue(p.step), partId: p.id });
      if (p.type === 'bumper') this.fireLinks(p, beat);
    } else if (p.type === 'band') {
      const step = bandStep(p.length, this.machine.scale);
      this.emit({ kind: 'note', beat, voice: p.voice, step, velocity: vel, x: pos.x, y: pos.y, hue: this.stepHue(step), partId: p.id });
    }
  }

  private leaveRail(id: string, beat: number): void {
    const n = (this.railCount.get(id) ?? 1) - 1;
    this.railCount.set(id, n);
    if (n <= 0) {
      this.railCount.delete(id);
      this.emit({ kind: 'sustainEnd', beat, key: id });
    }
  }

  /** Geometric (non-colliding) parts: floor cells, drains, transposers, rails and resonator zones. */
  private checkZones(): void {
    const beat = this.beat;
    const parts = this.machine.parts;
    for (const b of [...this.balls]) {
      const pos = b.body.translation();
      const r = BALL_RADIUS[b.size];
      if (pos.x < -2 || pos.y < -2 || pos.x > TABLE_W + 2 || pos.y > TABLE_H + 2) {
        this.removeBall(b, beat);
        continue;
      }
      const v = b.body.linvel();
      const speed = Math.hypot(v.x, v.y);
      const cell = DrumFloor.cellAt(pos.x, pos.y);
      if (cell !== b.cell) {
        this.floor.chargeCell(cell, speed);
        b.cell = cell;
      }
      let drained = false;
      for (const p of parts) {
        const was = b.inside.has(p.id);
        let now = false;
        switch (p.type) {
          case 'drain':
            if (Math.hypot(pos.x - p.x, pos.y - p.y) <= p.radius) {
              if (p.bass) {
                this.emit({ kind: 'note', beat, voice: 'bass', step: -2 * scaleSize(this.machine.scale), velocity: 0.8, x: p.x, y: p.y, hue: this.stepHue(0), partId: p.id });
              }
              this.fireLinks(p, beat);
              this.removeBall(b, beat);
              drained = true;
            }
            break;
          case 'transposer': {
            const dx = pos.x - p.x;
            const dy = pos.y - p.y;
            const c = Math.cos(-p.angle);
            const s = Math.sin(-p.angle);
            const lx = dx * c - dy * s;
            const ly = dx * s + dy * c;
            now = Math.abs(lx) <= p.width / 2 && Math.abs(ly) <= TRANSPOSER_DEPTH / 2;
            if (now && !was) this.transpose(b, p.mode, p.dir);
            break;
          }
          case 'rail': {
            const [e1, e2] = segmentEnds(p);
            now = distToSegment(pos.x, pos.y, e1.x, e1.y, e2.x, e2.y) <= r + RAIL_REACH;
            if (now && !was) {
              const n = (this.railCount.get(p.id) ?? 0) + 1;
              this.railCount.set(p.id, n);
              // Speed is bow pressure.
              if (n === 1) {
                this.emit({ kind: 'sustainStart', beat, key: p.id, voice: p.voice, step: p.step, velocity: 0.35 + 0.65 * Math.min(1, speed / 6), x: pos.x, y: pos.y, hue: this.stepHue(p.step), partId: p.id });
              }
            } else if (!now && was) this.leaveRail(p.id, beat);
            break;
          }
          case 'zone':
            now = Math.hypot(pos.x - p.x, pos.y - p.y) <= p.radius;
            if (now && !was) {
              this.emit({ kind: 'sustainStart', beat, key: `${p.id}:${b.id}`, voice: p.voice, step: this.ballStep(b), velocity: 0.6, x: pos.x, y: pos.y, hue: this.ballHue(b), partId: p.id });
            } else if (!now && was) this.emit({ kind: 'sustainEnd', beat, key: `${p.id}:${b.id}` });
            break;
          default:
            break;
        }
        if (drained) break;
        if (now) b.inside.add(p.id);
        else b.inside.delete(p.id);
      }
    }
  }

  private transpose(b: Ball, mode: 'degree' | 'octave', dir: 1 | -1): void {
    const n = scaleSize(this.machine.scale);
    let size = b.size as number;
    if (mode === 'octave') size -= dir;
    else {
      const d = mod(b.degree, n) + dir;
      // Wrapping past the top degree carries into the next octave up (a smaller ball), when there is one.
      if (d >= n) { b.degree = 0; size -= 1; } else if (d < 0) { b.degree = n - 1; size += 1; } else b.degree = d;
    }
    size = Math.max(0, Math.min(2, size));
    if (size !== b.size) {
      b.size = size as BallSize;
      b.collider.setRadius(BALL_RADIUS[b.size]);
    }
  }
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}
