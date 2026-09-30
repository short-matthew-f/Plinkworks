import { describe, expect, it } from 'vitest';
import { defaultMachine, normalizeMachine } from '../src/model/machine';
import { decodeMachine, encodeMachine } from '../src/model/share';

describe('machine state', () => {
  it('normalizes a default machine to itself', () => {
    const m = defaultMachine();
    expect(normalizeMachine(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });
  it('rejects junk and drops invalid links', () => {
    const m = normalizeMachine({
      bpm: 9999, scale: 'nope', parts: [
        { id: 'p1', type: 'bumper', x: 3, y: 4, links: ['p2', 'p3', 'p9'] },
        { id: 'p2', type: 'spawner', x: 1, y: 1 },
        { id: 'p3', type: 'chime', x: 1, y: 1 },
        { id: 'p4', type: 'laser', x: 1, y: 1 },
      ],
    });
    expect(m.bpm).toBe(200);
    expect(m.scale).toBe('majorPent');
    expect(m.parts.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(m.parts[0].links).toEqual(['p2']);
  });
  it('round-trips through a share code', async () => {
    const m = defaultMachine();
    const code = await encodeMachine(m);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = await decodeMachine(code);
    expect(back.parts.length).toBe(m.parts.length);
    expect(back.bpm).toBe(m.bpm);
    expect(back.parts[0]).toEqual(m.parts[0]);
  });
});
