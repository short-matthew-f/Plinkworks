// Bottom sheets: per-part settings (long-press a part) and the machine menu (saves, global controls).
import {
  cloneMachine, createPart, defaultMachine, nextPartId, LINK_SOURCES, PART_INFO, VOICES, VOICE_NAMES,
  type Machine, type Part, type Voice,
} from '../model/machine';
import { bandStep, midiName, scaleSize, stepToMidi } from '../model/music';
import { listSaves, removeSave, saveAs } from '../storage/db';
import type { App } from './app';
import { $, el, toast } from './dom';

export function closeSheet(): void {
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
}

function openSheet(title: string, sub: string): HTMLElement {
  const s = $('#sheet');
  const b = $('#sheet-backdrop');
  s.innerHTML = '';
  s.append(el('h2', {}, title), el('p', { className: 'sub' }, sub));
  s.hidden = false;
  b.hidden = false;
  b.onclick = closeSheet;
  return s;
}

function row(label: string, ...ctl: (Node | string)[]): HTMLElement {
  return el('div', { className: 'row' }, el('label', {}, label), el('div', { className: 'ctl' }, ...ctl));
}

function select<T extends string | number>(opts: [T, string][], value: T, on: (v: T) => void): HTMLSelectElement {
  const s = el('select');
  opts.forEach(([v, label], i) => s.add(new Option(label, String(i), false, v === value)));
  s.addEventListener('change', () => on(opts[Number(s.value)][0]));
  return s;
}

function range(min: number, max: number, step: number, value: number, fmt: (v: number) => string, on: (v: number) => void): HTMLElement[] {
  const r = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  const v = el('span', { className: 'val' }, fmt(value));
  r.addEventListener('input', () => { v.textContent = fmt(Number(r.value)); on(Number(r.value)); });
  return [r, v];
}

function seg<const T>(opts: [T, string][], value: T, on: (v: T) => void): HTMLElement {
  const wrap = el('div', { className: 'seg' });
  for (const [v, label] of opts) {
    const b = el('button', { type: 'button', className: v === value ? 'on' : '' }, label);
    b.addEventListener('click', () => {
      for (const x of wrap.children) x.classList.remove('on');
      b.classList.add('on');
      on(v);
    });
    wrap.append(b);
  }
  return wrap;
}

function button(label: string, cls: string, on: () => void): HTMLButtonElement {
  const b = el('button', { type: 'button', className: `btn ${cls}` }, label);
  b.addEventListener('click', on);
  return b;
}

/** Note choices as scale steps, labeled with the pitch name and scale degree. */
function noteOptions(m: Machine, lo: number, hi: number): [number, string][] {
  const n = scaleSize(m.scale);
  const out: [number, string][] = [];
  for (let s = hi; s >= lo; s--) out.push([s, `${midiName(stepToMidi(s, m.key, m.scale))} · ${(((s % n) + n) % n) + 1}`]);
  return out;
}

const voiceOpts = (): [Voice, string][] => VOICES.map((v) => [v, VOICE_NAMES[v]]);
const deg = (a: number) => `${Math.round((a * 180) / Math.PI)}°`;

export function openPartSettings(app: App, p: Part): void {
  const m = app.machine;
  const info = PART_INFO[p.type];
  const s = openSheet(info.name, `${info.family} · ${info.blurb}`);
  const n = scaleSize(m.scale);
  const upd = () => app.changed(p);

  switch (p.type) {
    case 'spawner': {
      s.append(
        row('Drop every', select([[0.5, '½ beat'], [1, '1 beat'], [1.5, '1½ beats'], [2, '2 beats'], [3, '3 beats'], [4, '1 bar'], [6, '6 beats'], [8, '2 bars'], [16, '4 bars']], p.interval, (v) => { p.interval = v; upd(); })),
        row('Notes', seg([['fixed', 'Fixed'], ['arp', 'Arpeggio'], ['random', 'Random']], p.noteMode, (v) => { p.noteMode = v; upd(); })),
        row('Start note', select(Array.from({ length: n }, (_, d): [number, string] => [d, `${d + 1} · ${midiName(stepToMidi(d, m.key, m.scale))}`]), ((p.degree % n) + n) % n, (v) => { p.degree = v; upd(); })),
        row('Ball size', seg([[0, 'Small · high'], [1, 'Medium'], [2, 'Large · low']], p.size, (v) => { p.size = v as 0 | 1 | 2; upd(); })),
        row('Voice', select(voiceOpts(), p.voice, (v) => { p.voice = v; upd(); })),
        row('Launch speed', ...range(0, 4, 0.1, p.speed, (v) => v.toFixed(1), (v) => { p.speed = v; upd(); })),
      );
      break;
    }
    case 'drain':
      s.append(
        row('Bass note on catch', seg([[true, 'On'], [false, 'Off']], p.bass, (v) => { p.bass = v; upd(); })),
        row('Size', ...range(0.3, 1.5, 0.05, p.radius, (v) => v.toFixed(2), (v) => { p.radius = v; upd(); })),
      );
      break;
    case 'bumper':
      s.append(
        row('Note', select(noteOptions(m, -n, 2 * n), p.step, (v) => { p.step = v; upd(); })),
        row('Voice', select(voiceOpts(), p.voice, (v) => { p.voice = v; upd(); })),
        row('Kick', ...range(0, 8, 0.25, p.kick, (v) => v.toFixed(1), (v) => { p.kick = v; upd(); })),
      );
      break;
    case 'band': {
      const pitch = el('span', { className: 'val' });
      const showPitch = () => { pitch.textContent = midiName(stepToMidi(bandStep(p.length, m.scale), m.key, m.scale)); };
      showPitch();
      s.append(
        row('Pitch (from length)', pitch),
        row('Length', ...range(0.6, 8, 0.05, p.length, (v) => v.toFixed(2), (v) => { p.length = v; showPitch(); upd(); })),
        row('Voice', select(voiceOpts(), p.voice, (v) => { p.voice = v; upd(); })),
      );
      break;
    }
    case 'chime':
      s.append(
        row('Note', select(noteOptions(m, -n, 2 * n), p.step, (v) => { p.step = v; upd(); })),
        row('Voice', select(voiceOpts(), p.voice, (v) => { p.voice = v; upd(); })),
      );
      break;
    case 'rail':
      s.append(
        row('Note', select(noteOptions(m, -2 * n, n), p.step, (v) => { p.step = v; upd(); })),
        row('Voice', select(voiceOpts(), p.voice, (v) => { p.voice = v; upd(); })),
        row('Length', ...range(0.6, 8, 0.05, p.length, (v) => v.toFixed(2), (v) => { p.length = v; upd(); })),
      );
      break;
    case 'zone':
      s.append(
        row('Voice', select(voiceOpts(), p.voice, (v) => { p.voice = v; upd(); })),
        row('Size', ...range(0.4, 2.5, 0.05, p.radius, (v) => v.toFixed(2), (v) => { p.radius = v; upd(); })),
      );
      break;
    case 'transposer':
      s.append(
        row('Step', seg([['degree', '1 degree'], ['octave', '1 octave']], p.mode, (v) => { p.mode = v; upd(); })),
        row('Direction', seg([[1, 'Up'], [-1, 'Down']], p.dir, (v) => { p.dir = v as 1 | -1; upd(); })),
        row('Width', ...range(0.6, 5, 0.05, p.width, (v) => v.toFixed(2), (v) => { p.width = v; upd(); })),
      );
      break;
    case 'gate': {
      const beats = el('div', { className: 'seg' });
      p.openBeats.forEach((on, i) => {
        const b = el('button', { type: 'button', className: on ? 'on' : '' }, String(i + 1));
        b.addEventListener('click', () => { p.openBeats[i] = !p.openBeats[i]; b.classList.toggle('on', p.openBeats[i]); upd(); });
        beats.append(b);
      });
      s.append(
        row('Open on beats', beats),
        row('Length', ...range(0.6, 8, 0.05, p.length, (v) => v.toFixed(2), (v) => { p.length = v; upd(); })),
      );
      break;
    }
  }

  s.append(row('Rotation', ...range(-180, 180, 5, Math.round((((p.angle * 180) / Math.PI + 540) % 360) - 180), (v) => deg((v * Math.PI) / 180), (v) => { p.angle = (v * Math.PI) / 180; upd(); })));

  const actions = el('div', { className: 'actions' });
  if (LINK_SOURCES.includes(p.type)) {
    actions.append(button('Link to…', 'primary', () => app.startLink(p.id)));
    for (const t of p.links ?? []) {
      const tp = app.part(t);
      if (tp) {
        actions.append(button(`Unlink ${PART_INFO[tp.type].name}`, '', () => {
          p.links = (p.links ?? []).filter((l) => l !== t);
          if (!p.links.length) delete p.links;
          app.changed();
          openPartSettings(app, p);
        }));
      }
    }
  }
  actions.append(
    button('Duplicate', '', () => {
      const copy = { ...cloneMachine({ ...app.machine, parts: [p] }).parts[0], id: nextPartId(app.machine), x: Math.min(8.8, p.x + 0.6), y: Math.max(0.2, p.y - 0.6) } as Part;
      delete copy.links;
      app.addPart(copy);
      closeSheet();
    }),
    button('Delete', 'danger', () => { app.removePart(p.id); closeSheet(); }),
    button('Done', '', closeSheet),
  );
  s.append(actions);
}

export function openMenu(app: App): void {
  const m = app.machine;
  const s = openSheet('Machine', 'Global controls, saves and sharing');
  const name = el('input', { type: 'text', value: m.name, maxLength: 60 });
  name.addEventListener('change', () => { m.name = name.value.trim() || 'Untitled machine'; app.changed(); });
  s.append(
    row('Name', name),
    row('Swing', ...range(0, 100, 5, Math.round(m.swing * 100), (v) => `${v}%`, (v) => { m.swing = v / 100; app.changed(); })),
    row('Reverb', ...range(0, 100, 5, Math.round(m.reverb * 100), (v) => `${v}%`, (v) => { m.reverb = v / 100; app.engine.applySettings(m); app.changed(); })),
    row('Volume', ...range(0, 100, 5, Math.round(m.volume * 100), (v) => `${v}%`, (v) => { m.volume = v / 100; app.engine.applySettings(m); app.changed(); })),
    row('Table tilt', ...range(0, 30, 1, m.tilt, (v) => (v === 0 ? 'Flat' : `${v}°`), (v) => { app.sim.setTilt(v); app.changed(); })),
    row('Drum density', ...range(0, 100, 5, Math.round(m.drumDensity * 100), (v) => (v <= 20 ? 'Sparse' : v >= 80 ? 'Busy' : `${v}%`), (v) => { m.drumDensity = v / 100; app.changed(); })),
    row('Drum fade', ...range(1, 16, 1, m.fadeBars, (v) => `${v} bar${v === 1 ? '' : 's'}`, (v) => { m.fadeBars = v; app.changed(); })),
    row('Floor grid', seg([[true, 'Show'], [false, 'Hide']], app.showGrid, (v) => { app.showGrid = v; })),
  );
  const clearPins = el('div', { className: 'actions' },
    button('Clear drum pins', '', () => { app.sim.floor.setPins([]); m.pins = []; app.changed(); toast('Pins cleared'); }),
    button('Clear all parts', 'danger', () => {
      if (!confirm('Remove every part from this machine?')) return;
      app.setMachine({ ...cloneMachine(m), parts: [] });
      closeSheet();
    }),
  );
  s.append(clearPins);

  s.append(el('h3', {}, 'Machines'));
  const saves = el('ul', { className: 'saves' });
  const actions = el('div', { className: 'actions' },
    button('Save', 'primary', async () => {
      await saveAs(cloneMachine(m), m.name ? (await listSaves()).find((r) => r.name === m.name)?.id : undefined);
      toast(`Saved “${m.name}”`);
      void refresh();
    }),
    button('Save as copy', '', async () => {
      await saveAs(cloneMachine({ ...m, name: `${m.name} copy` }));
      void refresh();
    }),
    button('New empty', '', () => {
      const blank = defaultMachine();
      blank.name = 'Untitled machine';
      blank.parts = [createPart('spawner', 'p1', 4.5, 15), createPart('drain', 'p2', 4.5, 0.8)];
      blank.pins = [];
      app.setMachine(blank);
      closeSheet();
    }),
    button('Starter machine', '', () => { app.setMachine(defaultMachine()); closeSheet(); }),
  );
  s.append(actions, saves);
  const refresh = async () => {
    saves.innerHTML = '';
    const list = await listSaves().catch(() => []);
    if (!list.length) saves.append(el('li', {}, el('small', {}, 'No saved machines yet.')));
    for (const r of list) {
      saves.append(el('li', {},
        el('span', {}, r.name),
        el('small', {}, new Date(r.updated).toLocaleDateString()),
        button('Load', '', () => { app.setMachine(cloneMachine(r.machine)); closeSheet(); toast(`Loaded “${r.name}”`); }),
        button('✕', 'danger', async () => { await removeSave(r.id); void refresh(); }),
      ));
    }
  };
  void refresh();

  s.append(
    el('h3', {}, 'How it works'),
    el('p', { className: 'sub' },
      'Balls carry a note (color = scale degree, size = octave). Every contact plays on the next 16th, locked to the key and scale. ',
      'Balls rolling over the floor charge drum cells; the playhead fires charged cells once per bar. ',
      'Long-press a part for its settings; on desktop, right-click or double-click, scroll to rotate, and Space to play or pause.'),
    el('div', { className: 'actions' }, button('Done', '', closeSheet)),
  );
}
