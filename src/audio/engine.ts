// The audio engine: Tone.js voices, the drum kit, the rain bed, ducking, and the scheduler that turns
// simulation events into quantized notes on the musical clock.
//
// MVP voices are synthesized stand-ins (zero download, infinite sustain, no license risk). The pooled
// Voice interface is where sampled kalimba / mallets / cello slot in once the sample packs are prepped.
import * as Tone from 'tone';
import { midiToFreq, stepToMidi } from '../model/music';
import type { Machine } from '../model/machine';
import type { SimEvent, SimVoice } from '../sim/sim';
import { Clock } from './clock';
import { gridBeat, quantizeBeat, releaseBeat } from './timing';

/** How far ahead of the audible clock the simulation runs; hides scheduling jitter and mobile latency. */
export const LEAD_SECONDS = 0.1;

/** Per-instrument voice caps. When full, the oldest voice is released. Total stays under the 32-voice global cap. */
export const VOICE_CAPS: Record<SimVoice, number> = { kalimba: 6, mallets: 6, cello: 2, pad: 4, bass: 2 };

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

export interface Played { time: number; beat: number }

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
  private drums = new Tone.Gain(0.9);
  private pools: Record<SimVoice, Pool>;
  private kit: ((t: number, v: number) => void)[];
  private drop: Tone.Synth;
  private sustains = new Map<string, { slot: VoiceSlot; beat: number }>();
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
    const drumSend = new Tone.Gain(0.25);
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

    // Rain bed: filtered pink noise plus droplets, density driven by ball count.
    const noise = new Tone.Noise('pink');
    noise.chain(new Tone.Filter(2600, 'lowpass'), new Tone.Filter(350, 'highpass'), this.rainGain, this.duck);
    noise.start();
    this.drop = new Tone.Synth({ oscillator: { type: 'sine' }, envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.03 }, volume: -18 });
    this.drop.chain(this.dropGain, this.duck);
  }

  /** Acoustic kit, synthesized: rows bottom to top are kick, snare, closed hat, open hat, clap, low tom, high tom, perc. */
  private buildKit(): ((t: number, v: number) => void)[] {
    const out = this.drums;
    const kick = new Tone.MembraneSynth({ pitchDecay: 0.045, octaves: 6, volume: -2, envelope: { attack: 0.001, decay: 0.42, sustain: 0, release: 0.1 } }).connect(out);
    const snareNoise = new Tone.NoiseSynth({ noise: { type: 'white' }, volume: -12, envelope: { attack: 0.001, decay: 0.17, sustain: 0 } });
    snareNoise.chain(new Tone.Filter(1400, 'highpass'), out);
    const snareBody = new Tone.MembraneSynth({ pitchDecay: 0.02, octaves: 2, volume: -10, envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.05 } }).connect(out);
    const hat = (decay: number) => {
      const s = new Tone.MetalSynth({ harmonicity: 5.1, modulationIndex: 32, resonance: 5000, octaves: 1.5, volume: -26, envelope: { attack: 0.001, decay, release: 0.02 } });
      s.connect(out);
      return s;
    };
    const closedHat = hat(0.05);
    const openHat = hat(0.4);
    const clap = new Tone.NoiseSynth({ noise: { type: 'pink' }, volume: -14, envelope: { attack: 0.001, decay: 0.09, sustain: 0 } });
    clap.chain(new Tone.Filter({ type: 'bandpass', frequency: 1300, Q: 0.9 }), out);
    const tom = (note: string) => ({
      s: new Tone.MembraneSynth({ pitchDecay: 0.06, octaves: 2.2, volume: -8, envelope: { attack: 0.001, decay: 0.38, sustain: 0, release: 0.1 } }).connect(out),
      note,
    });
    const lowTom = tom('G2');
    const highTom = tom('D3');
    const perc = new Tone.MembraneSynth({ pitchDecay: 0.008, octaves: 1.5, volume: -14, envelope: { attack: 0.001, decay: 0.07, sustain: 0, release: 0.02 } }).connect(out);
    return [
      (t, v) => { kick.triggerAttackRelease('C1', 0.3, t, v); this.duckAt(t); },
      (t, v) => { snareNoise.triggerAttackRelease(0.15, t, v); snareBody.triggerAttackRelease('E3', 0.1, t, v * 0.8); },
      (t, v) => closedHat.triggerAttackRelease(420, 0.05, t, v),
      (t, v) => openHat.triggerAttackRelease(420, 0.35, t, v),
      (t, v) => { for (let i = 0; i < 3; i++) clap.triggerAttackRelease(0.02, t + i * 0.011, v * (i === 2 ? 1 : 0.7)); },
      (t, v) => lowTom.s.triggerAttackRelease(lowTom.note, 0.3, t, v),
      (t, v) => highTom.s.triggerAttackRelease(highTom.note, 0.3, t, v),
      (t, v) => perc.triggerAttackRelease('A5', 0.05, t, v),
    ];
  }

  /** Pads and texture beds dip on each kick: a produced, pumping feel that keeps the low end clear. */
  private duckAt(t: number): void {
    const g = this.duck.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.4, t);
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
  }

  /** Schedule one simulation event. Returns when (and at which beat) it will sound, for play-time glows. */
  schedule(e: SimEvent, m: Machine): Played | null {
    const now = this.ctx.currentTime;
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
        const slot = this.pools[e.voice].alloc(time);
        this.detach(slot);
        const decay = PERCUSSIVE[e.voice] || 0.5;
        slot.synth.triggerAttackRelease(this.freq(e.step, m), Math.min(0.25, decay), time, e.velocity);
        slot.busyUntil = time + decay;
        slot.start = time;
        return { time, beat };
      }
      case 'sustainStart': {
        const beat = quantizeBeat(e.beat, m.quantize, m.swing);
        const time = at(beat);
        const slot = this.pools[e.voice].alloc(time);
        this.detach(slot);
        slot.synth.triggerAttack(this.freq(e.step, m), time, e.velocity);
        slot.busyUntil = Infinity;
        slot.start = time;
        slot.key = e.key;
        this.sustains.set(e.key, { slot, beat });
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

  private freq(step: number, m: Machine): number {
    return midiToFreq(stepToMidi(step, m.key, m.scale));
  }

  /**
   * Physics-to-texture mappings, smoothed over about a beat so they breathe rather than jitter:
   * total kinetic energy → pad brightness, ball count → rain density.
   */
  updateTexture(energy: number, balls: number, dt: number, playing: boolean): void {
    const now = this.ctx.currentTime;
    const spb = this.clock.secondsPerBeat();
    if (now - this.lastMapping > 0.1) {
      this.lastMapping = now;
      const bright = 1 - Math.exp(-energy / 80);
      this.padFilter.frequency.rampTo(280 + 4200 * bright, spb);
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
