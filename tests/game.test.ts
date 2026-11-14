import { describe, expect, it } from 'vitest';
import { designs, lanes } from '../src/data';
import {
  accrue, accrueAll, assignFarming, canAfford, cycleSeconds, designCost, exportSave, importSave,
  incomePerHour, isCertified, isCurrent, laneSeeds, MemoryStore, migrate, newGame, readiness,
  recordRun, reportLines, runReadinessCheck, SAVE_VERSION, storeBenchmark, summarize, updateDesign,
  type Benchmark,
} from '../src/game';
import { runHeadless, SIM_VERSION, type RunResult } from '../src/sim';
import { content } from './helpers';

const lane = lanes.lane1;
const eco = content.economy;

/** A hand-made benchmark, for tests that need exact numbers. */
function bench(overrides: Partial<Benchmark> = {}): Benchmark {
  return {
    laneId: 'lane1', designHash: '', simVersion: SIM_VERSION, runs: 20, successes: 17,
    meanSuccessSeconds: 212, meanFailSeconds: 140, meanHaul: { iron_plate: 64 }, failures: { left_lane: 3 },
    notes: [], ...overrides,
  };
}

describe('readiness check', () => {
  it('uses the same fixed seeds for a lane every time', () => {
    const seeds = laneSeeds('lane1', 20);
    expect(seeds).toEqual(laneSeeds('lane1', 20));
    expect(new Set(seeds).size).toBe(20);
    expect(laneSeeds('lane2', 20)).not.toEqual(seeds);
    expect(laneSeeds('lane1', 40).slice(0, 20)).toEqual(seeds);
  });

  it('summarizes runs into a benchmark record', () => {
    const b = runReadinessCheck(content, designs.reference1, lane);
    expect(b).toEqual(runReadinessCheck(content, designs.reference1, lane));
    expect(b.runs).toBe(20);
    expect(b.simVersion).toBe(SIM_VERSION);
    expect(b.successes + Object.values(b.failures).reduce((a, n) => a + n, 0)).toBe(20);
    expect(b.meanSuccessSeconds).toBeGreaterThan(200);
    expect(b.meanHaul.iron_plate).toBeGreaterThan(20);
    // The reference ship holds its band; the starter is not solo-ready.
    expect(readiness(b)).toBeGreaterThanOrEqual(0.85);
    expect(isCertified(content, b, designs.reference1, lane)).toBe(true);
    const starter = runReadinessCheck(content, designs.starter, lane);
    expect(readiness(starter)).toBeLessThan(lane.readinessThreshold);
    expect(isCertified(content, starter, designs.starter, lane)).toBe(false);
  });

  it('counts each note once per run and averages where it happened', () => {
    const run = (seed: number, events: RunResult['events'], ok = true): RunResult => ({
      simVersion: SIM_VERSION, laneId: 'lane1', seed, outcome: ok ? 'success' : 'failure',
      cause: ok ? null : 'left_lane', ticks: 3000, seconds: ok ? 100 : 60, laneShare: 1, partsLost: 0,
      fuelLeft: 0, haul: ok ? { iron_plate: 10 } : {}, fired: {}, asteroidsShot: 0, chunksCollected: 0, assistUses: {},
      events, stateHash: '',
    });
    const dry = (laneShare: number) => ({ tick: 1, laneShare, type: 'supply_ran_dry' as const, detail: 'slugs' });
    const b = summarize(lane, designs.starter, [
      run(1, [dry(0.5), dry(0.9)]), run(2, [dry(0.7)], false), run(3, []), run(4, [], false),
    ]);
    expect(b.successes).toBe(2);
    expect(b.meanSuccessSeconds).toBe(100);
    expect(b.meanFailSeconds).toBe(60);
    expect(b.meanHaul).toEqual({ iron_plate: 10 });
    expect(b.failures).toEqual({ left_lane: 2 });
    expect(b.notes).toEqual([{ event: 'slugs_ran_dry', runs: 2, atLaneShare: 0.6 }]);
    expect(reportLines(content, b)).toEqual([
      'Failed 2 of 4: the ship drifted out of the lane in 2.',
      'Ran out of slugs about 60% of the way in 2 runs.',
    ]);
  });

  it('ties a benchmark to the design and sim version', () => {
    const b = runReadinessCheck(content, designs.reference1, lane);
    const changed = structuredClone(designs.reference1);
    changed.parts[1].behaviors = [{ id: 'drive_forward', cruise: 7 }];
    expect(isCurrent(b, changed)).toBe(false);
    expect(isCertified(content, b, changed, lane)).toBe(false);
    expect(isCurrent({ ...b, simVersion: SIM_VERSION - 1 }, designs.reference1)).toBe(false);
    // Renaming a ship is not a design change.
    expect(isCurrent(b, { ...designs.reference1, name: 'Renamed' })).toBe(true);
    // A check still in progress never certifies.
    expect(isCertified(content, { ...b, runs: 10, successes: 10 }, designs.reference1, lane)).toBe(false);
  });
});

describe('idle farming', () => {
  it('computes cycle time and income per hour', () => {
    const b = bench();
    const cycle = 0.85 * 212 + 0.15 * 140 + eco.turnaroundSeconds;
    expect(cycleSeconds(content, b)).toBeCloseTo(cycle, 10);
    expect(incomePerHour(content, b).iron_plate).toBeCloseTo((3600 / cycle) * 0.85 * 64, 8);
  });

  it('pays whole cycles and carries the remainder', () => {
    const b = bench();
    const cycle = cycleSeconds(content, b);
    const start = { laneId: 'lane1', accruedUntil: 1000, counter: 0 };
    expect(accrue(content, b, start, 1000 + cycle - 1, 5, 's1')).toMatchObject({ runs: 0, farming: start });
    const r = accrue(content, b, start, 1000 + cycle * 3.5, 5, 's1');
    expect(r.runs).toBe(3);
    expect(r.successes).toBeLessThanOrEqual(3);
    expect(r.haul.iron_plate ?? 0).toBe(r.successes * 64);
    expect(r.farming.accruedUntil).toBeCloseTo(1000 + cycle * 3, 6);
    expect(r.farming.counter).toBe(1);
  });

  it('is repeatable for a save, and differs between ships and accruals', () => {
    const b = bench();
    const f = { laneId: 'lane1', accruedUntil: 0, counter: 0 };
    const now = 3600 * 6;
    const a = accrue(content, b, f, now, 99, 's1');
    expect(accrue(content, b, f, now, 99, 's1')).toEqual(a);
    const others = [
      accrue(content, b, f, now, 99, 's2'), accrue(content, b, f, now, 100, 's1'),
      accrue(content, b, { ...f, counter: 1 }, now, 99, 's1'),
    ];
    expect(others.some((o) => o.successes !== a.successes)).toBe(true);
  });

  it('caps time away and does not pay the excess later', () => {
    const b = bench();
    const cycle = cycleSeconds(content, b);
    const f = { laneId: 'lane1', accruedUntil: 0, counter: 0 };
    const now = 3600 * 30;
    const r = accrue(content, b, f, now, 1, 's1');
    expect(r.runs).toBe(Math.floor((eco.offlineCapHours * 3600) / cycle));
    expect(now - r.farming.accruedUntil).toBeLessThan(cycle);
    expect(accrue(content, b, r.farming, now + 60, 1, 's1').runs).toBeLessThanOrEqual(1);
  });

  it('pays nothing when the clock has moved backward', () => {
    const r = accrue(content, bench(), { laneId: 'lane1', accruedUntil: 5000, counter: 3 }, 4000, 1, 's1');
    expect(r).toMatchObject({ runs: 0, haul: {}, farming: { accruedUntil: 4000, counter: 3 } });
  });

  it('lands within 5% of the expected haul over 1,000 cycles', () => {
    // Milestone 4 exit test, accrued the way the app does it: once a minute.
    const b = bench();
    const cycle = cycleSeconds(content, b);
    let farming = { laneId: 'lane1', accruedUntil: 0, counter: 0 };
    let runs = 0;
    let plate = 0;
    for (let now = 60; runs < 1000; now += 60) {
      const r = accrue(content, b, farming, now, 81234567, 's1');
      farming = r.farming;
      runs += r.runs;
      plate += r.haul.iron_plate ?? 0;
    }
    const hours = farming.accruedUntil / 3600;
    const expected = incomePerHour(content, b).iron_plate * hours;
    expect(runs).toBe(1000);
    expect(farming.accruedUntil).toBeCloseTo(1000 * cycle, 3);
    expect(Math.abs(plate - expected) / expected).toBeLessThan(0.05);
  });
});

describe('the loop', () => {
  it('starts a new game with the starter ship and starting stockpile', () => {
    const save = newGame(content, designs.starter, 7);
    expect(save.stockpile).toEqual({ iron_plate: 150, carbon: 0, alloy: 0, scrap: 0 });
    expect(save.unlocks.hangarSlots).toBe(2);
    expect(save.ships.map((s) => s.design.name)).toEqual(['Starter Mk1']);
    expect(save.unlocks.parts).toContain('autocannon');
    expect(save.unlocks.parts).not.toContain('armor');
    expect(save.unlocks.behaviors).toEqual(['drive_forward', 'center_in_lane']);
  });

  it('prices a design from its tiles and parts', () => {
    const cost = designCost(content, designs.starter);
    // 76 tiles at 2 plate, plus the parts; the core is free.
    expect(cost).toEqual({ iron_plate: 76 * 2 + 5 + 20 + 15 + 12 + 12 + 10 + 6 * 2 + 12 + 6 * 1 + 2 * 8 });
    const save = newGame(content, designs.starter, 7);
    expect(canAfford(save, cost)).toBe(false);
    expect(canAfford(save, { iron_plate: 150 })).toBe(true);
    expect(canAfford(save, { alloy: 1 })).toBe(false);
  });

  it('goes from first launch to a farming ship', () => {
    const save = newGame(content, designs.starter, 7);
    const now = 1_800_000_000;

    // A failed run costs nothing and banks nothing.
    const failSeed = [1, 2, 3, 4, 5, 6, 7, 8].find((s) => runHeadless(content, designs.starter, lane, s).outcome === 'failure')!;
    expect(recordRun(content, save, lane, runHeadless(content, designs.starter, lane, failSeed))).toBe(false);
    expect(save.stockpile.iron_plate).toBe(150);
    expect(assignFarming(content, save, 's1', lane, now)).toMatch(/not been cleared/);

    // The first clear banks the haul, opens the lane and adds a hangar slot.
    updateDesign(save, 's1', structuredClone(designs.reference1));
    const win = runHeadless(content, designs.reference1, lane, 5);
    expect(recordRun(content, save, lane, win)).toBe(true);
    expect(save.stockpile.iron_plate).toBe(150 + win.haul.iron_plate);
    expect(save.lanes.lane1.cleared).toBe(true);
    expect(save.unlocks.hangarSlots).toBe(3);
    expect(recordRun(content, save, lane, win)).toBe(false);
    expect(save.unlocks.hangarSlots).toBe(3);

    // Not certified until a readiness check passes.
    expect(assignFarming(content, save, 's1', lane, now)).toMatch(/not certified/);
    storeBenchmark(save, 's1', runReadinessCheck(content, save.ships[0].design, lane));
    expect(assignFarming(content, save, 's1', lane, now)).toBeNull();

    // One ship per lane.
    save.ships.push({ ...structuredClone(save.ships[0]), id: 's2', farming: null });
    expect(assignFarming(content, save, 's2', lane, now)).toMatch(/already farming/);

    // Four hours away pays out and reports per ship.
    const before = save.stockpile.iron_plate;
    const lines = accrueAll(content, save, now + 4 * 3600);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ shipId: 's1', name: 'Tier 1 reference', laneId: 'lane1' });
    expect(lines[0].runs).toBeGreaterThan(50);
    expect(save.stockpile.iron_plate).toBe(before + lines[0].haul.iron_plate);
    expect(accrueAll(content, save, now + 4 * 3600 + 5)).toEqual([]);

    // Changing the design ends certification and farming.
    const refit = structuredClone(save.ships[0].design);
    refit.parts[1].behaviors = [{ id: 'drive_forward', cruise: 7 }];
    updateDesign(save, 's1', refit);
    expect(save.ships[0].farming).toBeNull();
    expect(assignFarming(content, save, 's1', lane, now)).toMatch(/not certified/);
  });
});

describe('saves', () => {
  it('round-trips through export, import and a store', async () => {
    const save = newGame(content, designs.starter, 7);
    storeBenchmark(save, 's1', bench());
    expect(importSave(exportSave(save))).toEqual(save);
    const store = new MemoryStore();
    expect(await store.load()).toBeNull();
    await store.save(save);
    expect(await store.load()).toEqual(save);
  });

  it('loads a version 1 sample save', () => {
    const sample = {
      saveVersion: 1, simVersion: 1, seed: 81234567,
      stockpile: { iron_plate: 150, carbon: 0, alloy: 0, scrap: 0 },
      unlocks: { parts: [], behaviors: [], hangarSlots: 2 },
      lanes: { lane1: { cleared: true } }, contracts: {},
      ships: [{ id: 's1', design: designs.starter, salvagedParts: [], benchmarks: { lane1: bench({ simVersion: 1 }) },
        farming: { laneId: 'lane1', accruedUntil: 1794682800, counter: 12 } }],
      blueprints: [], settings: {},
    };
    const save = migrate(structuredClone(sample));
    expect(save.saveVersion).toBe(SAVE_VERSION);
    expect(save.simVersion).toBe(SIM_VERSION);
    // A sim version change keeps the ship farming on its old benchmark, uncertified.
    expect(save.ships[0].farming).not.toBeNull();
    expect(isCertified(content, save.ships[0].benchmarks.lane1, save.ships[0].design, lane)).toBe(false);
    expect(accrueAll(content, save, 1794682800 + 3600).length).toBe(1);
  });

  it('rejects things that are not saves, and saves from the future', () => {
    expect(() => migrate({})).toThrow(/not a Hulls/);
    expect(() => importSave('{"saveVersion": 99}')).toThrow(/newer version/);
  });
});
