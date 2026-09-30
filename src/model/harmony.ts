// The conductor: a slowly moving chord progression with goals, and an intensity arc.
//
// Chords group into 4-chord phrases ("sections"). Each section walks toward a goal chord and lands on it
// (a cadence); the goal shifts from section to section — home, away to the relative minor / IV / V,
// and back home — so the music keeps heading somewhere. An intensity arc rises and falls over several
// sections and decides how much of the band plays. Everything is a pure function of the seed and the
// bar, so replays are exact.
import { Rng } from '../sim/rng';
import { KEY_NAMES, mod, type ScaleId } from './music';

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

export type Mode = 'major' | 'minor';
export function modeOf(scale: ScaleId): Mode {
  return scale === 'minor' || scale === 'minorPent' ? 'minor' : 'major';
}

/** Weighted next-chord choices by scale degree (0 = I / i). Diminished chords are left out. */
const WALK: Record<Mode, Record<number, [number, number][]>> = {
  major: {
    0: [[3, 3], [5, 3], [1, 2], [4, 2], [2, 1]],
    1: [[4, 4], [3, 1], [5, 1]],
    2: [[5, 3], [3, 2]],
    3: [[0, 3], [4, 2], [1, 2], [5, 1]],
    4: [[0, 4], [5, 2], [3, 1]],
    5: [[3, 3], [1, 3], [4, 1], [2, 1]],
  },
  minor: {
    0: [[5, 3], [3, 3], [6, 2], [2, 2]],
    2: [[5, 2], [6, 2], [3, 2]],
    3: [[0, 2], [6, 3], [4, 2]],
    4: [[0, 3], [5, 2]],
    5: [[6, 3], [2, 2], [3, 2]],
    6: [[0, 3], [2, 3]],
  },
};

/** Goals a section can resolve to, with weights; home is favored. */
const GOALS: Record<Mode, [number, number][]> = {
  major: [[0, 3], [5, 2], [3, 2], [4, 1]],
  minor: [[0, 3], [2, 2], [5, 2], [6, 1]],
};

/** Chords that lead well into each goal. */
const APPROACH: Record<Mode, Record<number, number[]>> = {
  major: { 0: [4, 3], 5: [4, 2], 3: [0, 5], 4: [1, 3] },
  minor: { 0: [4, 6, 3], 2: [6, 5], 5: [3, 2], 6: [3, 5] },
};

/** The intensity arc over sections, before jitter: rise to a peak, then breathe. */
const ARC = [0.25, 0.45, 0.65, 0.85, 0.6, 0.4];

export const CHORDS_PER_SECTION = 4;

interface SectionPlan { chords: { degree: number; seventh: boolean }[]; goal: number; intensity: number }

function pick(rng: Rng, opts: [number, number][]): number {
  const total = opts.reduce((a, [, w]) => a + w, 0);
  let r = rng.next() * total;
  for (const [v, w] of opts) if ((r -= w) < 0) return v;
  return opts[opts.length - 1][0];
}

export interface ChordSpan {
  index: number; // chord number since the start
  section: number;
  startBeat: number;
  endBeat: number;
  degree: number;
  /** Chord tones as semitones above the key root, ascending (root first). */
  tones: number[];
  /** Absolute pitch classes (0 = C) of the chord tones. */
  pcs: number[];
  rootPc: number;
  name: string;
  goalName: string;
  /** The last chord of its section: the goal being reached. */
  cadence: boolean;
  intensity: number;
}

export interface HarmonySettings { key: number; scale: ScaleId; chordBars: number }

export class Conductor {
  private plans: Record<Mode, SectionPlan[]> = { major: [], minor: [] };
  private rngs: Record<Mode, Rng>;

  constructor(readonly seed: number) {
    this.rngs = { major: new Rng(seed ^ 0x5bd1e995), minor: new Rng(seed ^ 0x27d4eb2f) };
  }

  private section(mode: Mode, i: number): SectionPlan {
    const plans = this.plans[mode];
    while (plans.length <= i) plans.push(this.makeSection(mode, plans.length, plans[plans.length - 1]));
    return plans[i];
  }

  private makeSection(mode: Mode, i: number, prev: SectionPlan | undefined): SectionPlan {
    const rng = this.rngs[mode];
    const walk = WALK[mode];
    const prevGoal = prev?.goal ?? 0;
    // Goals shift slowly: never the same twice running, and home again after two excursions.
    const awayRun = prev && prev.goal !== 0 && i >= 2 && this.plans[mode][i - 2]?.goal !== 0;
    const goal = i === 0 ? 0 : awayRun ? 0 : pick(rng, GOALS[mode].filter(([g]) => g !== prevGoal));
    const step = (from: number, avoid: number[]) => {
      const opts = (walk[from] ?? walk[0]).filter(([d]) => !avoid.includes(d));
      return opts.length ? pick(rng, opts) : (walk[from] ?? walk[0])[0][0];
    };
    const approach = APPROACH[mode][goal];
    const c0 = i === 0 ? 0 : step(prevGoal, [prevGoal]);
    const c2opts = approach.filter((d) => d !== goal);
    const c2 = c2opts[rng.int(c2opts.length)];
    const c1 = step(c0, [c0, c2, goal]);
    const degrees = [c0, c1, c2, goal];
    const isDominant = (d: number) => d === 4;
    const chords = degrees.map((degree, k) => ({
      degree,
      // Sevenths color the non-home chords; the dominant always gets its 7th to pull toward the goal.
      seventh: isDominant(degree) ? k === 2 : degree !== 0 && rng.next() < 0.55,
    }));
    const jitter = (rng.next() - 0.5) * 0.2;
    const intensity = Math.max(0.1, Math.min(1, ARC[i % ARC.length] + jitter));
    return { chords, goal, intensity };
  }

  /** The chord sounding at a beat (4/4, chords last `chordBars` bars). */
  chordAt(beat: number, h: HarmonySettings): ChordSpan {
    const mode = modeOf(h.scale);
    const chordBeats = 4 * h.chordBars;
    const index = Math.max(0, Math.floor(beat / chordBeats));
    const sectionIndex = Math.floor(index / CHORDS_PER_SECTION);
    const plan = this.section(mode, sectionIndex);
    const slot = index % CHORDS_PER_SECTION;
    const { degree, seventh } = plan.chords[slot];
    const tones = chordTones(degree, seventh, mode);
    const pcs = tones.map((t) => mod(h.key + t, 12));
    return {
      index,
      section: sectionIndex,
      startBeat: index * chordBeats,
      endBeat: (index + 1) * chordBeats,
      degree,
      tones,
      pcs,
      rootPc: pcs[0],
      name: chordName(tones, h.key),
      goalName: chordName(chordTones(plan.goal, false, mode), h.key),
      cadence: slot === CHORDS_PER_SECTION - 1,
      intensity: plan.intensity,
    };
  }

  /** Section intensity for a bar (0..1). */
  intensityAtBar(bar: number, h: HarmonySettings): number {
    return this.chordAt(bar * 4, h).intensity;
  }
}

/** Stack thirds inside the parent major / natural-minor scale. */
export function chordTones(degree: number, seventh: boolean, mode: Mode): number[] {
  const parent = mode === 'major' ? MAJOR : MINOR;
  const ks = seventh ? [0, 2, 4, 6] : [0, 2, 4];
  return ks.map((k) => {
    const d = degree + k;
    return parent[d % 7] + 12 * Math.floor(d / 7);
  });
}

export function chordName(tones: number[], key: number): string {
  const root = KEY_NAMES[mod(key + tones[0], 12)];
  const third = tones[1] - tones[0];
  const fifth = tones[2] - tones[0];
  const sev = tones.length > 3 ? tones[3] - tones[0] : null;
  if (fifth === 6) return `${root}${sev === 10 ? 'ø7' : '°'}`;
  const minor = third === 3;
  if (sev === null) return `${root}${minor ? 'm' : ''}`;
  if (minor) return `${root}m7`;
  return `${root}${sev === 11 ? 'maj7' : '7'}`;
}

/**
 * Fit a melody note to the chord. `lock`: 0 leaves it alone; 0.5 (guided) snaps notes on the beat to
 * chord tones and moves off-beat notes only when they clash (a semitone above a chord tone);
 * 1 (strict) snaps everything to chord tones. Ties resolve downward.
 */
export function fitToChord(midi: number, pcs: readonly number[], strong: boolean, lock: number): number {
  if (lock <= 0) return midi;
  const has = (m: number) => pcs.includes(mod(m, 12));
  if (has(midi)) return midi;
  const clash = has(midi - 1);
  if (lock < 1 && !strong && !clash) return midi;
  for (let d = 1; d <= 6; d++) {
    if (has(midi - d)) return midi - d;
    if (has(midi + d)) return midi + d;
  }
  return midi;
}

/**
 * Voice a chord near the previous voicing (smooth voice leading), inside [lo, lo + 12 + a bit).
 * Returns MIDI notes, ascending.
 */
export function voiceChord(tones: readonly number[], key: number, prev: readonly number[] | null, lo = 52): number[] {
  const pcs = tones.map((t) => mod(key + t, 12));
  const candidates: number[][] = [];
  for (let inv = 0; inv < pcs.length; inv++) {
    const order = [...pcs.slice(inv), ...pcs.slice(0, inv)];
    const notes: number[] = [];
    let note = lo + mod(order[0] - lo, 12);
    notes.push(note);
    for (const pc of order.slice(1)) {
      const up = mod(pc - note, 12);
      note += up === 0 ? 12 : up;
      notes.push(note);
    }
    candidates.push(notes);
  }
  if (!prev || prev.length === 0) return candidates.reduce((a, b) => (Math.abs(avg(a) - (lo + 7)) <= Math.abs(avg(b) - (lo + 7)) ? a : b));
  const cost = (c: number[]) => c.reduce((s, n, i) => s + Math.abs(n - (prev[Math.min(i, prev.length - 1)] ?? n)), 0);
  return candidates.reduce((a, b) => (cost(a) <= cost(b) ? a : b));
}

function avg(a: number[]): number { return a.reduce((s, x) => s + x, 0) / a.length; }
