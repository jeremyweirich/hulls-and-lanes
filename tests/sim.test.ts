import { describe, expect, it } from 'vitest';
import { designs, lanes } from '../src/data';
import {
  Asteroids, buildShip, collideAsteroids, coreWorldX, recomputeMass, runHeadless, Sim, Spawner,
} from '../src/sim';
import { content, design, emptyLane, part, rect, twinThruster } from './helpers';

const K = content.constants;
const SIZE = { pebble: 0, rock: 1, boulder: 2, monolith: 3 };

function run(sim: Sim, ticks: number): void {
  for (let i = 0; i < ticks; i++) sim.step();
}

describe('flight', () => {
  it('accelerates to cruise and holds heading on an empty lane', () => {
    const sim = new Sim(content, twinThruster(), emptyLane({ length: 2000 }), 1);
    run(sim, 30 * 40);
    // Proportional control against 3%/s drag settles just under the target.
    expect(sim.forwardSpeed).toBeGreaterThan(5.7);
    expect(sim.forwardSpeed).toBeLessThan(6);
    expect(Math.abs(sim.ship.theta)).toBeLessThan(0.01);
    expect(Math.abs(coreWorldX(sim.ship))).toBeLessThan(0.5);
  });

  it('finishes the lane when the core passes its length', () => {
    const r = runHeadless(content, twinThruster(), emptyLane(), 1);
    expect(r.outcome).toBe('success');
    expect(r.laneShare).toBe(1);
    expect(r.seconds).toBeGreaterThan(50);
    expect(r.seconds).toBeLessThan(70);
    expect(r.fuelLeft).toBeLessThan(150);
  });

  it('drifts without a flight computer and times out', () => {
    const d = twinThruster();
    d.parts.splice(1, 1);
    const lane = emptyLane({ length: 60 });
    const r = runHeadless(content, d, lane, 1);
    expect(r.outcome).toBe('failure');
    expect(r.cause).toBe('time_limit');
    expect(r.seconds).toBeCloseTo(K.run.timeLimitFactor * (60 / 6), 5);
    expect(r.laneShare).toBe(0);
    expect(r.fuelLeft).toBe(150);
  });

  it('loses about 3% of its speed per second when coasting', () => {
    const d = twinThruster();
    d.parts.splice(1, 1);
    const sim = new Sim(content, d, emptyLane({ length: 5000 }), 1);
    sim.ship.vy = -10;
    run(sim, 30);
    expect(sim.forwardSpeed).toBeCloseTo(10 * 0.97, 2);
    // Half the speed is gone after about 23 s.
    run(sim, 30 * 22);
    expect(sim.forwardSpeed).toBeGreaterThan(4.8);
    expect(sim.forwardSpeed).toBeLessThan(5.2);
  });

  it('coasts once the fuel runs dry, and reports it', () => {
    const r = runHeadless(content, twinThruster(), emptyLane({ length: 3000, allowance: { fuel: 10 } }), 1);
    expect(r.outcome).toBe('failure');
    expect(r.cause).toBe('time_limit');
    expect(r.fuelLeft).toBe(0);
    expect(r.events.some((e) => e.type === 'fuel_ran_dry')).toBe(true);
  });

  it('fails a ship that stays outside the lane', () => {
    const sim = new Sim(content, twinThruster(), emptyLane({ length: 5000 }), 1);
    sim.ship.x += 30;
    run(sim, K.run.outOfLaneSeconds * K.tickRate - 1);
    expect(sim.outcome).toBe('running');
    sim.step();
    expect(sim.outcome).toBe('failure');
    expect(sim.cause).toBe('left_lane');
  });

  it('steers back with Center in lane when it has side thrusters', () => {
    // A 5-wide hull (x2..6) with rear thrusters, plus a sideways thruster on
    // each flank at row 1, all fed from one tank by pipes up both edges.
    const d = design(
      [...rect(2, 0, 5, 7), [2, 7], [2, 8], [6, 7], [6, 8], [0, 1], [1, 1], [7, 1], [8, 1]],
      [
        part('core', 3, 2),
        part('computer_mk2', 4, 0, 0, { behaviors: [{ id: 'drive_forward', cruise: 6 }, { id: 'center_in_lane' }] }),
        part('fuel_tank', 3, 5),
        ...[1, 2, 3, 4, 5, 6].map((y) => part('fuel_pipe', 2, y)),
        ...[1, 2, 3, 4, 5, 6].map((y) => part('fuel_pipe', 6, y)),
        part('fuel_pipe', 5, 6),
        part('thruster', 2, 7, 180),
        part('thruster', 6, 7, 180),
        part('thruster', 0, 1, 270),
        part('thruster', 7, 1, 90),
      ],
    );
    const sim = new Sim(content, d, emptyLane({ length: 5000 }), 1);
    sim.ship.x += 12;
    run(sim, 30 * 30);
    expect(Math.abs(coreWorldX(sim.ship))).toBeLessThan(6);
    expect(sim.outcome).toBe('running');
  });
});

describe('asteroid impacts', () => {
  function setup() {
    const ship = buildShip(content, twinThruster());
    recomputeMass(ship, content, false);
    const asteroids = new Asteroids(8);
    return { ship, asteroids };
  }

  it('scales damage with the square of closing speed', () => {
    for (const speed of [6, 12]) {
      const { ship, asteroids } = setup();
      // A rock dropping onto the bare front tile at (2,0), dead center of the cell.
      asteroids.add(SIZE.rock, 0, ship.x + (2.5 - ship.comX), ship.y + (0 - ship.comY) - 0.9, 0, speed, 120);
      collideAsteroids(ship, asteroids, content);
      const dealt = 60 * (speed / 6) ** 2;
      if (dealt < 100) {
        expect(ship.cellHp[2]).toBeCloseTo(100 - dealt, 9);
        expect(asteroids.hp[0]).toBeCloseTo(120 - dealt, 9);
      } else {
        // 240 damage: destroys the tile (100), spills into the next cell down.
        expect(ship.cellTile[2]).toBe(0);
        expect(ship.cellHp[ship.gw + 2]).toBeCloseTo(0, 9);
        expect(asteroids.alive[0]).toBe(0);
      }
    }
  });

  it('limits how many cells a hit can carry through', () => {
    const { ship, asteroids } = setup();
    // A fast pebble: far more damage than two tiles hold, but it spills at most 1 cell.
    asteroids.add(SIZE.pebble, 0, ship.x + (2.5 - ship.comX), ship.y + (0 - ship.comY) - 0.3, 0, 30, 20);
    collideAsteroids(ship, asteroids, content);
    expect(ship.cellTile[2]).toBe(0);
    expect(ship.cellTile[ship.gw + 2]).toBe(0);
    expect(ship.partHp[ship.corePart]).toBe(1000);
  });

  it('conserves momentum when the asteroid survives and bounces', () => {
    const { ship, asteroids } = setup();
    const m = content.asteroidSizes[SIZE.boulder].mass;
    asteroids.add(SIZE.boulder, 0, ship.x + (2.5 - ship.comX), ship.y + (0 - ship.comY) - 1.9, 0, 3, 400);
    const before = m * 3;
    collideAsteroids(ship, asteroids, content);
    expect(asteroids.alive[0]).toBe(1);
    expect(ship.mass * ship.vy + m * asteroids.vy[0]).toBeCloseTo(before, 9);
    // Restitution 0.2: they separate at a fifth of the closing speed.
    const armX = 2.5 - ship.comX;
    expect(ship.vy + ship.omega * armX - asteroids.vy[0]).toBeCloseTo(0.2 * 3, 9);
    // And the asteroid no longer overlaps the hull.
    expect(ship.y - ship.comY - asteroids.y[0]).toBeGreaterThan(2);
  });

  it('spins the ship when hit off-center', () => {
    const { ship, asteroids } = setup();
    asteroids.add(SIZE.rock, 0, ship.x + (4.5 - ship.comX), ship.y + (0 - ship.comY) - 0.9, 0, 6, 120);
    collideAsteroids(ship, asteroids, content);
    // A push toward +y on the right side turns the ship clockwise (positive).
    expect(ship.omega).toBeGreaterThan(0.01);
  });

  it('ignores asteroids that are moving away', () => {
    const { ship, asteroids } = setup();
    asteroids.add(SIZE.rock, 0, ship.x + (2.5 - ship.comX), ship.y + (0 - ship.comY) - 0.9, 0, -2, 120);
    collideAsteroids(ship, asteroids, content);
    expect(ship.cellHp[2]).toBe(100);
    expect(ship.vy).toBe(0);
  });

  it('ends the run when a monolith goes through the core', () => {
    const lane = emptyLane({ length: 5000 });
    const sim = new Sim(content, twinThruster(), lane, 1);
    sim.asteroids.add(SIZE.monolith, 0, coreWorldX(sim.ship), sim.ship.y - 30, 0, 6, 4000);
    while (sim.outcome === 'running') sim.step();
    expect(sim.cause).toBe('core_destroyed_by_impact');
    expect(sim.result().events[0].type).toBe('first_part_lost');
  });
});

describe('spawning', () => {
  it('builds each slice from the seed and slice number only', () => {
    const snapshot = (stepSize: number) => {
      const a = new Asteroids(4000);
      const sp = new Spawner({ ...content, constants: { ...K, caps: { ...K.caps, asteroids: 4000 } } }, lanes.lane1, 99);
      for (let d = 0; d <= 1200; d += stepSize) sp.step(a, d);
      return Array.from(a.x.slice(0, a.high)).join() + Array.from(a.y.slice(0, a.high)).join()
        + Array.from(a.size.slice(0, a.high)).join();
    };
    expect(snapshot(1)).toBe(snapshot(37));
  });

  it('matches the lane densities on average and respects the clear start', () => {
    const a = new Asteroids(4000);
    const sp = new Spawner(content, lanes.lane1, 5);
    let pebbles = 0;
    let rocks = 0;
    const big = new Asteroids(100000);
    for (let seed = 0; seed < 50; seed++) {
      const s = new Spawner(content, lanes.lane1, seed);
      s.step(big, 2000);
    }
    for (let i = 0; i < big.high; i++) {
      if (big.size[i] === SIZE.pebble) pebbles++;
      else rocks++;
      expect(-big.y[i]).toBeGreaterThanOrEqual(lanes.lane1.clearStart);
      expect(Math.abs(big.x[i])).toBeLessThanOrEqual(lanes.lane1.width / 2);
    }
    // Expected per run: pebbles 3*3.6 + 4*5 + 5*3 = 45.8, rocks 0.6*3.6 + 1.2*5 + 1.8*3 = 13.56.
    expect(pebbles / 50).toBeGreaterThan(43);
    expect(pebbles / 50).toBeLessThan(48.5);
    expect(rocks / 50).toBeGreaterThan(12);
    expect(rocks / 50).toBeLessThan(15);
    sp.step(a, 0);
    expect(a.live).toBeLessThanOrEqual(K.caps.asteroids);
  });

  it('defers a slice that does not fit under the cap', () => {
    const a = new Asteroids(3);
    const sp = new Spawner(content, lanes.lane1, 5);
    sp.step(a, 1200);
    expect(a.live).toBeLessThanOrEqual(3);
    const stuckAt = sp.nextSlice;
    sp.step(a, 1200);
    expect(sp.nextSlice).toBe(stuckAt);
    for (let i = 0; i < a.high; i++) if (a.alive[i]) a.remove(i);
    sp.step(a, 1200);
    expect(sp.nextSlice).toBeGreaterThan(stuckAt);
  });
});

describe('determinism', () => {
  it('produces the same run for the same inputs', () => {
    const a = runHeadless(content, designs.starter, lanes.lane1, 7);
    const b = runHeadless(content, designs.starter, lanes.lane1, 7);
    expect(a).toEqual(b);
    expect(a.stateHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces different runs for different seeds', () => {
    const a = runHeadless(content, designs.starter, lanes.lane1, 7);
    const b = runHeadless(content, designs.starter, lanes.lane1, 8);
    expect(a.stateHash).not.toBe(b.stateHash);
  });

  it('replays a recorded input queue exactly', () => {
    const live = new Sim(content, designs.starter, lanes.lane1, 3);
    run(live, 500);
    live.enqueue({ tick: live.tick + 10, type: 'abort' });
    while (live.outcome === 'running') live.step();
    expect(live.cause).toBe('aborted');
    expect(live.tick).toBe(510);
    const replay = runHeadless(content, designs.starter, lanes.lane1, 3, live.inputLog);
    expect(replay.stateHash).toBe(live.stateHash());
  });

  it('flies the starter ship down Lane 1 with no input', () => {
    const r = runHeadless(content, designs.starter, lanes.lane1, 2);
    expect(r.outcome).toBe('success');
    expect(r.seconds).toBeGreaterThan(200);
    expect(r.seconds).toBeLessThan(230);
  });
});
