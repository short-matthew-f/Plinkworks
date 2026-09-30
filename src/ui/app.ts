// The app controller: owns the machine, simulation, audio engine and renderer, and runs the main loop.
// The machine never stops while you edit: every change applies live.
import { cloneMachine, FLOOR_COLS, LINK_SOURCES, LINK_TARGETS, PART_INFO, type Machine, type Part } from '../model/machine';
import { KEY_NAMES, SCALES, SCALE_IDS, type ScaleId } from '../model/music';
import { encodeMachine } from '../model/share';
import { AudioEngine, LEAD_SECONDS } from '../audio/engine';
import { Renderer } from '../render/renderer';
import { Sim, type SimEvent } from '../sim/sim';
import { autosave } from '../storage/db';
import { Input } from './input';
import { Drawer } from './drawer';
import { openMenu, openPartSettings, closeSheet } from './sheets';
import { $, toast } from './dom';

export class App {
  machine: Machine;
  sim: Sim;
  engine: AudioEngine;
  renderer: Renderer;
  playing = false;
  unlocked = false;
  selected: string | null = null;
  linkFrom: string | null = null;
  showGrid = true;
  ghost: Part | null = null;
  private lastFrame = 0;
  private saveTimer = 0;

  constructor(machine: Machine) {
    this.machine = machine;
    this.sim = new Sim(machine);
    this.engine = new AudioEngine(machine.bpm);
    this.engine.applySettings(machine);
    this.renderer = new Renderer($('#table') as HTMLCanvasElement);
    new Input(this);
    new Drawer(this);
    this.bindTransport();
    this.syncTransport();
    const resize = () => this.renderer.resize();
    window.addEventListener('resize', resize);
    new ResizeObserver(resize).observe($('#stage'));
    resize();
    $('#start').hidden = false;
    $('#start').addEventListener('click', () => void this.play());
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.playing) this.pause(); });
    requestAnimationFrame((t) => this.frame(t));
  }

  // ---- main loop ----------------------------------------------------------------------------

  private frame(ts: number): void {
    const dt = Math.min(0.1, (ts - this.lastFrame) / 1000 || 0);
    this.lastFrame = ts;
    const now = this.engine.currentTime;
    if (this.playing) {
      // The simulation runs a little ahead of what is audible, so every note can be scheduled precisely.
      this.sim.advanceTo(this.engine.clock.beatAt(now + LEAD_SECONDS));
      this.engine.updateHarmony(this.sim.conductor, this.machine, this.sim.beat);
      for (const e of this.sim.drainEvents()) this.onEvent(e);
    }
    const audioBeat = this.engine.clock.beatAt(now);
    const chord = this.machine.chords ? this.sim.conductor.chordAt(audioBeat, this.machine) : null;
    this.engine.updateTexture(this.sim.energy, this.sim.balls.length, dt, this.playing, chord?.intensity ?? 0.6);
    this.renderer.draw({
      sim: this.sim,
      machine: this.machine,
      audioTime: now,
      audioBeat,
      chord,
      playing: this.playing,
      selected: this.selected,
      linkFrom: this.linkFrom,
      showGrid: this.showGrid,
      ghost: this.ghost,
    });
    requestAnimationFrame((t) => this.frame(t));
  }

  private onEvent(e: SimEvent): void {
    const played = this.engine.schedule(e, this.machine, this.sim.conductor);
    if (!played) return;
    const time = played.time;
    switch (e.kind) {
      case 'note':
      case 'sustainStart':
        this.renderer.flash({ kind: 'ring', time, x: e.x, y: e.y, hue: e.hue, strength: played.velocity ?? e.velocity, partId: e.partId });
        break;
      case 'drum':
        this.renderer.flash({ kind: 'cell', time, cell: e.row * FLOOR_COLS + e.col, strength: e.velocity });
        break;
      case 'link':
        this.renderer.flash({ kind: 'link', time, from: e.from, to: e.to });
        break;
      default:
        break;
    }
  }

  // ---- transport ----------------------------------------------------------------------------

  async play(): Promise<void> {
    if (!this.unlocked) {
      await this.engine.unlock();
      this.unlocked = true;
      $('#start').hidden = true;
    }
    if (this.playing) return;
    this.engine.applySettings(this.machine);
    this.engine.clock.start(LEAD_SECONDS);
    this.playing = true;
    this.syncPlayButton();
  }

  /** Pause freezes physics and the clock together. */
  pause(): void {
    if (!this.playing) return;
    this.engine.clock.pause(LEAD_SECONDS);
    this.engine.silence();
    this.playing = false;
    this.syncPlayButton();
  }

  /** Reset returns all balls to their starting state; deterministic physics replays the song exactly. */
  reset(): void {
    this.sim.reset();
    this.engine.silence();
    this.engine.clock.seek(0, LEAD_SECONDS);
    this.renderer.clearFlashes();
  }

  setMachine(m: Machine): void {
    this.machine = m;
    this.selected = null;
    this.linkFrom = null;
    this.sim.replaceMachine(m);
    this.engine.silence();
    this.engine.clock.seek(0, LEAD_SECONDS);
    this.engine.applySettings(m);
    this.renderer.clearFlashes();
    this.syncTransport();
    this.updateBanner();
    this.changed();
  }

  private syncPlayButton(): void {
    const b = $('#play');
    b.textContent = this.playing ? '❚❚' : '▶';
    b.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
  }

  private bindTransport(): void {
    $('#play').addEventListener('click', () => (this.playing ? this.pause() : void this.play()));
    $('#reset').addEventListener('click', () => this.reset());
    const key = $('#key') as HTMLSelectElement;
    KEY_NAMES.forEach((n, i) => key.add(new Option(n, String(i))));
    key.addEventListener('change', () => { this.machine.key = Number(key.value); this.changed(); });
    const scale = $('#scale') as HTMLSelectElement;
    for (const id of SCALE_IDS) scale.add(new Option(SCALES[id].name, id));
    scale.addEventListener('change', () => { this.machine.scale = scale.value as ScaleId; this.changed(); });
    const bpm = $('#bpm') as HTMLInputElement;
    const setBpm = (v: number) => {
      this.machine.bpm = Math.max(40, Math.min(200, Math.round(v) || 96));
      bpm.value = String(this.machine.bpm);
      this.engine.applySettings(this.machine);
      this.changed();
    };
    bpm.addEventListener('change', () => setBpm(Number(bpm.value)));
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-bpm]')) {
      b.addEventListener('click', () => setBpm(this.machine.bpm + Number(b.dataset.bpm) * 2));
    }
    const q = $('#quantize') as HTMLInputElement;
    q.addEventListener('input', () => {
      this.machine.quantize = Number(q.value) / 100;
      $('#quantize-val').textContent = `${q.value}%`;
      this.changed();
    });
    $('#share').addEventListener('click', () => void this.share());
    $('#menu').addEventListener('click', () => openMenu(this));
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.code === 'Space') { e.preventDefault(); if (this.playing) this.pause(); else void this.play(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) this.removePart(this.selected);
      if (e.key === 'Escape') { this.linkFrom = null; this.selected = null; this.updateBanner(); closeSheet(); }
    });
  }

  syncTransport(): void {
    const m = this.machine;
    ($('#key') as HTMLSelectElement).value = String(m.key);
    ($('#scale') as HTMLSelectElement).value = m.scale;
    ($('#bpm') as HTMLInputElement).value = String(m.bpm);
    ($('#quantize') as HTMLInputElement).value = String(Math.round(m.quantize * 100));
    $('#quantize-val').textContent = `${Math.round(m.quantize * 100)}%`;
    this.syncPlayButton();
  }

  async share(): Promise<void> {
    const code = await encodeMachine(this.machine);
    const url = `${location.origin}${location.pathname}#m=${code}`;
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    try {
      if (nav.share && matchMedia('(pointer: coarse)').matches) {
        await nav.share({ title: `Plinkworks · ${this.machine.name}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast('Share link copied');
    } catch {
      prompt('Copy this link to share your machine:', url);
    }
  }

  // ---- editing ------------------------------------------------------------------------------

  /** Call after any change to the machine; `p` is the part that changed, if any. */
  changed(p?: Part): void {
    if (p) this.sim.updatePart(p);
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void autosave(cloneMachine(this.machine)).catch(() => {}), 600);
  }

  part(id: string | null): Part | undefined {
    return id ? this.machine.parts.find((p) => p.id === id) : undefined;
  }

  addPart(p: Part): void {
    this.machine.parts.push(p);
    this.sim.addPart(p);
    this.selected = p.id;
    this.changed();
  }

  removePart(id: string): void {
    const i = this.machine.parts.findIndex((p) => p.id === id);
    if (i < 0) return;
    this.machine.parts.splice(i, 1);
    this.sim.removePart(id);
    if (this.selected === id) this.selected = null;
    if (this.linkFrom === id) this.linkFrom = null;
    this.updateBanner();
    this.changed();
  }

  togglePin(cell: number): void {
    this.sim.floor.togglePin(cell);
    this.machine.pins = this.sim.floor.pins();
    this.changed();
  }

  startLink(id: string): void {
    this.linkFrom = id;
    closeSheet();
    this.updateBanner();
  }

  /** Link mode: tap part A's link button, then part B. Tapping an existing link removes it. */
  finishLink(target: Part): void {
    const src = this.part(this.linkFrom);
    this.linkFrom = null;
    this.updateBanner();
    if (!src || src.id === target.id) return;
    if (!LINK_TARGETS.includes(target.type)) {
      toast(`Links go to spawners and beat gates, not a ${PART_INFO[target.type].name.toLowerCase()}`);
      return;
    }
    const links = src.links ?? [];
    if (links.includes(target.id)) {
      src.links = links.filter((l) => l !== target.id);
      if (!src.links.length) delete src.links;
      toast('Link removed');
    } else {
      src.links = [...links, target.id];
      toast(`${PART_INFO[src.type].name} → ${PART_INFO[target.type].name} linked`);
    }
    this.changed();
  }

  updateBanner(): void {
    const b = $('#banner');
    const src = this.part(this.linkFrom);
    if (!src || !LINK_SOURCES.includes(src.type)) {
      b.hidden = true;
      return;
    }
    b.hidden = false;
    b.innerHTML = '';
    const t = document.createElement('span');
    t.textContent = `Tap a spawner or beat gate to link from this ${PART_INFO[src.type].name.toLowerCase()}`;
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { this.linkFrom = null; this.updateBanner(); });
    b.append(t, cancel);
  }

  openSettings(p: Part): void {
    this.selected = p.id;
    openPartSettings(this, p);
  }
}
