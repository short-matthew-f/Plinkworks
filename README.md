# Plinkworks

A physics sandbox that makes music. Place parts on a tilted table; balls flow through them, and every
contact becomes a note locked to a scale and a beat. A Rube Goldberg machine whose only output is music.

This is the MVP from the design document (Sep 29, 2026): sandbox mode, installable offline PWA, mobile-first.

## Run

```sh
npm install
npm run dev        # http://localhost:5173/Plinkworks/
npm run check      # typecheck + unit tests
npm run build      # static site in dist/
npm run smoke      # after build: plays the app in headless Chromium, fails on errors
```

Pushes to `main` build, test and deploy to GitHub Pages (`.github/workflows/deploy.yml`); enable Pages
with source "GitHub Actions" in the repo settings.

## How the design maps to code

| Design | Where |
| --- | --- |
| Scale lock: pitches are scale steps, never raw notes | `src/model/music.ts` |
| Time lock: quantize to the next 16th, 0–100% slider, swing | `src/audio/timing.ts` |
| Deterministic Rapier 2D at 120 Hz, pegged to beats; seeded RNG | `src/sim/sim.ts`, `src/sim/rng.ts` |
| Drum floor: 16×8, charge / fade / pin / playhead | `src/sim/floor.ts` |
| Tone.js voices, voice caps, acoustic kit, rain bed, ducking, energy→pad, balls→rain | `src/audio/engine.ts` |
| Musical clock on the audio context; sim runs 100 ms ahead so every note is scheduled | `src/audio/clock.ts`, `src/ui/app.ts` |
| Glows fire at play time, not impact | `src/render/renderer.ts` (flashes carry audio time) |
| Machine JSON, IndexedDB saves, compressed share URL | `src/model/machine.ts`, `src/storage/db.ts`, `src/model/share.ts` |
| Drawer, drag / twist / stretch / long-press, link mode, floor pins | `src/ui/` |

MVP parts: spawner, drain, bumper, rubber band, chime peg, bowed rail, resonator zone, transposer gate,
beat gate. Links: bumper, beat gate and drain → spawner and beat gate.

## Deviations and open items

- **Voices are synthesized stand-ins.** Kalimba, mallets and cello are Tone.js synths for now; the
  design calls for samples (VCSL / Freesound CC0). The voice pool in `engine.ts` is the seam where a
  `Tone.Sampler` drops in once sample packs are sourced, license-checked and prepped (open question:
  sustained cello coverage in VCSL). The acoustic kit is likewise synthesized.
- **Clock.** Musical time comes from the audio context via a small `Clock` rather than
  `Tone.Transport`; it plays the same role (single source of musical time, lookahead scheduling) and
  keeps BPM changes and pause/resume exact.
- **Drum floor tuning.** Firing spends a cell's charge, so a cell keeps hitting only while balls keep
  feeding it; a **Drum density** control (menu) sets how much charge a cell needs. The starter
  machine plays about 13 hits a bar at the default (9 sparse, 27 busy).
- **Beat gate.** "Open beats" are the four beats of the bar; a link trigger opens it for one beat.
- **Transposer (+1 degree)** carries into the next octave (a smaller ball) when it wraps past the top degree.
- **Saves:** unlimited named slots in a list (open question on slots/gallery).
- Rubber bands retune live while being stretched (open question).
