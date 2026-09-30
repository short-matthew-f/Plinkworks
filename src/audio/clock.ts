// The musical clock: beats as a function of audio-context time. It is the single source of musical time;
// the simulation is stepped to it, and every note is scheduled onto it.

export class Clock {
  private anchorTime = 0;
  private anchorBeat = 0;
  playing = false;

  constructor(private bpm: number, private now: () => number) {}

  /** Beat at an audio-context time. */
  beatAt(time: number): number {
    if (!this.playing) return this.anchorBeat;
    return this.anchorBeat + ((time - this.anchorTime) * this.bpm) / 60;
  }

  beat(): number { return this.beatAt(this.now()); }

  /** Audio-context time a beat sounds at (valid while playing). */
  timeOf(beat: number): number {
    return this.anchorTime + ((beat - this.anchorBeat) * 60) / this.bpm;
  }

  secondsPerBeat(): number { return 60 / this.bpm; }

  getBpm(): number { return this.bpm; }

  setBpm(bpm: number): void {
    const t = this.now();
    this.anchorBeat = this.beatAt(t);
    this.anchorTime = t;
    this.bpm = bpm;
  }

  /** Start (or resume) so that `beat` sounds `lead` seconds from now. */
  start(lead: number): void {
    if (this.playing) return;
    this.anchorTime = this.now() + lead;
    this.playing = true;
  }

  /** Freeze at the beat `lead` seconds ahead (where the simulation already is), so resume is seamless. */
  pause(lead: number): void {
    if (!this.playing) return;
    this.anchorBeat = this.beatAt(this.now() + lead);
    this.playing = false;
  }

  /** Jump to a beat; used by reset. */
  seek(beat: number, lead: number): void {
    this.anchorBeat = beat;
    this.anchorTime = this.now() + lead;
  }
}
