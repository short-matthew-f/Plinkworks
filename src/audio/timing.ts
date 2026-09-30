// Time lock: collisions queue and fire on the next grid subdivision (a 16th). Pure functions, unit-tested.

/** Swing delays every odd 16th; full swing (1) is a triplet shuffle (1/12 beat late). */
export function gridBeat(k: number, swing: number): number {
  return k / 4 + ((k & 1) === 1 ? swing / 12 : 0);
}

/** The first grid point at or after `beat`. */
export function nextGridBeat(beat: number, swing: number): number {
  const eps = 1e-9;
  let k = Math.floor(beat * 4) - 1;
  while (gridBeat(k, swing) < beat - eps) k++;
  return gridBeat(k, swing);
}

/**
 * Where a raw event at `beat` lands: `quantize` 1 snaps fully to the next grid point,
 * 0 keeps raw physics timing, and values between pull the event part of the way.
 */
export function quantizeBeat(beat: number, quantize: number, swing: number): number {
  const q = Math.max(0, Math.min(1, quantize));
  return beat + q * (nextGridBeat(beat, swing) - beat);
}

/** Minimum sustained note length: one eighth note. */
export const MIN_SUSTAIN_BEATS = 0.5;

/** Quantized release for a sustain: snapped like a start, and never shorter than an eighth. */
export function releaseBeat(startBeat: number, rawEnd: number, quantize: number, swing: number): number {
  return Math.max(startBeat + MIN_SUSTAIN_BEATS, quantizeBeat(rawEnd, quantize, swing));
}
