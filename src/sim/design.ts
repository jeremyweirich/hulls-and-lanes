// Design format helpers: footprints, placement rules, launch checks, hashing.

import { canonicalJson, Hasher } from './hash';
import type { Content, Design, LaneDef, PartDef, PartInstance, Rot } from './types';

/** Largest grid coordinate a design may use (exclusive). */
export const MAX_GRID = 64;

export function partDefIndex(content: Content, type: string): number {
  for (let i = 0; i < content.parts.length; i++) if (content.parts[i].id === type) return i;
  return -1;
}

/** Footprint width after rotation. */
export function rotW(def: PartDef, rot: Rot): number {
  return rot === 90 || rot === 270 ? def.h : def.w;
}

/** Footprint height after rotation. */
export function rotH(def: PartDef, rot: Rot): number {
  return rot === 90 || rot === 270 ? def.w : def.h;
}

/** Unit vector a part faces, in grid space. rot 0 faces forward (-y). */
export function facing(rot: Rot): [number, number] {
  switch (rot) {
    case 0: return [0, -1];
    case 90: return [1, 0];
    case 180: return [0, 1];
    default: return [-1, 0];
  }
}

/**
 * The two cells behind a thruster's nozzle, which must hold no tile. The nozzle
 * is at the end of the footprint the part faces. Wide thrusters need the cells
 * clear across their whole width.
 */
export function nozzleCells(def: PartDef, p: PartInstance): [number, number][] {
  const w = rotW(def, p.rot);
  const h = rotH(def, p.rot);
  const [fx, fy] = facing(p.rot);
  const out: [number, number][] = [];
  for (let d = 1; d <= 2; d++) {
    if (fx === 0) {
      const y = fy < 0 ? p.y - d : p.y + h - 1 + d;
      for (let x = p.x; x < p.x + w; x++) out.push([x, y]);
    } else {
      const x = fx < 0 ? p.x - d : p.x + w - 1 + d;
      for (let y = p.y; y < p.y + h; y++) out.push([x, y]);
    }
  }
  return out;
}

export function designBounds(design: Design): { minX: number; minY: number; w: number; h: number } {
  if (design.tiles.length === 0) return { minX: 0, minY: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of design.tiles) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Placement rules of spec section 4. Returns human-readable problems; empty means valid. */
export function validateDesign(content: Content, design: Design): string[] {
  const errors: string[] = [];
  const key = (x: number, y: number) => y * MAX_GRID + x;
  const tiles = new Set<number>();

  for (const [x, y] of design.tiles) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= MAX_GRID || y >= MAX_GRID) {
      errors.push(`Tile (${x},${y}) is outside the ${MAX_GRID}x${MAX_GRID} grid.`);
      continue;
    }
    if (tiles.has(key(x, y))) errors.push(`Tile (${x},${y}) is listed twice.`);
    tiles.add(key(x, y));
  }

  const occupied = new Map<number, number>();
  let cores = 0;
  let computers = 0;
  let coreCell = -1;

  design.parts.forEach((p, i) => {
    const di = partDefIndex(content, p.type);
    if (di < 0) {
      errors.push(`Part ${i} has unknown type "${p.type}".`);
      return;
    }
    const def = content.parts[di];
    if (def.kind === 'tile') {
      errors.push(`Part ${i}: platform tiles belong in "tiles", not "parts".`);
      return;
    }
    if (p.rot !== 0 && p.rot !== 90 && p.rot !== 180 && p.rot !== 270) {
      errors.push(`Part ${i} (${p.type}) has rotation ${p.rot}.`);
      return;
    }
    const w = rotW(def, p.rot);
    const h = rotH(def, p.rot);
    for (let y = p.y; y < p.y + h; y++) {
      for (let x = p.x; x < p.x + w; x++) {
        if (!tiles.has(key(x, y)) || x < 0 || x >= MAX_GRID) {
          errors.push(`Part ${i} (${p.type}) has no platform tile at (${x},${y}).`);
        } else if (occupied.has(key(x, y))) {
          errors.push(`Part ${i} (${p.type}) overlaps part ${occupied.get(key(x, y))} at (${x},${y}).`);
        } else {
          occupied.set(key(x, y), i);
        }
      }
    }
    if (def.kind === 'core') {
      cores++;
      coreCell = key(p.x, p.y);
    }
    if (def.kind === 'computer') {
      computers++;
      const n = p.behaviors?.length ?? 0;
      if (n > (def.slots ?? 0)) errors.push(`${def.name} has ${def.slots} behavior slots but ${n} behaviors.`);
      for (const b of p.behaviors ?? []) {
        if (!content.behaviors.some((d) => d.id === b.id)) errors.push(`Unknown behavior "${b.id}".`);
      }
    }
    if (def.kind === 'thruster') {
      for (const [x, y] of nozzleCells(def, p)) {
        if (x >= 0 && y >= 0 && x < MAX_GRID && y < MAX_GRID && tiles.has(key(x, y))) {
          errors.push(`Part ${i} (${p.type}) needs (${x},${y}) behind its nozzle empty.`);
        }
      }
    }
  });

  if (cores !== 1) errors.push(`A ship needs exactly one core; this one has ${cores}.`);
  if (computers > 1) errors.push(`A ship may have at most one flight computer; this one has ${computers}.`);

  if (cores === 1 && coreCell >= 0 && tiles.has(coreCell)) {
    const seen = new Set<number>([coreCell]);
    const stack = [coreCell];
    while (stack.length) {
      const c = stack.pop()!;
      const x = c % MAX_GRID;
      const y = (c - x) / MAX_GRID;
      const nbrs = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (const [nx, ny] of nbrs) {
        if (nx < 0 || ny < 0 || nx >= MAX_GRID || ny >= MAX_GRID) continue;
        const k = key(nx, ny);
        if (tiles.has(k) && !seen.has(k)) {
          seen.add(k);
          stack.push(k);
        }
      }
    }
    if (seen.size !== tiles.size) {
      errors.push(`${tiles.size - seen.size} platform tiles are not connected to the core.`);
    }
  }
  return errors;
}

/** Launch check (run lifecycle step 1): the design fits the lane and is buildable. */
export function checkLaunch(content: Content, design: Design, lane: LaneDef): string[] {
  const errors = validateDesign(content, design);
  const b = designBounds(design);
  if (b.w > lane.maxSize[0] || b.h > lane.maxSize[1]) {
    errors.push(`Ship is ${b.w}x${b.h}; ${lane.name} allows ${lane.maxSize[0]}x${lane.maxSize[1]}.`);
  }
  return errors;
}

/**
 * Hash of the canonical design JSON, name excluded. Certification is tied to it.
 * Tile order is normalized because it cannot affect a run; part order is kept
 * because part ids set the sim's iteration order.
 */
export function designHash(design: Design): string {
  const tiles = design.tiles.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return new Hasher().str(canonicalJson({ tiles, parts: design.parts })).hex();
}
