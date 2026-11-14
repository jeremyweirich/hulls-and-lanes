// The shipyard's live readouts (spec section 12): size, mass, centre of mass,
// and the thrust and torque available each way with the acceleration they give.
// Mass properties follow spec section 5 for an empty ship (no fuel or cargo).
// Cheap enough to recompute on every edit.

import { designBounds, facing, partDefIndex, rotH, rotW } from '../sim';
import type { Content, Design } from '../sim';
import { designCost } from './game';

export interface ShipStats {
  /** Bounding box of the platform tiles. */
  minX: number;
  minY: number;
  width: number;
  height: number;
  /** Empty mass, and the centre of mass in the design's grid coordinates (cell edges). */
  mass: number;
  comX: number;
  comY: number;
  inertia: number;
  /** Total thrust that pushes the ship each way. */
  thrust: { forward: number; back: number; left: number; right: number };
  /** Turning torque each way, thrusters plus the core's gyro. Clockwise is positive on screen. */
  torque: { cw: number; ccw: number };
  gyro: number;
  /** Fuel the tanks hold. */
  fuelCapacity: number;
  /** Fuel per second with every thruster at full throttle. */
  fullBurn: number;
  cost: Record<string, number>;
}

export function shipStats(content: Content, design: Design): ShipStats {
  const b = designBounds(design);
  const tileMass = content.parts[partDefIndex(content, 'platform_tile')].mass;
  let mass = 0;
  let mx = 0;
  let my = 0;
  // Point masses at cell centres: each tile, plus an even share of each part.
  const cells: { x: number; y: number; m: number }[] = [];
  for (const [x, y] of design.tiles) cells.push({ x: x + 0.5, y: y + 0.5, m: tileMass });
  const thrust = { forward: 0, back: 0, left: 0, right: 0 };
  const thrusters: { cx: number; cy: number; fx: number; fy: number; f: number }[] = [];
  let fuelCapacity = 0;
  let fullBurn = 0;

  for (const p of design.parts) {
    const di = partDefIndex(content, p.type);
    if (di < 0) continue;
    const def = content.parts[di];
    const w = rotW(def, p.rot);
    const h = rotH(def, p.rot);
    const share = def.mass / (w * h);
    for (let y = p.y; y < p.y + h; y++) for (let x = p.x; x < p.x + w; x++) cells.push({ x: x + 0.5, y: y + 0.5, m: share });
    fuelCapacity += def.fuelCapacity ?? 0;
    if (def.kind === 'thruster') {
      const [nx, ny] = facing(p.rot);
      // A thruster pushes the ship opposite the way its nozzle faces.
      const fx = -nx;
      const fy = -ny;
      const f = def.thrust ?? 0;
      fullBurn += def.burn ?? 0;
      thrusters.push({ cx: p.x + w / 2, cy: p.y + h / 2, fx, fy, f });
      if (fy < 0) thrust.forward += f;
      if (fy > 0) thrust.back += f;
      if (fx < 0) thrust.left += f;
      if (fx > 0) thrust.right += f;
    }
  }

  for (const c of cells) {
    mass += c.m;
    mx += c.m * c.x;
    my += c.m * c.y;
  }
  const comX = mass > 0 ? mx / mass : 0;
  const comY = mass > 0 ? my / mass : 0;
  let inertia = 0;
  // Spec section 5 adds m/6 per cell; parts and tiles on the same cell add up the same way.
  for (const c of cells) {
    const dx = c.x - comX;
    const dy = c.y - comY;
    inertia += c.m * (dx * dx + dy * dy) + c.m / 6;
  }

  const gyro = design.parts.some((p) => p.type === 'core') ? content.constants.gyroTorque : 0;
  const torque = { cw: gyro, ccw: gyro };
  for (const t of thrusters) {
    // Same sign convention as the sim: positive turns clockwise on screen.
    const tq = ((t.cx - comX) * t.fy - (t.cy - comY) * t.fx) * t.f;
    if (tq > 0) torque.cw += tq;
    if (tq < 0) torque.ccw -= tq;
  }

  return {
    minX: b.minX, minY: b.minY, width: b.w, height: b.h,
    mass, comX, comY, inertia, thrust, torque, gyro, fuelCapacity, fullBurn,
    cost: designCost(content, design),
  };
}
