import { describe, expect, it } from 'vitest';
import { designs, lanes } from '../src/data';
import { checkLaunch, designBounds, designHash, validateDesign } from '../src/sim';
import { content, design, part, rect, twinThruster } from './helpers';

describe('design validation', () => {
  it('accepts the starter ship and the test ship', () => {
    expect(validateDesign(content, designs.starter)).toEqual([]);
    expect(validateDesign(content, twinThruster())).toEqual([]);
    expect(checkLaunch(content, designs.starter, lanes.lane1)).toEqual([]);
  });

  it('requires exactly one core', () => {
    expect(validateDesign(content, design(rect(0, 0, 3, 3), []))[0]).toMatch(/exactly one core/);
    const two = design(rect(0, 0, 6, 3), [part('core', 0, 0), part('core', 3, 0)]);
    expect(validateDesign(content, two).join()).toMatch(/exactly one core/);
  });

  it('allows at most one flight computer', () => {
    const d = design(rect(0, 0, 5, 3), [part('core', 0, 0), part('computer_mk1', 3, 0), part('computer_mk1', 4, 0)]);
    expect(validateDesign(content, d).join()).toMatch(/at most one flight computer/);
  });

  it('requires a tile under every part cell', () => {
    const d = design(rect(0, 0, 3, 3), [part('core', 0, 0), part('fuel_tank', 2, 2)]);
    expect(validateDesign(content, d).join()).toMatch(/no platform tile/);
  });

  it('rejects overlapping parts', () => {
    const d = design(rect(0, 0, 4, 3), [part('core', 0, 0), part('fuel_tank', 2, 0)]);
    expect(validateDesign(content, d).join()).toMatch(/overlaps/);
  });

  it('requires tiles to connect orthogonally to the core', () => {
    const d = design([...rect(0, 0, 3, 3), [4, 4]], [part('core', 0, 0)]);
    expect(validateDesign(content, d).join()).toMatch(/1 platform tiles are not connected/);
    const diagonal = design([...rect(0, 0, 3, 3), [3, 3]], [part('core', 0, 0)]);
    expect(validateDesign(content, diagonal).join()).toMatch(/not connected/);
  });

  it('needs the two cells behind a thruster nozzle empty', () => {
    // Rear thruster with a tile one cell behind it, then two cells behind it.
    for (const blockY of [5, 6]) {
      const d = design([...rect(0, 0, 3, 5), [0, blockY], [1, 5], [1, 6]],
        [part('core', 0, 0), part('thruster', 0, 3, 180)]);
      const errs = validateDesign(content, d).filter((e) => /nozzle/.test(e));
      expect(errs.length).toBe(1);
    }
    // A sideways thruster is 2 wide and 1 tall, and checks the cells beside it.
    const side = design([...rect(0, 0, 3, 3), [3, 0], [4, 0], [5, 0]],
      [part('core', 0, 0), part('thruster', 3, 0, 270)]);
    expect(validateDesign(content, side).join()).toMatch(/\(2,0\) behind its nozzle/);
    const sideOk = design([...rect(0, 0, 3, 3), [3, 0], [4, 0]],
      [part('core', 0, 0), part('thruster', 3, 0, 90)]);
    expect(validateDesign(content, sideOk)).toEqual([]);
  });

  it('checks behaviors against the computer slots', () => {
    const d = twinThruster();
    d.parts[1].behaviors = [{ id: 'drive_forward' }, { id: 'center_in_lane' }];
    expect(validateDesign(content, d).join()).toMatch(/1 behavior slots but 2/);
    d.parts[1].behaviors = [{ id: 'warp' }];
    expect(validateDesign(content, d).join()).toMatch(/Unknown behavior/);
  });

  it('checks recipes and filters', () => {
    const d = design(rect(0, 0, 6, 3), [part('core', 0, 0), part('smelter', 3, 0, 0, { recipe: 'slugs' })]);
    expect(validateDesign(content, d).join()).toMatch(/Smelter cannot run "slugs"/);
    d.parts[1] = part('fabricator', 3, 0, 0, { recipe: 'gold' });
    expect(validateDesign(content, d).join()).toMatch(/unknown recipe/);
    d.parts[1] = part('inserter', 3, 0, 0, { filter: 'gold' });
    expect(validateDesign(content, d).join()).toMatch(/unknown item/);
  });

  it('checks size against the lane at launch only', () => {
    const big = design(rect(0, 0, 9, 3), [part('core', 0, 0)]);
    expect(validateDesign(content, big)).toEqual([]);
    expect(checkLaunch(content, big, lanes.lane1).join()).toMatch(/9x3.*8x12/);
    expect(designBounds(designs.starter)).toMatchObject({ w: 8, h: 11 });
    expect(checkLaunch(content, designs.reference1, lanes.lane1)).toEqual([]);
  });
});

describe('design hash', () => {
  it('ignores the name and tile order, but not parts', () => {
    const a = twinThruster();
    const b = { ...twinThruster(), name: 'renamed' };
    b.tiles = b.tiles.slice().reverse();
    expect(designHash(a)).toBe(designHash(b));
    const c = twinThruster();
    c.parts[1].behaviors = [{ id: 'drive_forward', cruise: 7 }];
    expect(designHash(c)).not.toBe(designHash(a));
    expect(designHash(a)).toMatch(/^[0-9a-f]{16}$/);
  });
});
