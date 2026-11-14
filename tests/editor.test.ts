import { describe, expect, it } from 'vitest';
import { designs } from '../src/data';
import { DesignEditor, normalizeDesign, shipStats } from '../src/game';
import { buildShip, designHash, validateDesign } from '../src/sim';
import type { Design } from '../src/sim';
import { content } from './helpers';

/** Cells sorted nearest the core first, so laying them one by one keeps the hull connected. */
function outward(cells: [number, number][], cx: number, cy: number): [number, number][] {
  return cells.slice().sort((a, b) => Math.abs(a[0] - cx) + Math.abs(a[1] - cy) - Math.abs(b[0] - cx) - Math.abs(b[1] - cy));
}

const empty: Design = { name: 'Starter Mk1', tiles: [], parts: [] };

/** An editor holding a 5x5 hull with a core in its middle. */
function hull(funds: Record<string, number> | null = null): { ed: DesignEditor; ox: number; oy: number } {
  const ed = new DesignEditor(content, empty, funds);
  const ox = 30;
  const oy = 30;
  ed.place('core', ox + 1, oy + 1);
  const cells: [number, number][] = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) cells.push([ox + x, oy + y]);
  for (const [x, y] of outward(cells, ox + 2, oy + 2)) expect(ed.placeTile(x, y).ok).toBe(true);
  return { ed, ox, oy };
}

describe('DesignEditor', () => {
  it('rebuilds the starter ship from an empty grid, hash for hash', () => {
    const starter = designs.starter;
    const ed = new DesignEditor(content, empty);
    const ox = 28;
    const oy = 26;
    // Core first, then the hull, then every other part in the starter's order.
    const [core, ...rest] = starter.parts;
    expect(ed.place(core.type, ox + core.x, oy + core.y, core.rot).ok).toBe(true);
    for (const [x, y] of outward(starter.tiles, core.x + 1, core.y + 1)) {
      const r = ed.placeTile(ox + x, oy + y);
      expect(r.reason).toBeUndefined();
    }
    for (const p of rest) {
      const r = ed.place(p.type, ox + p.x, oy + p.y, p.rot);
      expect(r.reason).toBeUndefined();
      if (p.filter) ed.configure(ed.design.parts.length - 1, { filter: p.filter });
    }
    const built = ed.normalized();
    expect(validateDesign(content, built)).toEqual([]);
    expect(designHash(built)).toBe(designHash(starter));
  });

  it('lays platform tiles under a new part and charges for them', () => {
    const { ed, ox, oy } = hull();
    const tiles = ed.design.tiles.length;
    expect(ed.place('autocannon', ox + 1, oy - 2).ok).toBe(true);
    expect(ed.design.tiles.length).toBe(tiles + 4);
    expect(ed.cost().iron_plate).toBe((tiles + 4) * 2 + 20);
  });

  it('refuses overlaps, unconnected parts, blocked exhaust and what the player cannot afford', () => {
    const { ed, ox, oy } = hull({ iron_plate: 80 });
    expect(ed.place('crusher', ox + 2, oy + 2).reason).toMatch(/Overlaps the core/);
    expect(ed.place('crusher', ox + 10, oy).reason).toMatch(/connect to the hull/);
    // A thruster on the bottom row facing back needs the two cells under it clear.
    expect(ed.place('thruster', ox, oy + 5, 180).ok).toBe(true);
    expect(ed.placeTile(ox, oy + 7).reason).toMatch(/exhaust/);
    expect(ed.place('thruster', ox + 4, oy + 1, 180).reason).toMatch(/behind its nozzle/);
    expect(ed.place('autocannon', ox + 3, oy + 3).ok).toBe(false);
    expect(ed.place('autocannon', ox + 5, oy).reason).toMatch(/Not enough iron plate/);
  });

  it('mirrors placement and erasing across the core when symmetry is on', () => {
    const { ed, ox, oy } = hull();
    ed.symmetry = true;
    // The core spans x = ox+1..ox+3, so its centre line is cell ox+2.
    expect(ed.place('thruster', ox, oy + 5, 180).ok).toBe(true);
    expect(ed.partAt(ox + 4, oy + 5)).toBeGreaterThanOrEqual(0);
    expect(ed.place('inserter', ox, oy, 90).ok).toBe(true);
    const mirrored = ed.design.parts[ed.partAt(ox + 4, oy)];
    expect(mirrored.rot).toBe(270);
    // A part on the centre line is not doubled.
    const n = ed.design.parts.length;
    ed.place('belt', ox + 2, oy, 0);
    expect(ed.design.parts.length).toBe(n + 1);
    expect(ed.erase(ox, oy + 5).erased).toBe('part');
    expect(ed.partAt(ox + 4, oy + 5)).toBe(-1);
  });

  it('erases parts before tiles and will not cut the hull in two', () => {
    const { ed, ox, oy } = hull();
    ed.place('belt', ox, oy, 0);
    expect(ed.erase(ox, oy, 'tile').ok).toBe(false);
    expect(ed.erase(ox, oy).erased).toBe('part');
    expect(ed.erase(ox, oy).erased).toBe('tile');
    // A tail of two tiles hanging off the bottom: removing the first cuts off the second.
    ed.placeTile(ox, oy + 5);
    ed.placeTile(ox, oy + 6);
    expect(ed.erase(ox, oy + 5).reason).toMatch(/cut off 1 tiles/);
  });

  it('re-points a belt that a path drags over, and rotates and moves parts', () => {
    const { ed, ox, oy } = hull();
    expect(ed.pathCell('belt', ox, oy, 90).ok).toBe(true);
    expect(ed.pathCell('belt', ox, oy, 180).ok).toBe(true);
    expect(ed.design.parts[ed.partAt(ox, oy)].rot).toBe(180);
    expect(ed.pathCell('fuel_pipe', ox, oy, 0).ok).toBe(false);

    ed.place('thruster', ox + 4, oy + 5, 180);
    const t = ed.partAt(ox + 4, oy + 5);
    expect(ed.rotateAt(ox + 4, oy + 5).ok).toBe(true);
    expect(ed.design.parts[t].rot).toBe(270);
    ed.setRotation(t, 180);
    expect(ed.moveTo(t, ox + 3, oy + 5).ok).toBe(true);
    expect(ed.design.parts[t].x).toBe(ox + 3);
    expect(ed.moveTo(t, ox + 2, oy + 2).reason).toMatch(/Overlaps the core/);
  });

  it('undoes and redoes whole gestures', () => {
    const { ed, ox, oy } = hull();
    const before = JSON.stringify(ed.design);
    ed.begin();
    ed.pathCell('belt', ox, oy, 90);
    ed.pathCell('belt', ox + 1, oy, 90);
    ed.pathCell('belt', ox + 2, oy, 90);
    expect(ed.commit()).toBe(true);
    const after = JSON.stringify(ed.design);
    expect(ed.undo()).toBe(true);
    expect(JSON.stringify(ed.design)).toBe(before);
    expect(ed.redo()).toBe(true);
    expect(JSON.stringify(ed.design)).toBe(after);
    // A cancelled gesture leaves nothing behind and no undo step.
    ed.begin();
    ed.place('crusher', ox, oy + 2);
    ed.cancel();
    expect(JSON.stringify(ed.design)).toBe(after);
    ed.begin();
    expect(ed.commit()).toBe(false);
  });

  it('keeps at least 50 undo steps', () => {
    const { ed, ox, oy } = hull();
    for (let i = 0; i < 60; i++) {
      ed.begin();
      if (i % 2 === 0) ed.placeTile(ox + 5, oy);
      else ed.erase(ox + 5, oy);
      expect(ed.commit()).toBe(true);
    }
    let n = 0;
    while (ed.undo()) n++;
    expect(n).toBeGreaterThanOrEqual(50);
  });

  it('stores designs with the top-left tile at (0,0)', () => {
    const ed = new DesignEditor(content, designs.reference1);
    expect(ed.design.tiles[0][0]).toBeGreaterThan(10);
    expect(designHash(ed.normalized())).toBe(designHash(designs.reference1));
    expect(normalizeDesign(ed.design).tiles[0]).toEqual([0, 0]);
  });
});

describe('shipStats', () => {
  it("matches the sim's mass properties for the stock designs", () => {
    for (const d of [designs.starter, designs.reference1]) {
      const s = shipStats(content, d);
      const ship = buildShip(content, d);
      expect(s.mass).toBeCloseTo(ship.mass, 9);
      expect(s.comX).toBeCloseTo(ship.comX, 9);
      expect(s.comY).toBeCloseTo(ship.comY, 9);
      expect(s.inertia).toBeCloseTo(ship.inertia, 9);
    }
  });

  it('sums thrust by direction and turning torque each way', () => {
    const s = shipStats(content, designs.starter);
    expect(s.thrust).toEqual({ forward: 80, back: 0, left: 0, right: 0 });
    expect(s.gyro).toBe(30);
    // Two rear thrusters sit at x = 1.5 and 6.5 about a centre of mass near 3.8,
    // so the one farther out wins and the ship can turn harder one way.
    expect(s.torque.cw).not.toBeCloseTo(s.torque.ccw, 3);
    expect(s.width).toBe(8);
    expect(s.height).toBe(11);
    expect(s.cost.iron_plate).toBe(272);
  });
});
