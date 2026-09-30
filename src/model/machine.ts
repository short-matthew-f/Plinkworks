// Machine state: everything needed to rebuild a machine (parts, settings, seed) as plain JSON.
// Saved locally in IndexedDB and shared as a compressed URL.
import { SCALE_IDS, type BallSize, type ScaleId } from './music';

export const TABLE_W = 9;
export const TABLE_H = 16;
export const FLOOR_COLS = 16;
export const FLOOR_ROWS = 8;
export const DRUM_ROWS = ['Kick', 'Snare', 'Closed hat', 'Open hat', 'Clap', 'Low tom', 'High tom', 'Perc'] as const;

export type Voice = 'kalimba' | 'mallets' | 'cello' | 'pad';
export const VOICES: readonly Voice[] = ['kalimba', 'mallets', 'cello', 'pad'];
export const VOICE_NAMES: Record<Voice, string> = { kalimba: 'Kalimba', mallets: 'Mallets', cello: 'Cello', pad: 'Warm pad' };

export type PartType =
  | 'spawner' | 'drain' | 'bumper' | 'band' | 'chime' | 'rail' | 'zone' | 'transposer' | 'gate';

interface Base { id: string; x: number; y: number; angle: number; links?: string[] }

export interface Spawner extends Base {
  type: 'spawner';
  interval: number; // beats between drops
  noteMode: 'fixed' | 'arp' | 'random';
  degree: number;
  size: BallSize;
  voice: Voice;
  speed: number; // launch speed along the spawner's facing
}
export interface Drain extends Base { type: 'drain'; radius: number; bass: boolean }
export interface Bumper extends Base { type: 'bumper'; step: number; voice: Voice; kick: number }
export interface Band extends Base { type: 'band'; length: number; voice: Voice }
export interface Chime extends Base { type: 'chime'; step: number; voice: Voice }
export interface Rail extends Base { type: 'rail'; length: number; step: number; voice: Voice }
export interface Zone extends Base { type: 'zone'; radius: number; voice: Voice }
export interface Transposer extends Base { type: 'transposer'; width: number; mode: 'degree' | 'octave'; dir: 1 | -1 }
export interface Gate extends Base { type: 'gate'; length: number; openBeats: boolean[] }

export type Part = Spawner | Drain | Bumper | Band | Chime | Rail | Zone | Transposer | Gate;

export interface Machine {
  v: 1;
  name: string;
  seed: number;
  key: number; // 0 = C
  scale: ScaleId;
  bpm: number;
  swing: number; // 0..1
  quantize: number; // 0 (raw physics) .. 1 (tight)
  reverb: number; // 0..1 send
  volume: number; // 0..1
  tilt: number; // degrees, 0 = billiards
  fadeBars: number;
  drumDensity: number; // 0 (sparse) .. 1 (busy)
  parts: Part[];
  pins: number[]; // pinned floor cell indices (row * FLOOR_COLS + col)
}

export const PART_INFO: Record<PartType, { name: string; family: string; blurb: string }> = {
  spawner: { name: 'Spawner', family: 'Flow', blurb: 'Drops a ball every few beats' },
  drain: { name: 'Drain', family: 'Flow', blurb: 'Removes balls that fall in' },
  bumper: { name: 'Bumper', family: 'Sounder', blurb: 'Kicks balls away with its note' },
  band: { name: 'Rubber band', family: 'Sounder', blurb: 'Plucked; pitch from its length' },
  chime: { name: 'Chime peg', family: 'Sounder', blurb: 'A small post with a fixed pitch' },
  rail: { name: 'Bowed rail', family: 'Sustainer', blurb: 'Holds its note while balls roll on it' },
  zone: { name: 'Resonator', family: 'Sustainer', blurb: 'Holds each resident ball’s note' },
  transposer: { name: 'Transposer', family: 'Modifier', blurb: 'Shifts ball notes passing through' },
  gate: { name: 'Beat gate', family: 'Logic', blurb: 'A wall that opens on chosen beats' },
};
export const PART_TYPES = Object.keys(PART_INFO) as PartType[];

/** Parts that can fire links, and parts that can be triggered by them (MVP set). */
export const LINK_SOURCES: readonly PartType[] = ['bumper', 'gate', 'drain'];
export const LINK_TARGETS: readonly PartType[] = ['spawner', 'gate'];

/** Segment parts (stretchable by their endpoints). */
export function isSegment(p: Part): p is Band | Rail | Gate {
  return p.type === 'band' || p.type === 'rail' || p.type === 'gate';
}

export function segmentEnds(p: Band | Rail | Gate): [{ x: number; y: number }, { x: number; y: number }] {
  const hx = (Math.cos(p.angle) * p.length) / 2;
  const hy = (Math.sin(p.angle) * p.length) / 2;
  return [{ x: p.x - hx, y: p.y - hy }, { x: p.x + hx, y: p.y + hy }];
}

export function setSegmentEnds(p: Band | Rail | Gate, a: { x: number; y: number }, b: { x: number; y: number }): void {
  p.x = (a.x + b.x) / 2;
  p.y = (a.y + b.y) / 2;
  p.length = Math.max(0.4, Math.hypot(b.x - a.x, b.y - a.y));
  p.angle = Math.atan2(b.y - a.y, b.x - a.x);
}

export function nextPartId(m: Machine): string {
  let max = 0;
  for (const p of m.parts) max = Math.max(max, Number(p.id.slice(1)) || 0);
  return `p${max + 1}`;
}

/** A new part of the given type with sensible defaults. */
export function createPart(type: PartType, id: string, x: number, y: number): Part {
  const b = { id, x, y, angle: 0 };
  switch (type) {
    case 'spawner': return { ...b, type, angle: -Math.PI / 2, interval: 2, noteMode: 'arp', degree: 0, size: 1, voice: 'kalimba', speed: 1 };
    case 'drain': return { ...b, type, radius: 0.55, bass: true };
    case 'bumper': return { ...b, type, step: 2, voice: 'mallets', kick: 3 };
    case 'band': return { ...b, type, angle: -0.25, length: 2.4, voice: 'kalimba' };
    case 'chime': return { ...b, type, step: 4, voice: 'mallets' };
    case 'rail': return { ...b, type, angle: 0.3, length: 3, step: -3, voice: 'cello' };
    case 'zone': return { ...b, type, radius: 1, voice: 'pad' };
    case 'transposer': return { ...b, type, width: 1.6, mode: 'degree', dir: 1 };
    case 'gate': return { ...b, type, length: 2.2, openBeats: [true, false, true, false] };
  }
}

export function defaultMachine(): Machine {
  const parts: Part[] = [];
  const add = (type: PartType, x: number, y: number, patch: Partial<Part> = {}) => {
    const p = { ...createPart(type, `p${parts.length + 1}`, x, y), ...patch } as Part;
    parts.push(p);
    return p;
  };
  add('spawner', 2.2, 15.2, { interval: 4, noteMode: 'arp', degree: 0, size: 1, voice: 'kalimba' } as Partial<Spawner>);
  add('spawner', 6.8, 15.2, { interval: 6, noteMode: 'random', degree: 2, size: 0, voice: 'mallets' } as Partial<Spawner>);
  // A staggered field of chime pegs: a pentatonic ladder.
  const pegRows = [[1.6, 3.4, 5.6, 7.4], [2.5, 4.5, 6.5], [1.6, 3.4, 5.6, 7.4]];
  let step = 7;
  pegRows.forEach((row, r) => row.forEach((x) => { add('chime', x, 12.6 - r * 1.1, { step: step-- } as Partial<Chime>); }));
  add('bumper', 4.5, 8.8, { step: 0 } as Partial<Bumper>);
  add('band', 2.0, 7.4, { angle: -0.35, length: 2.6 } as Partial<Band>);
  add('band', 7.0, 7.4, { angle: 0.35, length: 2.0 } as Partial<Band>);
  add('rail', 4.5, 5.6, { angle: 0, length: 3.2, step: -5 } as Partial<Rail>);
  add('zone', 7.2, 3.6, { radius: 0.95 } as Partial<Zone>);
  add('transposer', 2.2, 4.2, { width: 1.8 } as Partial<Transposer>);
  add('gate', 4.5, 2.6, { length: 2.4, angle: 0 } as Partial<Gate>);
  // A funnel steers everything into the drain.
  add('band', 1.9, 1.5, { angle: -0.42, length: 4.2 } as Partial<Band>);
  add('band', 7.1, 1.5, { angle: 0.42, length: 4.2 } as Partial<Band>);
  add('drain', 4.5, 0.55, { radius: 0.75 } as Partial<Drain>);
  return {
    v: 1,
    name: 'First machine',
    seed: 1,
    key: 0,
    scale: 'majorPent',
    bpm: 96,
    swing: 0.15,
    quantize: 1,
    reverb: 0.3,
    volume: 0.8,
    tilt: 12,
    fadeBars: 4,
    drumDensity: 0.5,
    parts,
    pins: [0, 8], // kick on beats 1 and 3
  };
}

const clamp = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;

/** Validate untrusted JSON (a shared URL or old save) into a well-formed machine; unknown parts are dropped. */
export function normalizeMachine(raw: unknown): Machine {
  const d = defaultMachine();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const parts: Part[] = [];
  const seen = new Set<string>();
  if (Array.isArray(r.parts)) {
    for (const rp of r.parts as Record<string, unknown>[]) {
      if (!rp || typeof rp !== 'object' || !PART_TYPES.includes(rp.type as PartType)) continue;
      const id = typeof rp.id === 'string' && /^p\d+$/.test(rp.id) && !seen.has(rp.id) ? rp.id : null;
      if (!id) continue;
      seen.add(id);
      const base = createPart(rp.type as PartType, id, 0, 0) as unknown as Record<string, unknown>;
      for (const k of Object.keys(base)) {
        if (k === 'type' || k === 'id') continue;
        const v = rp[k];
        if (typeof base[k] === 'number' && typeof v === 'number' && Number.isFinite(v)) base[k] = v;
        else if (typeof base[k] === 'string' && typeof v === 'string') base[k] = v;
        else if (typeof base[k] === 'boolean' && typeof v === 'boolean') base[k] = v;
        else if (Array.isArray(base[k]) && Array.isArray(v)) base[k] = v.slice(0, 4).map(Boolean);
      }
      if (Array.isArray(rp.links)) base.links = (rp.links as unknown[]).filter((l): l is string => typeof l === 'string');
      const p = base as unknown as Part;
      p.x = clamp(p.x, 0, TABLE_W, TABLE_W / 2);
      p.y = clamp(p.y, 0, TABLE_H, TABLE_H / 2);
      if ('voice' in p && !VOICES.includes(p.voice)) p.voice = 'kalimba';
      if (p.type === 'spawner') {
        p.size = clamp(p.size, 0, 2, 1) as BallSize;
        p.size = Math.round(p.size) as BallSize;
        p.interval = clamp(p.interval, 0.25, 16, 2);
        if (!['fixed', 'arp', 'random'].includes(p.noteMode)) p.noteMode = 'fixed';
      }
      if (p.type === 'gate' && p.openBeats.length !== 4) p.openBeats = [true, false, true, false];
      if (p.type === 'transposer') {
        p.dir = p.dir < 0 ? -1 : 1;
        if (p.mode !== 'octave') p.mode = 'degree';
      }
      parts.push(p);
    }
  }
  // Drop links to missing or invalid targets.
  const byId = new Map(parts.map((p) => [p.id, p]));
  for (const p of parts) {
    if (!p.links) continue;
    p.links = p.links.filter((t) => { const tp = byId.get(t); return tp && tp !== p && LINK_TARGETS.includes(tp.type); });
    if (!LINK_SOURCES.includes(p.type) || p.links.length === 0) delete p.links;
  }
  return {
    v: 1,
    name: typeof r.name === 'string' ? r.name.slice(0, 60) : d.name,
    seed: clamp(r.seed, 0, 2 ** 31, 1) | 0,
    key: clamp(r.key, 0, 11, 0) | 0,
    scale: SCALE_IDS.includes(r.scale as ScaleId) ? (r.scale as ScaleId) : d.scale,
    bpm: clamp(r.bpm, 40, 200, d.bpm),
    swing: clamp(r.swing, 0, 1, 0),
    quantize: clamp(r.quantize, 0, 1, 1),
    reverb: clamp(r.reverb, 0, 1, d.reverb),
    volume: clamp(r.volume, 0, 1, d.volume),
    tilt: clamp(r.tilt, 0, 30, d.tilt),
    fadeBars: clamp(r.fadeBars, 1, 16, 4),
    drumDensity: clamp(r.drumDensity, 0, 1, 0.5),
    parts,
    pins: Array.isArray(r.pins)
      ? [...new Set((r.pins as unknown[]).filter((c): c is number => Number.isInteger(c) && (c as number) >= 0 && (c as number) < FLOOR_COLS * FLOOR_ROWS))]
      : [],
  };
}

export function cloneMachine(m: Machine): Machine {
  return JSON.parse(JSON.stringify(m)) as Machine;
}
