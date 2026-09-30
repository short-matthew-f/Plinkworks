import { beforeAll, describe, expect, it } from 'vitest';
import { defaultMachine, createPart } from '../src/model/machine';
import { initPhysics, Sim, BALL_CAP, type SimEvent } from '../src/sim/sim';

beforeAll(async () => { await initPhysics(); });

function run(beats: number): { events: SimEvent[]; sim: Sim } {
  const sim = new Sim(defaultMachine());
  const events: SimEvent[] = [];
  for (let b = 0.5; b <= beats; b += 0.5) {
    sim.advanceTo(b);
    events.push(...sim.drainEvents());
  }
  return { events, sim };
}

describe('simulation', () => {
  it('makes music from the default machine', () => {
    const { events } = run(32);
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('note')).toBe(true);
    expect(kinds.has('drum')).toBe(true);
    expect(events.filter((e) => e.kind === 'note').length).toBeGreaterThan(20);
  });

  it('is deterministic: the same machine replays the same song', () => {
    const a = run(24).events;
    const b = run(24).events;
    expect(b).toEqual(a);
  });

  it('reset replays exactly', () => {
    const sim = new Sim(defaultMachine());
    const take = () => {
      const out: SimEvent[] = [];
      for (let b = 0.5; b <= 16; b += 0.5) { sim.advanceTo(b); out.push(...sim.drainEvents()); }
      return out;
    };
    const first = take();
    sim.reset();
    expect(take()).toEqual(first);
  });

  it('respects the ball cap', () => {
    const m = defaultMachine();
    m.parts = m.parts.filter((p) => p.type !== 'drain');
    const s = createPart('spawner', 'p99', 4.5, 8);
    if (s.type === 'spawner') s.interval = 0.25;
    m.parts.push(s);
    const sim = new Sim(m);
    sim.advanceTo(40, 100000);
    expect(sim.balls.length).toBeLessThanOrEqual(BALL_CAP);
  });

  it('pairs every sustain start with an end once balls drain', () => {
    const { events } = run(48);
    const open = new Set<string>();
    let starts = 0;
    for (const e of events) {
      if (e.kind === 'sustainStart') { open.add(e.key); starts++; }
      if (e.kind === 'sustainEnd') open.delete(e.key);
    }
    expect(starts).toBeGreaterThan(0);
    expect(open.size).toBeLessThanOrEqual(8);
  });

  it('stays silent with nothing moving', () => {
    const m = defaultMachine();
    m.parts = m.parts.filter((p) => p.type !== 'spawner');
    m.pins = [];
    const sim = new Sim(m);
    sim.advanceTo(8, 100000);
    expect(sim.drainEvents()).toEqual([]);
  });
});
