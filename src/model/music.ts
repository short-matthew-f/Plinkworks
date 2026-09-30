// Scale lock: every pitch in the machine is a scale step, so no wrong notes are possible.
// A "step" is a count of scale degrees above the key's root in octave 4 (step 0 = root, step n = root an octave up).

export type ScaleId = 'majorPent' | 'minorPent' | 'major' | 'minor';

export interface ScaleDef { id: ScaleId; name: string; intervals: readonly number[] }

export const SCALES: Record<ScaleId, ScaleDef> = {
  majorPent: { id: 'majorPent', name: 'Major pentatonic', intervals: [0, 2, 4, 7, 9] },
  minorPent: { id: 'minorPent', name: 'Minor pentatonic', intervals: [0, 3, 5, 7, 10] },
  major: { id: 'major', name: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11] },
  minor: { id: 'minor', name: 'Minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
};
export const SCALE_IDS = Object.keys(SCALES) as ScaleId[];

export const KEY_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'] as const;

/** Euclidean modulo: always in [0, n). */
export function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

export function scaleSize(scale: ScaleId): number {
  return SCALES[scale].intervals.length;
}

/** MIDI note for a scale step in the given key (0 = C) and scale. Step 0 is the root in octave 4. */
export function stepToMidi(step: number, key: number, scale: ScaleId): number {
  const iv = SCALES[scale].intervals;
  const n = iv.length;
  return 60 + key + iv[mod(step, n)] + 12 * Math.floor(step / n);
}

export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export function midiName(midi: number): string {
  return `${NOTE_NAMES[mod(midi, 12)]}${Math.floor(midi / 12) - 1}`;
}

/** Ball sizes are octaves: 0 = small (high), 1 = medium, 2 = large (low). */
export type BallSize = 0 | 1 | 2;
export const BALL_RADIUS: Record<BallSize, number> = { 0: 0.17, 1: 0.24, 2: 0.32 };

/** A ball's pitch as a scale step: its degree, shifted one octave up or down by its size. */
export function ballStep(degree: number, size: BallSize, scale: ScaleId): number {
  const n = scaleSize(scale);
  return mod(degree, n) + n * (1 - size);
}

/**
 * Fixed color wheel: degree 1 of any scale is always the same hue, so players learn the colors.
 * Seven slots cover the largest MVP scale; pentatonic scales use the first five.
 */
export function degreeHue(degree: number): number {
  return (mod(degree, 7) * 360) / 7 + 8;
}

/** The degree (0-based) a step lands on. */
export function stepDegree(step: number, scale: ScaleId): number {
  return mod(step, scaleSize(scale));
}

/** Rubber band pitch comes from its length, snapped to the scale: half the length is an octave up. */
export const BAND_REFERENCE_LENGTH = 3;
export function bandStep(length: number, scale: ScaleId): number {
  const n = scaleSize(scale);
  const raw = Math.round(n * Math.log2(BAND_REFERENCE_LENGTH / Math.max(0.2, length)));
  return Math.max(-2 * n, Math.min(2 * n, raw));
}
