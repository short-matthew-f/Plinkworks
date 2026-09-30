// The audio engine: Tone.js voices, the drum kit, the rain bed, ducking, and the scheduler that turns
// simulation events into quantized notes on the musical clock.
//
// With the conductor on, a chord pad and bass follow the progression, every melody note is fitted to the
// current chord, and a per-beat note budget (set by the intensity arc) keeps the machine from crowding
// the music: hits over budget still sound, as soft ghost notes.
//
// MVP voices are synthesized stand-ins (zero download, infinite sustain, no license risk). The pooled
// Voice interface is where sampled kalimba / mallets / cello slot in once the sample packs are prepped.
import * as Tone from 'tone';
import { midiToFreq, mod, stepToMidi } from '../model/music';
import { fitToChord, voiceChord, type ChordSpan, type Conductor } from '../model/harmony';
import type { Machine } from '../model/machine';
import type { SimEvent, SimVoice } from '../sim/sim';
import { Clock } from './clock';
import { gridBeat, quantizeBeat, releaseBeat } from './timing';

/** How far ahead of the audible clock the simulation runs; hides scheduling jitter and mobile latency. */
export const LEAD_SECONDS = 0.1;

/** Per-instrument voice caps. When full, the oldest voice is released. Total stays under the 32-voice global cap. */
export const VOICE_CAPS: Record<SimVoice, number> = { kalimba: 5, mallets: 5, cello: 2, pad: 4, bass: 2 };
/** The conductor's own voices: a 4-note chord pad and a bass. */
const CHORD_VOICES = 4;
/** Velocity multiplier for melody notes over the beat's budget. */
const GHOST = 0.22;

type Mono = Tone.FMSynth | Tone.MonoSynth | Tone.Synth;

interface VoiceSlot { synth: Mono; busyUntil: number; start: number; key: string | null }

/** Percussive voices play their natural decay; sustained voices hold until released. */
const PERCUSSIVE: Record<SimVoice, number> = { kalimba: 1.6, mallets: 0.9, cello: 0, pad: 0, bass: 0.9 };

class Pool {
  slots: VoiceSlot[] = [];
  constructor(make: () => Mono, n: number, out: Tone.ToneAudioNode) {
    for (let i = 0; i < n; i++) {
      const synth = make();
      synth.connect(out);
      this.slots.push({ synth, busyUntil: 0, start: 0, key: null });
    }
  }
  alloc(time: number): VoiceSlot {
    let best = this.slots[0];
    for (const s of this.slots) {
      if (s.busyUntil <= time) return s;
      if (s.start < best.start) best = s;
    }
    return best; // steal the oldest
  }
  releaseAll(time: number): void {
    for (const s of this.slots) {
      s.synth.triggerRelease(time);
      s.busyUntil = 0;
      s.key = null;
    }
  }
}

/** When (and at which beat) an event sounds; `velocity` is what it actually played at, after the budget. */
export interface Played { time: number; beat: number; velocity?: number }

export class AudioEngine {
  readonly clock: Clock;
  private ctx = Tone.getContext();
  private master = new Tone.Gain(0.8);
  private limiter = new Tone.Limiter(-1);
  private mix = new Tone.Gain(1);
  private send = new Tone.Gain(0.3);
  private reverb = new Tone.Reverb({ decay: 3.2, preDelay: 0.02, wet: 1 });
  private duck = new Tone.Gain(1);
  private padFilter = new Tone.Filter({ type: 'lowpass', frequency: 900, Q: 0.6 });
  private rainGain = new Tone.Gain(0);
  private dropGain = new Tone.Gain(0.25);
  private drums = new Tone.Gain(0.6);
  private pools: Record<SimVoice, Pool>;
  private kit: ((t: number, v: number) => void)[];
  private drop: Tone.Synth;
  private sustains = new Map<string, { slot: VoiceSlot; beat: number; midi: number }>();
  private chordPad: Tone.Synth[] = [];
  private padHeld: boolean[] = [];
  private chordBass: Tone.MonoSynth;
  private chordKey = '';
  private voicing: number[] | null = null;
  /** Melody notes per 16th slot and per beat, for the budget. */
  private slotCount = new Map<number, number>();
  private beatCount = new Map<number, number>();
  private lastMapping = 0;
  private dropAccum = 0;

  constructor(bpm: number) {
    this.clock = new Clock(bpm, () => this.ctx.currentTime);
    this.master.chain(this.limiter, Tone.getDestination());
    this.mix.connect(this.master);
    this.mix.connect(this.send);
    this.send.chain(this.reverb, this.master);
    this.duck.connect(this.mix);
    this.padFilter.connect(this.duck);
    this.drums.connect(this.master);
    const drumSend = new Tone.Gain(0.35);
    this.drums.connect(drumSend);
    drumSend.connect(this.reverb);

    const vib = new Tone.Vibrato({ frequency: 5, depth: 0.06 });
    vib.connect(this.mix);
    this.pools = {
      kalimba: new Pool(() => new Tone.FMSynth({
        harmonicity: 7.02, modulationIndex: 2.2, volume: -10,
        envelope: { attack: 0.001, decay: 1.5, sustain: 0, release: 1.2 },
        modulationEnvelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.05 },
      }), VOICE_CAPS.kalimba, this.mix),
      mallets: new Pool(() => new Tone.FMSynth({
        harmonicity: 3.99, modulationIndex: 1.4, volume: -9,
        envelope: { attack: 0.002, decay: 0.8, sustain: 0, release: 0.6 },
        modulationEnvelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.05 },
      }), VOICE_CAPS.mallets, this.mix),
      cello: new Pool(() => new Tone.MonoSynth({
        oscillator: { type: 'sawtooth' }, volume: -14,
        filter: { type: 'lowpass', Q: 1, rolloff: -24 },
        envelope: { attack: 0.12, decay: 0.3, sustain: 0.85, release: 0.6 },
        filterEnvelope: { attack: 0.18, decay: 0.5, sustain: 0.6, release: 0.6, baseFrequency: 280, octaves: 2.4 },
      }), VOICE_CAPS.cello, vib),
      pad: new Pool(() => new Tone.Synth({
        oscillator: { type: 'fatsawtooth', count: 3, spread: 24 }, volume: -20,
        envelope: { attack: 0.6, decay: 0.4, sustain: 0.85, release: 2 },
      }), VOICE_CAPS.pad, this.padFilter),
      bass: new Pool(() => new Tone.MonoSynth({
        oscillator: { type: 'triangle' }, volume: -6,
        envelope: { attack: 0.005, decay: 0.6, sustain: 0.15, release: 0.5 },
        filterEnvelope: { attack: 0.005, decay: 0.3, sustain: 0.3, release: 0.5, baseFrequency: 120, octaves: 2.5 },
      }), VOICE_CAPS.bass, this.duck),
    };
    this.kit = this.buildKit();

    for (let i = 0; i < CHORD_VOICES; i++) {
      const v = new Tone.Synth({
        oscillator: { type: 'fattriangle', count: 2, spread: 14 }, volume: -21, portamento: 0.25,
        envelope: { attack: 1.4, decay: 0.8, sustain: 0.85, release: 2.8 },
      });
      v.connect(this.padFilter);
      this.chordPad.push(v);
      this.padHeld.push(false);
    }
    this.chordBass = new Tone.MonoSynth({
      oscillator: { type: 'sine' }, volume: -13,
      envelope: { attack: 0.35, decay: 0.6, sustain: 0.8, release: 1.6 },
      filterEnvelope: { attack: 0.2, decay: 0.4, sustain: 0.7, release: 1.2, baseFrequency: 180, octaves: 1.5 },
    });
    this.chordBass.connect(this.duck);

    // Rain bed: filtered pink noise plus droplets, density driven by ball count.
    const noise = new Tone.Noise('pink');
    noise.chain(new Tone.Filter(2600, 'lowpass'), new Tone.Filter(350, 'highpass'), this.rainGain, this.duck);
    noise.start();
    this.drop = new Tone.Synth({ oscillator: { type: 'sine' }, envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.03 }, volume: -18 });
    this.drop.chain(this.dropGain, this.duck);
  }

  /**
   * A soft lo-fi kit, synthesized, sitting under the music: rows bottom to top are kick, rim (snare row),
   * shaker (closed hat), ride (open hat), snap (clap), low tom, high tom, woodblock (perc).
   */
  private buildKit(): ((t: number, v: number) => void)[] {
    const out = this.drums;
    const kick = new Tone.MembraneSynth({ pitchDecay: 0.03, octaves: 4, volume: -7, envelope: { attack: 0.002, decay: 0.34, sustain: 0, release: 0.1 } }).connect(out);
    const rim = new Tone.NoiseSynth({ noise: { type: 'pink' }, volume: -21, envelope: { attack: 0.001, decay: 0.07, sustain: 0 } });
    rim.chain(new Tone.Filter({ type: 'bandpass', frequency: 1900, Q: 1.6 }), out);
    const rimTick = new Tone.Synth({ oscillator: { type: 'triangle' }, volume: -26, envelope: { attack: 0.001, decay: 0.025, sustain: 0, release: 0.01 } }).connect(out);
    const shaker = new Tone.NoiseSynth({ noise: { type: 'white' }, volume: -31, envelope: { attack: 0.012, decay: 0.05, sustain: 0 } });
    shaker.chain(new Tone.Filter(5200, 'highpass'), out);
    const ride = new Tone.MetalSynth({ harmonicity: 5.1, modulationIndex: 20, resonance: 7000, octaves: 1, volume: -38, envelope: { attack: 0.002, decay: 0.7, release: 0.1 } });
    ride.connect(out);
    const snap = new Tone.NoiseSynth({ noise: { type: 'white' }, volume: -23, envelope: { attack: 0.001, decay: 0.035, sustain: 0 } });
    snap.chain(new Tone.Filter({ type: 'bandpass', frequency: 2500, Q: 2.5 }), out);
    const tom = (note: string) => ({
      s: new Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 1.6, volume: -17, envelope: { attack: 0.002, decay: 0.3, sustain: 0, release: 0.1 } }).connect(out),
      note,
    });
    const lowTom = tom('G2');
    const highTom = tom('D3');
    const block = new Tone.MembraneSynth({ pitchDecay: 0.006, octaves: 1.2, volume: -22, envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 } }).connect(out);
    return [
      (t, v) => { kick.triggerAttackRelease('D1', 0.3, t, v); this.duckAt(t); },
      (t, v) => { rim.triggerAttackRelease(0.06, t, v); rimTick.triggerAttackRelease(820, 0.02, t, v * 0.8); },
      (t, v) => shaker.triggerAttackRelease(0.05, t, v),
      (t, v) => ride.triggerAttackRelease(380, 0.5, t, v),
      (t, v) => snap.triggerAttackRelease(0.03, t, v),
      (t, v) => lowTom.s.triggerAttackRelease(lowTom.note, 0.3, t, v),
      (t, v) => highTom.s.triggerAttackRelease(highTom.note, 0.3, t, v),
      (t, v) => block.triggerAttackRelease('E5', 0.04, t, v),
    ];
  }

  /** Pads and texture beds dip on each kick: a produced, pumping feel that keeps the low end clear. */
  private duckAt(t: number): void {
    const g = this.duck.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.65, t);
    g.linearRampToValueAtTime(1, t + this.clock.secondsPerBeat() * 0.45);
  }

  /** Unlock audio (must run inside a user gesture); on iOS keep playing with the ringer switch on silent. */
  async unlock(): Promise<void> {
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession) nav.audioSession.type = 'playback';
    await Tone.start();
  }

  get currentTime(): number { return this.ctx.currentTime; }

  applySettings(m: Machine): void {
    if (Math.abs(this.clock.getBpm() - m.bpm) > 1e-6) this.clock.setBpm(m.bpm);
    this.master.gain.rampTo(m.volume, 0.05);
    this.send.gain.rampTo(m.reverb * 0.9, 0.05);
  }

  /** Stop everything that is sounding (pause, reset). */
  silence(): void {
    const t = this.ctx.currentTime;
    for (const p of Object.values(this.pools)) p.releaseAll(t);
    this.sustains.clear();
    this.releaseChord(t);
    this.slotCount.clear();
    this.beatCount.clear();
  }

  private releaseChord(t: number): void {
    for (const v of this.chordPad) v.triggerRelease(t);
    this.padHeld.fill(false);
    this.chordBass.triggerRelease(t);
    this.chordKey = '';
  }

  /**
   * The conductor's layer: when the sim reaches a new chord, voice-lead the pad to it, move the bass,
   * and let held notes (rails, resonators) glide to the nearest tone of the new chord.
   */
  updateHarmony(conductor: Conductor, m: Machine, simBeat: number): void {
    if (!m.chords) {
      if (this.chordKey) this.releaseChord(this.ctx.currentTime);
      this.voicing = null;
      return;
    }
    const c = conductor.chordAt(simBeat, m);
    const key = `${c.index}:${m.key}:${m.scale}:${m.chordBars}`;
    if (key === this.chordKey) return;
    this.chordKey = key;
    const t = Math.max(this.ctx.currentTime + 0.01, this.clock.timeOf(c.startBeat));
    const notes = voiceChord(c.tones, m.key, this.voicing);
    this.voicing = notes;
    const vel = 0.3 + 0.35 * c.intensity;
    // Held voices glide (legato) to their new note; only newly needed voices swell in.
    this.chordPad.forEach((v, i) => {
      if (i < notes.length) {
        if (this.padHeld[i]) v.setNote(midiToFreq(notes[i]), t);
        else v.triggerAttack(midiToFreq(notes[i]), t, vel);
        this.padHeld[i] = true;
      } else if (this.padHeld[i]) {
        v.triggerRelease(t);
        this.padHeld[i] = false;
      }
    });
    this.chordBass.triggerAttack(midiToFreq(36 + mod(c.rootPc - 36, 12)), t, 0.5 + 0.3 * c.intensity);
    if (m.harmony > 0) {
      for (const [k, s] of this.sustains) {
        if (s.slot.key !== k) continue; // its voice was taken by a newer note
        const to = fitToChord(s.midi, c.pcs, true, m.harmony);
        if (to !== s.midi) {
          s.slot.synth.setNote(midiToFreq(to), t);
          s.midi = to;
        }
      }
    }
    // Forget budget counts from bars long gone.
    for (const k of this.slotCount.keys()) if (k < simBeat * 4 - 64) this.slotCount.delete(k);
    for (const k of this.beatCount.keys()) if (k < simBeat - 16) this.beatCount.delete(k);
  }

  /** Pitch for a melody note: its scale step, fitted to the chord sounding at that beat. */
  private melodyMidi(step: number, beat: number, m: Machine, chord: ChordSpan | null): number {
    const midi = stepToMidi(step, m.key, m.scale);
    if (!chord) return midi;
    const strong = Math.abs(beat - Math.round(beat)) < 0.06;
    return fitToChord(midi, chord.pcs, strong, m.harmony);
  }

  /** Budget: how many melody notes a beat can hold at this intensity. Extra notes become ghosts. */
  private budget(beat: number, chord: ChordSpan | null): number {
    const slot = Math.round(beat * 4);
    const b = Math.floor(beat + 1e-6);
    const perSlot = (slot & 3) === 0 ? 2 : 1;
    const perBeat = chord ? 1 + Math.round(3 * chord.intensity) : 4;
    const s = (this.slotCount.get(slot) ?? 0) + 1;
    const n = (this.beatCount.get(b) ?? 0) + 1;
    this.slotCount.set(slot, s);
    this.beatCount.set(b, n);
    return s <= perSlot && n <= perBeat ? 1 : GHOST;
  }

  /** Schedule one simulation event. Returns when (and at which beat) it will sound, for play-time glows. */
  schedule(e: SimEvent, m: Machine, conductor: Conductor): Played | null {
    const now = this.ctx.currentTime;
    const chordAt = (beat: number) => (m.chords ? conductor.chordAt(beat, m) : null);
    const at = (beat: number) => Math.max(now + 0.005, this.clock.timeOf(beat));
    switch (e.kind) {
      case 'drum': {
        const beat = gridBeat(e.step16, m.swing);
        const time = at(beat);
        this.kit[e.row]?.(time, e.velocity);
        return { time, beat };
      }
      case 'note': {
        const beat = quantizeBeat(e.beat, m.quantize, m.swing);
        const time = at(beat);
        const chord = chordAt(beat);
        let midi: number;
        let vel = e.velocity;
        if (e.voice === 'bass') {
          // A drain's bass note is the chord's root.
          midi = chord ? 36 + mod(chord.rootPc - 36, 12) : stepToMidi(e.step, m.key, m.scale);
        } else {
          midi = this.melodyMidi(e.step, beat, m, chord);
          vel *= 0.85 * this.budget(beat, chord);
        }
        const slot = this.pools[e.voice].alloc(time);
        this.detach(slot);
        const decay = PERCUSSIVE[e.voice] || 0.5;
        slot.synth.triggerAttackRelease(midiToFreq(midi), Math.min(0.25, decay), time, vel);
        slot.busyUntil = time + decay;
        slot.start = time;
        return { time, beat, velocity: vel };
      }
      case 'sustainStart': {
        const beat = quantizeBeat(e.beat, m.quantize, m.swing);
        const time = at(beat);
        const slot = this.pools[e.voice].alloc(time);
        this.detach(slot);
        const chord = chordAt(beat);
        const midi = chord ? fitToChord(stepToMidi(e.step, m.key, m.scale), chord.pcs, true, m.harmony) : stepToMidi(e.step, m.key, m.scale);
        slot.synth.triggerAttack(midiToFreq(midi), time, e.velocity * 0.8);
        slot.busyUntil = Infinity;
        slot.start = time;
        slot.key = e.key;
        this.sustains.set(e.key, { slot, beat, midi });
        return { time, beat };
      }
      case 'sustainEnd': {
        const s = this.sustains.get(e.key);
        if (!s) return null;
        this.sustains.delete(e.key);
        if (s.slot.key !== e.key) return null; // stolen by a newer note
        const beat = releaseBeat(s.beat, e.beat, m.quantize, m.swing);
        const time = at(beat);
        s.slot.synth.triggerRelease(time);
        s.slot.key = null;
        s.slot.busyUntil = time + 1;
        return { time, beat };
      }
      case 'link': {
        const time = at(e.beat);
        return { time, beat: e.beat };
      }
    }
  }

  /** A slot being reused stops belonging to whichever sustain held it (its oldest voice is released). */
  private detach(slot: VoiceSlot): void {
    if (slot.key) {
      this.sustains.delete(slot.key);
      slot.key = null;
    }
  }

  /**
   * Physics-to-texture mappings, smoothed over about a beat so they breathe rather than jitter:
   * total kinetic energy → pad brightness, ball count → rain density.
   */
  updateTexture(energy: number, balls: number, dt: number, playing: boolean, intensity = 0.5): void {
    const now = this.ctx.currentTime;
    const spb = this.clock.secondsPerBeat();
    if (now - this.lastMapping > 0.1) {
      this.lastMapping = now;
      const bright = 1 - Math.exp(-energy / 80);
      // The arc opens the pad slowly; a busy machine brightens it further.
      this.padFilter.frequency.rampTo(320 + 1400 * intensity + 2600 * bright, spb * 2);
      const density = playing ? Math.min(1, balls / 24) : 0;
      this.rainGain.gain.rampTo(playing ? 0.015 + 0.11 * density : 0, spb);
    }
    if (!playing) return;
    // Droplets: few balls = light rain, many = downpour.
    this.dropAccum += dt * (0.6 + balls * 0.9);
    while (this.dropAccum >= 1) {
      this.dropAccum -= 1;
      const t = now + LEAD_SECONDS + Math.random() * 0.1;
      this.drop.triggerAttackRelease(1800 + Math.random() * 3200, 0.02, t, 0.2 + Math.random() * 0.5);
    }
  }
}
