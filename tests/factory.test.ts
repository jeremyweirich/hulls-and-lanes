import { describe, expect, it } from 'vitest';
import { designs, lanes } from '../src/data';
import {
  addItem, buildShip, compile, damageCell, itemCount, resolveStructure, shipItemCount, Sim,
  stepBelts, stepInserters, stepMachines, stepRepair, type Design, type Ship,
} from '../src/sim';
import { content, design, emptyLane, part, rect } from './helpers';

const cc = compile(content);
const IT = cc.itemIndex;
const L = content.constants.logistics;

/** Runs the factory steps only (no flight), in tick order. */
function factory(s: Ship, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    stepBelts(s, content);
    stepInserters(s, content, cc);
    stepMachines(s, content, cc);
  }
}

/** Part id at a design cell. */
const at = (s: Ship, x: number, y: number) => s.cellPart[y * s.gw + x];

describe('belts', () => {
  const line = () => buildShip(content, design(rect(0, 0, 5, 5), [
    part('core', 0, 0),
    part('belt', 0, 3, 90), part('belt', 1, 3, 90), part('belt', 2, 3, 90), part('belt', 3, 3, 90),
    part('belt', 2, 4, 0),
  ]));

  it('moves an item one tile per move interval and holds it at the end', () => {
    const s = line();
    s.beltItem[at(s, 0, 3)] = IT.metal_ore;
    factory(s, L.beltMoveTicks - 1);
    expect(s.beltItem[at(s, 0, 3)]).toBe(IT.metal_ore);
    factory(s, 1);
    expect(s.beltItem[at(s, 1, 3)]).toBe(IT.metal_ore);
    factory(s, L.beltMoveTicks * 5);
    expect(s.beltItem[at(s, 3, 3)]).toBe(IT.metal_ore);
    expect(s.beltItem[at(s, 2, 3)]).toBe(-1);
  });

  it('moves a full line together once the head is free', () => {
    const s = line();
    for (let x = 0; x < 4; x++) s.beltItem[at(s, x, 3)] = x;
    factory(s, 40);
    expect([0, 1, 2, 3].map((x) => s.beltItem[at(s, x, 3)])).toEqual([0, 1, 2, 3]);
    s.beltItem[at(s, 3, 3)] = -1;
    factory(s, 1);
    expect([0, 1, 2, 3].map((x) => s.beltItem[at(s, x, 3)])).toEqual([-1, 0, 1, 2]);
  });

  it('feeds into the side of another belt', () => {
    const s = line();
    s.beltItem[at(s, 2, 4)] = IT.carbon;
    factory(s, L.beltMoveTicks);
    expect(s.beltItem[at(s, 2, 3)]).toBe(IT.carbon);
  });

  it('does not feed a belt head-on', () => {
    const s = buildShip(content, design(rect(0, 0, 3, 4), [
      part('core', 0, 0), part('belt', 0, 3, 90), part('belt', 1, 3, 270),
    ]));
    s.beltItem[at(s, 0, 3)] = IT.carbon;
    factory(s, 100);
    expect(s.beltItem[at(s, 0, 3)]).toBe(IT.carbon);
  });

  it('stops where it is cut', () => {
    const s = line();
    damageCell(s, 2, 3, 1000);
    resolveStructure(s, content);
    s.beltItem[at(s, 0, 3)] = IT.metal_ore;
    factory(s, 200);
    expect(s.beltItem[at(s, 1, 3)]).toBe(IT.metal_ore);
  });
});

describe('inserters and machines', () => {
  // core -> crusher -> smelter -> storage, left to right along the top rows.
  const chain = (): Design => design(rect(0, 0, 12, 3), [
    part('core', 0, 0),
    part('inserter', 3, 0, 90), part('crusher', 4, 0),
    part('inserter', 6, 0, 90), part('smelter', 7, 0),
    part('inserter', 9, 0, 90), part('storage', 10, 0),
  ]);

  it('turns chunks into plates down a production line', () => {
    const s = buildShip(content, chain());
    addItem(s, s.corePart, IT.metal_chunk, 3);
    factory(s, 30 * 30);
    const storage = at(s, 10, 0);
    expect(itemCount(s, storage, IT.iron_plate)).toBe(6);
    expect(shipItemCount(s, IT.metal_chunk)).toBe(0);
    expect(shipItemCount(s, IT.metal_ore)).toBe(0);
    expect(s.partItems[storage]).toBe(6);
    expect(s.partItems[s.corePart]).toBe(0);
  });

  it('buffers at most two crafts of input and stalls on full output', () => {
    const d = chain();
    d.parts.splice(3, 4);
    const s = buildShip(content, d);
    addItem(s, s.corePart, IT.metal_chunk, 20);
    factory(s, 30 * 60);
    const crusher = at(s, 4, 0);
    // Nothing takes the ore away: output holds two crafts (4 ore), input two chunks.
    expect(itemCount(s, crusher, IT.metal_ore)).toBe(4);
    expect(itemCount(s, crusher, IT.metal_chunk)).toBe(2);
    expect(itemCount(s, s.corePart, IT.metal_chunk)).toBe(20 - 2 - 2);
  });

  it('takes one item per inserter cycle', () => {
    const s = buildShip(content, design(rect(0, 0, 6, 3), [
      part('core', 0, 0), part('inserter', 3, 0, 90), part('storage', 4, 0),
    ]));
    addItem(s, s.corePart, IT.iron_plate, 50);
    factory(s, 1 + L.inserterTicks * 4);
    expect(itemCount(s, at(s, 4, 0), IT.iron_plate)).toBe(4);
  });

  it('only moves what the destination accepts, and obeys its filter', () => {
    const s = buildShip(content, design(rect(0, 0, 6, 6), [
      part('core', 0, 0),
      part('inserter', 3, 0, 90), part('autocannon', 4, 0),
      part('inserter', 3, 2, 90, { filter: 'carbon' }), part('storage', 4, 2),
    ]));
    addItem(s, s.corePart, IT.iron_plate, 5);
    addItem(s, s.corePart, IT.carbon, 2);
    addItem(s, s.corePart, IT.slugs, 30);
    factory(s, 30 * 60);
    // The turret takes only slugs, up to 20. The filtered inserter moves only carbon.
    expect(itemCount(s, at(s, 4, 0), IT.slugs)).toBe(20);
    expect(s.partItems[at(s, 4, 0)]).toBe(20);
    expect(itemCount(s, at(s, 4, 2), IT.carbon)).toBe(2);
    expect(s.partItems[at(s, 4, 2)]).toBe(2);
    expect(itemCount(s, s.corePart, IT.iron_plate)).toBe(5);
  });

  it('lets the crusher switch material only when it is empty', () => {
    const d = chain();
    const s = buildShip(content, d);
    addItem(s, s.corePart, IT.metal_chunk, 1);
    addItem(s, s.corePart, IT.carbon_chunk, 1);
    factory(s, 30 * 30);
    // Metal went through first; carbon followed once the crusher had emptied.
    // The smelter cannot use carbon, so it waits in the crusher's output.
    expect(itemCount(s, at(s, 10, 0), IT.iron_plate)).toBe(2);
    expect(itemCount(s, at(s, 4, 0), IT.carbon)).toBe(2);
  });

  it('runs fuel recipes against the fuel network', () => {
    const s = buildShip(content, design(rect(0, 0, 9, 3), [
      part('core', 0, 0), part('inserter', 3, 0, 90),
      part('chem_plant', 4, 0, 0, { recipe: 'fuel' }), part('fuel_pipe', 6, 0), part('fuel_tank', 7, 0),
    ]));
    addItem(s, s.corePart, IT.ice_crystal, 4);
    factory(s, 30 * 20);
    expect(s.partFuel[at(s, 7, 0)]).toBe(10);
  });

  it('loses the inventory of a destroyed part', () => {
    const s = buildShip(content, chain());
    const storage = at(s, 10, 0);
    addItem(s, storage, IT.iron_plate, 40);
    damageCell(s, 10, 0, 1000);
    expect(shipItemCount(s, IT.iron_plate)).toBe(0);
    expect(s.partItems[storage]).toBe(0);
  });
});

describe('core repair', () => {
  it('spends a kit per interval on the damaged part nearest the core', () => {
    const s = buildShip(content, design(rect(0, 0, 9, 3), [
      part('core', 0, 0), part('storage', 3, 0), part('storage', 6, 0),
    ]));
    addItem(s, s.corePart, IT.repair_kit, 3);
    damageCell(s, 3, 0, 120);
    damageCell(s, 6, 0, 120);
    for (let i = 0; i < L.repairTicks; i++) stepRepair(s, content, cc);
    expect(s.partHp[1]).toBe(30 + L.repairHp);
    expect(s.partHp[2]).toBe(30);
    for (let i = 0; i < L.repairTicks * 5; i++) stepRepair(s, content, cc);
    // The near part gets the other two kits as well, capped at full HP.
    expect(s.partHp[1]).toBe(150);
    expect(s.partHp[2]).toBe(30);
    expect(itemCount(s, s.corePart, IT.repair_kit)).toBe(0);
  });
});

describe('collectors', () => {
  const ship = () => design(rect(0, 0, 6, 3), [
    part('core', 0, 0), part('collector', 4, 0),
  ]);

  it('pulls in loose items within range, one per intake interval', () => {
    const sim = new Sim(content, ship(), emptyLane({ length: 5000 }), 1);
    const s = sim.ship;
    // Collector center is at grid (5,1). Drop three chunks 4 u to its right, one far away.
    const cx = s.x + (5 - s.comX);
    const cy = s.y + (1 - s.comY);
    for (let i = 0; i < 3; i++) sim.loose.add(IT.metal_chunk, cx + 4, cy + i * 0.5, 0, 0);
    sim.loose.add(IT.metal_chunk, cx + L.collectorRange + 3, cy, 0, 0);
    for (let i = 0; i < 25; i++) sim.step();
    expect(sim.chunksCollected).toBe(1);
    for (let i = 0; i < L.collectorIntakeTicks * 2; i++) sim.step();
    expect(sim.chunksCollected).toBe(3);
    expect(itemCount(s, 1, IT.metal_chunk)).toBe(3);
    expect(sim.loose.live).toBe(1);
  });

  it('stops taking items when its buffer is full', () => {
    const sim = new Sim(content, ship(), emptyLane({ length: 5000 }), 1);
    const s = sim.ship;
    const cx = s.x + (5 - s.comX);
    const cy = s.y + (1 - s.comY);
    for (let i = 0; i < 14; i++) sim.loose.add(IT.metal_chunk, cx + 2, cy, 0, 0);
    for (let i = 0; i < L.collectorIntakeTicks * 20; i++) sim.step();
    expect(s.partItems[1]).toBe(L.collectorBuffer);
    expect(sim.loose.live).toBe(4);
  });
});

describe('turrets', () => {
  // A stationary gun platform: core with an autocannon ahead of it, no engines.
  const gun = () => design([...rect(0, 0, 3, 6)], [part('core', 0, 3), part('autocannon', 0, 0)]);
  const lane = (slugs: number) => emptyLane({ length: 5000, allowance: { slugs } });
  const ROCK = 1;
  const MONOLITH = 3;

  it('shoots down a rock in range, spends slugs and drops its chunks', () => {
    const sim = new Sim(content, gun(), lane(80), 1);
    sim.asteroids.add(ROCK, 0, sim.ship.x + 6, sim.ship.y - 6, 0, 0, 120);
    for (let i = 0; i < 300 && sim.asteroids.live > 0; i++) sim.step();
    expect(sim.asteroids.live).toBe(0);
    expect(sim.asteroidsShot).toBe(1);
    // 120 HP at 12 per hit: ten hits, and a rock at 8.5 u is never missed.
    expect(sim.fired[IT.slugs]).toBe(10);
    expect(sim.loose.live).toBe(2);
    expect(sim.loose.item[0]).toBe(IT.metal_chunk);
    // Four shots a second.
    expect(sim.tick).toBeGreaterThanOrEqual(68);
    expect(sim.tick).toBeLessThanOrEqual(76);
  });

  it('leaves alone what is out of range', () => {
    const sim = new Sim(content, gun(), lane(80), 1);
    sim.asteroids.add(ROCK, 0, sim.ship.x + 16, sim.ship.y, 0, 0, 120);
    for (let i = 0; i < 120; i++) sim.step();
    expect(sim.fired[IT.slugs]).toBe(0);
  });

  it('often misses small, distant targets', () => {
    const sim = new Sim(content, gun(), lane(80), 1);
    const PEBBLE = 0;
    let shots = 0;
    // The turret sits 0.5 u left of and 2.7 u ahead of the center of mass.
    for (let n = 0; n < 20; n++) {
      // This platform has no inserter, so top the turret up by hand.
      addItem(sim.ship, 1, IT.slugs, 20 - itemCount(sim.ship, 1, IT.slugs));
      sim.asteroids.add(PEBBLE, 0, sim.ship.x + 12.5, sim.ship.y - 2.7, 0, 0, 20);
      for (let i = 0; i < 300 && sim.asteroids.live > 0; i++) sim.step();
    }
    shots = sim.fired[IT.slugs];
    // Two hits kill a pebble; at 13 u the hit chance is about 0.88.
    expect(sim.asteroidsShot).toBe(20);
    expect(shots).toBeGreaterThan(40);
    expect(shots).toBeLessThan(60);
  });

  it('shoots the asteroid on a collision course before a nearer bystander', () => {
    const sim = new Sim(content, gun(), lane(80), 1);
    const s = sim.ship;
    const bystander = sim.asteroids.add(ROCK, 0, s.x + 7, s.y - 3, 0, 0, 120);
    const threat = sim.asteroids.add(ROCK, 0, s.x, s.y - 13, 0, 3, 120);
    for (let i = 0; i < 20; i++) sim.step();
    expect(sim.asteroids.hp[threat]).toBeLessThan(120);
    expect(sim.asteroids.hp[bystander]).toBe(120);
  });

  it('ignores a target it is weak against while anything else is in range', () => {
    const sim = new Sim(content, gun(), lane(80), 1);
    const s = sim.ship;
    const mono = sim.asteroids.add(MONOLITH, 0, s.x - 9, s.y - 2, 0, 0, 4000);
    const rock = sim.asteroids.add(ROCK, 0, s.x + 10, s.y - 8, 0, 0, 120);
    for (let i = 0; i < 20; i++) sim.step();
    expect(sim.asteroids.hp[mono]).toBe(4000);
    expect(sim.asteroids.hp[rock]).toBeLessThan(120);
    // With the rock gone it has nothing else, so it fires on the monolith at 10% damage.
    for (let i = 0; i < 100; i++) sim.step();
    expect(sim.asteroids.hp[mono]).toBeLessThan(4000);
    expect(4000 - sim.asteroids.hp[mono]).toBeLessThan(40);
  });

  it('reports the supply that ran dry', () => {
    const sim = new Sim(content, gun(), lane(5), 1);
    sim.asteroids.add(ROCK, 0, sim.ship.x + 6, sim.ship.y - 6, 0, 0, 120);
    for (let i = 0; i < 120; i++) sim.step();
    expect(sim.fired[IT.slugs]).toBe(5);
    expect(sim.events).toHaveLength(1);
    expect(sim.events[0]).toMatchObject({ type: 'supply_ran_dry', detail: 'slugs' });
  });

  it('gives nothing for ramming', () => {
    const sim = new Sim(content, gun(), lane(0), 1);
    sim.asteroids.add(0, 0, sim.ship.x + (1.5 - sim.ship.comX), sim.ship.y - 6, 0, 8, 20);
    for (let i = 0; i < 60; i++) sim.step();
    expect(sim.loose.live).toBe(0);
    expect(sim.asteroidsShot).toBe(0);
  });
});

describe('launch load and haul', () => {
  it('fills turrets evenly, then the core', () => {
    const one = new Sim(content, designs.starter, lanes.lane1, 1);
    expect(itemCount(one.ship, one.ship.turrets[0], IT.slugs)).toBe(20);
    expect(itemCount(one.ship, one.ship.corePart, IT.slugs)).toBe(60);
    const two = new Sim(content, designs.reference1, lanes.lane1, 1);
    expect(two.ship.turrets.map((p) => itemCount(two.ship, p, IT.slugs))).toEqual([20, 20]);
    expect(itemCount(two.ship, two.ship.corePart, IT.slugs)).toBe(40);
  });

  it('leaves behind supplies with nowhere to go', () => {
    const sim = new Sim(content, designs.starter, { ...lanes.lane1, allowance: { slugs: 500, fuel: 150 } }, 1);
    // 20 in the turret and a full core of 100.
    expect(shipItemCount(sim.ship, IT.slugs)).toBe(120);
  });

  it('banks only bankable materials from the core and storages, and only on success', () => {
    const d = design([...rect(0, 0, 7, 3)], [part('core', 0, 0), part('storage', 3, 0), part('crusher', 5, 0)]);
    const finish = (length: number) => {
      const sim = new Sim(content, d, emptyLane({ length, allowance: { slugs: 10 } }), 1);
      addItem(sim.ship, 0, IT.iron_plate, 7);
      addItem(sim.ship, 1, IT.iron_plate, 5);
      addItem(sim.ship, 1, IT.scrap, 2);
      addItem(sim.ship, 1, IT.metal_ore, 9);
      addItem(sim.ship, 2, IT.carbon, 4);
      sim.ship.vy = -20;
      while (sim.outcome === 'running') sim.step();
      return sim.result();
    };
    expect(finish(20).haul).toEqual({ iron_plate: 12, scrap: 2 });
    const failed = finish(5000);
    expect(failed.outcome).toBe('failure');
    expect(failed.haul).toEqual({});
  });
});
