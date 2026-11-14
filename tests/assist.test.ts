import { describe, expect, it } from 'vitest';
import { designs, lanes } from '../src/data';
import { laneSeeds, runAssisted } from '../src/game';
import { ASSIST_TOOLS, damageCell, runHeadless, Sim, type LaneDef } from '../src/sim';
import { content, design, emptyLane, part, rect } from './helpers';

const ROCK = 1;
const MONOLITH = 3;
const platform = () => design([...rect(0, 0, 5, 3)], [part('core', 0, 0), part('storage', 3, 0)]);
const lane = (overrides: Partial<LaneDef> = {}) => emptyLane({
  length: 5000, allowance: {},
  assist: [{ tool: 'deck_gun', cooldownSeconds: 3, damage: 150 }, { tool: 'patch', cooldownSeconds: 20, hp: 200 }],
  ...overrides,
});
const tap = (sim: Sim, tool: string, target: any, tick = sim.tick) => sim.enqueue({ tick, type: 'assist', tool, target });

describe('deck gun', () => {
  it('kills a rock in one tap and drops its chunks', () => {
    const sim = new Sim(content, platform(), lane(), 1);
    const slot = sim.asteroids.add(ROCK, 0, sim.ship.x + 20, sim.ship.y - 20, 0, 0, 120);
    tap(sim, 'deck_gun', { kind: 'asteroid', id: sim.asteroids.id[slot] });
    sim.step();
    expect(sim.asteroids.live).toBe(0);
    expect(sim.loose.live).toBe(2);
    expect(sim.asteroidsShot).toBe(1);
  });

  it('does kinetic damage, so it barely scratches a monolith', () => {
    const sim = new Sim(content, platform(), lane(), 1);
    const slot = sim.asteroids.add(MONOLITH, 0, sim.ship.x + 20, sim.ship.y - 20, 0, 0, 4000);
    tap(sim, 'deck_gun', { kind: 'asteroid', id: sim.asteroids.id[slot] });
    sim.step();
    expect(sim.asteroids.hp[slot]).toBe(4000 - 15);
  });

  it('obeys its cooldown', () => {
    const sim = new Sim(content, platform(), lane(), 1);
    const ids = [0, 1, 2].map((i) => sim.asteroids.id[sim.asteroids.add(ROCK, 0, sim.ship.x + 20 + i * 3, sim.ship.y - 20, 0, 0, 120)]);
    tap(sim, 'deck_gun', { kind: 'asteroid', id: ids[0] }, 0);
    tap(sim, 'deck_gun', { kind: 'asteroid', id: ids[1] }, 89);
    tap(sim, 'deck_gun', { kind: 'asteroid', id: ids[2] }, 90);
    for (let i = 0; i < 100; i++) sim.step();
    // The tap at tick 89 was inside the 3 s cooldown and did nothing.
    expect(sim.asteroidsShot).toBe(2);
    expect(sim.asteroids.live).toBe(1);
    expect(Array.from(sim.assistUses)).toEqual([2, 0]);
  });

  it('spends no cooldown on a target that is already gone', () => {
    const sim = new Sim(content, platform(), lane(), 1);
    const id = sim.asteroids.id[sim.asteroids.add(ROCK, 0, sim.ship.x + 20, sim.ship.y - 20, 0, 0, 120)];
    tap(sim, 'deck_gun', { kind: 'asteroid', id: 9999 }, 0);
    tap(sim, 'deck_gun', { kind: 'asteroid', id }, 1);
    for (let i = 0; i < 3; i++) sim.step();
    expect(sim.asteroidsShot).toBe(1);
  });
});

describe('patch', () => {
  it('restores HP to a damaged part, capped at full', () => {
    const sim = new Sim(content, platform(), lane(), 1);
    damageCell(sim.ship, 0, 0, 700);
    damageCell(sim.ship, 3, 0, 100);
    tap(sim, 'patch', { kind: 'part', part: 0 }, 0);
    tap(sim, 'patch', { kind: 'part', part: 1 }, 600);
    for (let i = 0; i < 601; i++) sim.step();
    expect(sim.ship.partHp[0]).toBe(500);
    expect(sim.ship.partHp[1]).toBe(150);
  });

  it('does nothing, and stays ready, on an undamaged part', () => {
    const sim = new Sim(content, platform(), lane(), 1);
    tap(sim, 'patch', { kind: 'part', part: 1 });
    sim.step();
    expect(sim.assistReady[1]).toBe(0);
    expect(Array.from(sim.assistUses)).toEqual([0, 0]);
  });
});

describe('assisted runs', () => {
  it('ignores tools the lane does not offer', () => {
    const sim = new Sim(content, platform(), lane({ assist: [{ tool: 'patch', cooldownSeconds: 20, hp: 200 }] }), 1);
    const slot = sim.asteroids.add(ROCK, 0, sim.ship.x + 20, sim.ship.y - 20, 0, 0, 120);
    tap(sim, 'deck_gun', { kind: 'asteroid', id: sim.asteroids.id[slot] });
    sim.step();
    expect(sim.asteroids.live).toBe(1);
    const solo = new Sim(content, platform(), emptyLane({ length: 5000, allowance: {} }), 1);
    const s2 = solo.asteroids.add(ROCK, 0, solo.ship.x + 20, solo.ship.y - 20, 0, 0, 120);
    tap(solo, 'deck_gun', { kind: 'asteroid', id: solo.asteroids.id[s2] });
    solo.step();
    expect(solo.asteroids.live).toBe(1);
  });

  it('every tool a lane lists exists', () => {
    for (const l of Object.values(lanes)) {
      for (const a of l.assist ?? []) expect(ASSIST_TOOLS[a.tool]?.id).toBe(a.tool);
    }
  });

  it('replays an assisted run exactly from its input log', () => {
    const seed = laneSeeds('lane1', 20)[3];
    const live = new Sim(content, designs.starter, lanes.lane1, seed);
    // Shoot whatever is nearest ahead every 4 s, as a stand-in for a player.
    while (live.outcome === 'running') {
      if (live.tick % 120 === 60) {
        const a = live.asteroids;
        let best = -1;
        for (let i = 0; i < a.high; i++) if (a.alive[i] && (best < 0 || a.y[i] > a.y[best])) best = i;
        if (best >= 0) tap(live, 'deck_gun', { kind: 'asteroid', id: a.id[best] }, live.tick + 2);
      }
      live.step();
    }
    expect(live.inputLog.length).toBeGreaterThan(20);
    const replay = runHeadless(content, designs.starter, lanes.lane1, seed, live.inputLog);
    expect(replay.stateHash).toBe(live.stateHash());
    expect(replay.assistUses.deck_gun).toBeGreaterThan(10);
    // The same seed without input is a different run.
    expect(runHeadless(content, designs.starter, lanes.lane1, seed).stateHash).not.toBe(replay.stateHash);
  });

  it('lets the starter ship be carried: assisted clears where solo fails, at a calm pace', () => {
    const seeds = laneSeeds('lane1', 20);
    let solo = 0;
    let assisted = 0;
    let taps = 0;
    let minutes = 0;
    for (const seed of seeds) {
      if (runHeadless(content, designs.starter, lanes.lane1, seed).outcome === 'success') solo++;
      const r = runAssisted(content, designs.starter, lanes.lane1, seed);
      if (r.outcome === 'success') assisted++;
      taps += (r.assistUses.deck_gun ?? 0) + (r.assistUses.patch ?? 0);
      minutes += r.seconds / 60;
    }
    expect(solo).toBeLessThan(16);
    expect(assisted).toBeGreaterThanOrEqual(18);
    // Section 13: under 20 taps a minute, so it never plays like an action game.
    expect(taps / minutes).toBeLessThan(20);
  });
});
