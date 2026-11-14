import { describe, expect, it } from 'vitest';
import {
  allocate, buildShip, damageCell, loadFuel, recomputeMass, refreshFuelAvail,
  resolveFuel, resolveStructure, totalFuel,
} from '../src/sim';
import { content, design, part, rect, twinThruster } from './helpers';

const K = content.constants;
const alloc = (ship: ReturnType<typeof buildShip>, fx: number, fy: number, torque: number) => {
  refreshFuelAvail(ship);
  allocate(ship, fx, fy, torque, K.gyroTorque, K.autopilot.torqueWeight, 64, K.autopilot.gyroReluctance);
};

describe('mass properties', () => {
  it('computes mass, center of mass and inertia for a bare core', () => {
    const s = buildShip(content, design(rect(0, 0, 3, 3), [part('core', 0, 0)]));
    // 9 tiles of mass 1 plus a 30-mass core spread over them.
    expect(s.mass).toBeCloseTo(39, 12);
    expect(s.comX).toBeCloseTo(1.5, 12);
    expect(s.comY).toBeCloseTo(1.5, 12);
    // Per cell m = 39/9. Sum of d^2 over a 3x3 block is 12; plus m/6 per cell.
    expect(s.inertia).toBeCloseTo((39 / 9) * 12 + 39 / 6, 10);
  });

  it('shifts the center of mass toward heavy parts', () => {
    const s = buildShip(content, design(rect(0, 0, 4, 3), [part('core', 0, 0), part('armor', 3, 0)]));
    // 12 tiles + core 30 + armor 3 = 45; armor cell at x = 3.5.
    expect(s.mass).toBeCloseTo(45, 12);
    const expected = (39 * 1.5 + 1 * 3 * 3.5 + 3 * 3.5) / 45;
    expect(s.comX).toBeCloseTo(expected, 12);
  });

  it('counts fuel as cargo mass', () => {
    const s = buildShip(content, twinThruster());
    const dry = s.mass;
    loadFuel(s, 150);
    recomputeMass(s, content, false);
    expect(s.mass - dry).toBeCloseTo(150 * K.fuelMass, 10);
    expect(totalFuel(s)).toBeCloseTo(150, 10);
  });

  it('leaves behind fuel that does not fit', () => {
    const s = buildShip(content, twinThruster());
    loadFuel(s, 500);
    expect(totalFuel(s)).toBe(200);
  });
});

describe('thrust allocation', () => {
  it('splits a forward force across both thrusters with no net torque', () => {
    const s = buildShip(content, twinThruster());
    loadFuel(s, 150);
    alloc(s, 0, -40, 0);
    // The ship is almost symmetric, so the split is almost even.
    expect(s.thrThrottle[0] + s.thrThrottle[1]).toBeCloseTo(1, 2);
    expect(Math.abs(s.thrThrottle[0] - 0.5)).toBeLessThan(0.05);
    let torque = s.gyro * K.gyroTorque;
    for (let t = 0; t < 2; t++) torque += (s.thrCx[t] - s.comX) * -s.thrMax[t] * s.thrThrottle[t];
    expect(Math.abs(torque)).toBeLessThan(0.05);
    expect(Math.abs(s.gyro)).toBeLessThan(0.05);
  });

  it('saturates at full throttle', () => {
    const s = buildShip(content, twinThruster());
    loadFuel(s, 150);
    alloc(s, 0, -1000, 0);
    expect(Array.from(s.thrThrottle)).toEqual([1, 1]);
  });

  it('cannot brake without forward-facing thrusters', () => {
    const s = buildShip(content, twinThruster());
    loadFuel(s, 150);
    alloc(s, 0, 500, 0);
    expect(Array.from(s.thrThrottle)).toEqual([0, 0]);
  });

  it('uses differential thrust for torque, with the gyro making up the rest', () => {
    const s = buildShip(content, twinThruster());
    loadFuel(s, 150);
    alloc(s, 0, 0, 500);
    // Positive torque needs the left thruster (force -y at negative x offset).
    expect(s.thrThrottle[0]).toBeGreaterThan(0.5);
    expect(s.thrThrottle[1]).toBe(0);
    expect(s.gyro).toBeGreaterThan(0.9);
  });

  it('throttles down the far side of a lopsided ship to stay straight', () => {
    // Heavy armor column on the right moves the center of mass right.
    const armor = [0, 1, 2, 3, 4, 5, 6].map((y) => part('armor', 5, y));
    const s = buildShip(content, twinThruster(armor, rect(5, 0, 1, 7)));
    loadFuel(s, 150);
    expect(s.comX).toBeGreaterThan(2.6);
    alloc(s, 0, -60, 0);
    // Left thruster has the longer arm, so it must fire less.
    expect(s.thrThrottle[0]).toBeLessThan(s.thrThrottle[1]);
    let torque = s.gyro * K.gyroTorque;
    for (let t = 0; t < 2; t++) torque += (s.thrCx[t] - s.comX) * -s.thrMax[t] * s.thrThrottle[t];
    expect(Math.abs(torque)).toBeLessThan(0.5);
  });

  it('ignores thrusters with no fuel', () => {
    const s = buildShip(content, twinThruster());
    alloc(s, 0, -1000, 0);
    expect(Array.from(s.thrThrottle)).toEqual([0, 0]);
  });
});

describe('fuel networks', () => {
  it('joins tank, pipes and the thrusters touching them', () => {
    const s = buildShip(content, twinThruster());
    expect(s.netCount).toBe(1);
    expect(s.partNet[6]).toBe(0);
    expect(s.partNet[7]).toBe(0);
  });

  it('starves the thruster past a destroyed pipe', () => {
    const s = buildShip(content, twinThruster());
    loadFuel(s, 150);
    // Destroy the pipe at (3,6): the right thruster's only route to the tank.
    expect(damageCell(s, 3, 6, 1000)).toBeGreaterThan(0);
    resolveStructure(s, content);
    expect(s.partNet[7]).not.toBe(s.partNet[2]);
    s.thrThrottle[0] = 1;
    s.thrThrottle[1] = 1;
    resolveFuel(s, 1 / 30);
    expect(s.thrEff[0]).toBe(1);
    expect(s.thrEff[1]).toBe(0);
    alloc(s, 0, -1000, 0);
    expect(Array.from(s.thrThrottle)).toEqual([1, 0]);
  });

  it('burns fuel in proportion to throttle and scales down when short', () => {
    const s = buildShip(content, twinThruster());
    loadFuel(s, 150);
    s.thrThrottle[0] = 1;
    s.thrThrottle[1] = 0.5;
    resolveFuel(s, 1);
    expect(totalFuel(s)).toBeCloseTo(150 - 0.5 - 0.25, 10);

    s.partFuel[2] = 0.3;
    resolveFuel(s, 1);
    // Request 0.75, available 0.3: both scaled by 0.4.
    expect(s.thrEff[0]).toBeCloseTo(0.4, 10);
    expect(s.thrEff[1]).toBeCloseTo(0.2, 10);
    expect(totalFuel(s)).toBe(0);
  });
});

describe('damage and breakup', () => {
  it('gives a multi-cell part one HP pool and removes its tiles when destroyed', () => {
    const s = buildShip(content, twinThruster());
    expect(damageCell(s, 1, 5, 100)).toBe(0);
    expect(damageCell(s, 2, 6, 40)).toBe(0);
    expect(s.partHp[2]).toBe(10);
    expect(damageCell(s, 1, 6, 25)).toBe(15);
    expect(s.partAlive[2]).toBe(0);
    for (const [x, y] of [[1, 5], [2, 5], [1, 6], [2, 6]]) expect(s.cellTile[y * s.gw + x]).toBe(0);
  });

  it('damages bare tiles individually', () => {
    const s = buildShip(content, twinThruster());
    expect(damageCell(s, 0, 0, 60)).toBe(0);
    expect(damageCell(s, 0, 0, 60)).toBe(20);
    expect(s.cellTile[0]).toBe(0);
    expect(s.cellTile[1]).toBe(1);
  });

  it('detaches everything cut off from the core', () => {
    const s = buildShip(content, twinThruster());
    loadFuel(s, 150);
    const massBefore = s.mass;
    // Cut row 6 at x = 0: the left thruster below it loses its only link.
    damageCell(s, 0, 6, 1000);
    const detached = resolveStructure(s, content);
    expect(detached).toBe(1);
    expect(s.partAlive[6]).toBe(0);
    expect(s.partAlive[7]).toBe(1);
    expect(s.cellTile[7 * s.gw + 0]).toBe(0);
    expect(s.cellTile[8 * s.gw + 0]).toBe(0);
    expect(s.mass).toBeLessThan(massBefore);
    expect(s.comX).toBeGreaterThan(2.5);
    expect(s.partsLost).toBe(2);
  });

  it('keeps the hull in place when the center of mass moves', () => {
    const s = buildShip(content, twinThruster());
    s.x = 10;
    s.y = -50;
    const coreBefore = [s.x + (2.5 - s.comX), s.y + (3.5 - s.comY)];
    damageCell(s, 0, 6, 1000);
    resolveStructure(s, content);
    const coreAfter = [s.x + (2.5 - s.comX), s.y + (3.5 - s.comY)];
    expect(coreAfter[0]).toBeCloseTo(coreBefore[0], 10);
    expect(coreAfter[1]).toBeCloseTo(coreBefore[1], 10);
  });

  it('flags a destroyed core', () => {
    const s = buildShip(content, twinThruster());
    damageCell(s, 2, 3, 5000);
    expect(s.coreDestroyed).toBe(true);
  });
});
