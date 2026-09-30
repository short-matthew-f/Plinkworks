import { describe, expect, it } from 'vitest';
import { chordName, chordTones, Conductor, CHORDS_PER_SECTION, fitToChord, voiceChord } from '../src/model/harmony';
import { stepToMidi, SCALES, mod } from '../src/model/music';

const H = { key: 0, scale: 'majorPent' as const, chordBars: 2 };

describe('chords', () => {
  it('builds diatonic triads and sevenths', () => {
    expect(chordTones(0, false, 'major')).toEqual([0, 4, 7]);
    expect(chordTones(4, true, 'major')).toEqual([7, 11, 14, 17]);
    expect(chordName(chordTones(1, true, 'major'), 0)).toBe('Dm7');
    expect(chordName(chordTones(3, true, 'major'), 0)).toBe('Fmaj7');
    expect(chordName(chordTones(4, true, 'major'), 0)).toBe('G7');
    expect(chordName(chordTones(0, false, 'minor'), 9)).toBe('Am');
  });
});

describe('conductor', () => {
  it('is deterministic for a seed', () => {
    const a = new Conductor(7), b = new Conductor(7);
    for (let beat = 0; beat < 800; beat += 8) expect(b.chordAt(beat, H)).toEqual(a.chordAt(beat, H));
  });

  it('starts home, lands every section on its goal, and never repeats a chord back to back', () => {
    const c = new Conductor(3);
    const first = c.chordAt(0, H);
    expect(first.name).toBe('C');
    let prev = '';
    const goals: string[] = [];
    for (let i = 0; i < 40 * CHORDS_PER_SECTION; i++) {
      const ch = c.chordAt(i * 8, H);
      expect(ch.index).toBe(i);
      if (ch.cadence) {
        expect(ch.name.replace(/(maj7|m7|7)$/, (m) => (m === 'm7' ? 'm' : ''))).toBe(ch.goalName);
        goals.push(ch.goalName);
      }
      expect(ch.name).not.toBe(prev);
      prev = ch.name;
    }
    // Goals shift section to section, and the music comes home regularly.
    for (let i = 1; i < goals.length; i++) expect(goals[i]).not.toBe(goals[i - 1]);
    expect(goals.filter((g) => g === 'C').length).toBeGreaterThan(goals.length / 4);
  });

  it('keeps chord tones inside the parent scale', () => {
    const c = new Conductor(11);
    for (const scale of ['major', 'minor'] as const) {
      const iv = new Set(SCALES[scale].intervals);
      for (let i = 0; i < 64; i++) for (const t of c.chordAt(i * 8, { ...H, scale }).tones) expect(iv.has(mod(t, 12))).toBe(true);
    }
  });

  it('has an intensity arc that rises and falls', () => {
    const c = new Conductor(5);
    const levels = Array.from({ length: 12 }, (_, s) => c.intensityAtBar(s * 8, H));
    expect(Math.max(...levels)).toBeGreaterThan(0.7);
    expect(Math.min(...levels)).toBeLessThan(0.4);
  });
});

describe('melody fitting', () => {
  const Cmaj = [0, 4, 7];
  it('snaps strong beats to chord tones, resolving down on ties', () => {
    expect(fitToChord(62, Cmaj, true, 0.5)).toBe(60);
    expect(fitToChord(69, Cmaj, true, 0.5)).toBe(67);
    expect(fitToChord(64, Cmaj, true, 0.5)).toBe(64);
  });
  it('lets off-beat passing tones through unless they clash', () => {
    expect(fitToChord(62, Cmaj, false, 0.5)).toBe(62); // D over C: fine
    expect(fitToChord(65, Cmaj, false, 0.5)).toBe(64); // F over C: a semitone above E, moves
    expect(fitToChord(62, Cmaj, false, 1)).toBe(60); // strict
    expect(fitToChord(62, Cmaj, true, 0)).toBe(62); // off
  });
  it('fitted pentatonic melody stays consonant with every chord', () => {
    const c = new Conductor(9);
    for (let i = 0; i < 32; i++) {
      const ch = c.chordAt(i * 8, H);
      for (let s = -5; s <= 10; s++) {
        const m = fitToChord(stepToMidi(s, 0, 'majorPent'), ch.pcs, false, 0.5);
        expect(ch.pcs.includes(mod(m - 1, 12))).toBe(false);
      }
    }
  });
});

describe('voice leading', () => {
  it('moves little between chords', () => {
    const a = voiceChord([0, 4, 7], 0, null);
    const b = voiceChord([5, 9, 12], 0, a); // F after C
    expect(a.every((n, i) => i === 0 || n > a[i - 1])).toBe(true);
    const moved = b.reduce((s, n, i) => s + Math.abs(n - a[i]), 0);
    expect(moved).toBeLessThanOrEqual(4);
  });
});
