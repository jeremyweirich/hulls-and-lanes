// A ship compiled from a design: the cell grid, part state, mass properties,
// fuel networks and the rigid body. All per-tick work runs on typed arrays
// allocated once here.
//
// Frames. Grid space has x to the right and y down the screen, one unit per
// cell, forward = -y. World (lane) space has the same handedness: the ship
// travels toward -y, and lane distance is -y. A grid point g maps to
//   world = pos + R(theta) * (g - com),  R = [cos -sin; sin cos]
// where pos is the world position of the center of mass.

import { compile } from './compiled';
import { dcos, dsin } from './dmath';
import { designBounds, facing, partDefIndex, rotH, rotW, validateDesign } from './design';
import type { Content, Design, PartDef } from './types';

export class Ship {
  // Grid
  gw = 0;
  gh = 0;
  /** Part id on each cell, -1 for none. */
  cellPart!: Int16Array;
  /** 1 while the cell's platform tile exists. */
  cellTile!: Uint8Array;
  /** HP of a bare tile. Cells under a part share the part's HP pool instead. */
  cellHp!: Float64Array;
  cellNet!: Int16Array;

  // Parts, indexed by part id (the order they appear in the design)
  n = 0;
  defs: PartDef[] = [];
  /** Index of each part's definition in content.parts. */
  partDef!: Int16Array;
  partX!: Int16Array;
  partY!: Int16Array;
  partW!: Int16Array;
  partH!: Int16Array;
  partHp!: Float64Array;
  partAlive!: Uint8Array;
  partFuel!: Float64Array;
  partItems!: Int32Array;
  /** Fuel network of a pipe, tank or fuel consumer; -1 when unconnected. */
  partNet!: Int16Array;
  corePart = -1;
  computerPart = -1;

  // Thrusters, in part-id order
  nThr = 0;
  thrPart!: Int16Array;
  /** Center in grid space. */
  thrCx!: Float64Array;
  thrCy!: Float64Array;
  /** Unit force direction in the ship frame (opposite the nozzle). */
  thrFx!: Float64Array;
  thrFy!: Float64Array;
  thrMax!: Float64Array;
  thrBurn!: Float64Array;
  /** Throttle the autopilot asked for, 0..1. Warm-starts next tick's allocation. */
  thrThrottle!: Float64Array;
  /** Throttle actually delivered after the fuel step. */
  thrEff!: Float64Array;
  /** Gyro command, -1..1, times constants.gyroTorque. */
  gyro = 0;

  // Logistics. Every part has an inventory row; belts hold their one item in beltItem.
  nItems = 0;
  /** Item counts, [part * nItems + item]. */
  inv!: Int32Array;
  /** Facing: 0 forward (-y), 1 right, 2 back, 3 left. */
  partDir!: Int8Array;
  /** Machine's current recipe index, or -1. */
  partRecipe!: Int16Array;
  /** 1 when the recipe was set at the hub; 0 when the machine picks by input. */
  partFixedRecipe!: Uint8Array;
  /** Ticks left on the craft in progress; 0 when idle. */
  partProgress!: Int16Array;
  /** Belt: ticks its item has sat there. Inserter and collector: cooldown ticks left. */
  partTimer!: Int16Array;
  beltItem!: Int8Array;
  /** Belt the item moves on to, or -1. */
  beltNext!: Int16Array;
  /** Belts sorted head of line first. */
  beltOrder!: Int16Array;
  nBelts = 0;
  /** Inserter source and destination cells, or -1 when off the grid. */
  insSrc!: Int32Array;
  insDst!: Int32Array;
  insFilter!: Int8Array;
  /** Part ids by role, in part-id order. */
  inserters: number[] = [];
  machines: number[] = [];
  collectors: number[] = [];
  turrets: number[] = [];
  stores: number[] = [];
  turCooldown!: Float64Array;
  /** Target asteroid slot and its id, or -1. */
  turTarget!: Int16Array;
  turTargetId!: Int32Array;
  repairTimer = 0;

  // Fuel networks
  netCount = 0;
  netAvail!: Float64Array;
  netRequest!: Float64Array;

  // Mass properties
  mass = 0;
  comX = 0;
  comY = 0;
  inertia = 0;
  /** Radius around the center of mass that contains the whole grid. */
  radius = 0;

  // Rigid body
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  theta = 0;
  omega = 0;
  cos = 1;
  sin = 0;
  /** Last tick's transform, for render interpolation. */
  prevX = 0;
  prevY = 0;
  prevTheta = 0;

  // Damage bookkeeping
  structureDirty = false;
  coreDestroyed = false;
  partsLost = 0;
  /** Part ids destroyed or detached since the sim last drained the queue. */
  lostQueue!: Int16Array;
  lostCount = 0;

  // Scratch space for flood fills, and the platform tile's stats
  stack!: Int32Array;
  seen!: Uint8Array;
  tileMass = 1;
}

export function buildShip(content: Content, design: Design): Ship {
  const errors = validateDesign(content, design);
  if (errors.length) throw new Error('Invalid design: ' + errors.join(' '));

  const s = new Ship();
  const b = designBounds(design);
  const cells = b.w * b.h;
  s.gw = b.w;
  s.gh = b.h;
  s.cellPart = new Int16Array(cells).fill(-1);
  s.cellTile = new Uint8Array(cells);
  s.cellHp = new Float64Array(cells);
  s.cellNet = new Int16Array(cells).fill(-1);
  s.stack = new Int32Array(cells);
  s.seen = new Uint8Array(cells);

  const tileDef = content.parts[partDefIndex(content, 'platform_tile')];
  s.tileMass = tileDef.mass;
  for (const [tx, ty] of design.tiles) {
    const c = (ty - b.minY) * b.w + (tx - b.minX);
    s.cellTile[c] = 1;
    s.cellHp[c] = tileDef.hp;
  }

  const n = design.parts.length;
  s.n = n;
  s.partDef = new Int16Array(n);
  s.partX = new Int16Array(n);
  s.partY = new Int16Array(n);
  s.partW = new Int16Array(n);
  s.partH = new Int16Array(n);
  s.partHp = new Float64Array(n);
  s.partAlive = new Uint8Array(n).fill(1);
  s.partFuel = new Float64Array(n);
  s.partItems = new Int32Array(n);
  s.partNet = new Int16Array(n).fill(-1);
  s.lostQueue = new Int16Array(n);
  const cc = compile(content);
  s.nItems = cc.nItems;
  s.inv = new Int32Array(n * cc.nItems);
  s.partDir = new Int8Array(n);
  s.partRecipe = new Int16Array(n).fill(-1);
  s.partFixedRecipe = new Uint8Array(n);
  s.partProgress = new Int16Array(n);
  s.partTimer = new Int16Array(n);
  s.beltItem = new Int8Array(n).fill(-1);
  s.beltNext = new Int16Array(n).fill(-1);
  s.beltOrder = new Int16Array(n);
  s.insSrc = new Int32Array(n).fill(-1);
  s.insDst = new Int32Array(n).fill(-1);
  s.insFilter = new Int8Array(n).fill(-1);
  s.turCooldown = new Float64Array(n);
  s.turTarget = new Int16Array(n).fill(-1);
  s.turTargetId = new Int32Array(n).fill(-1);
  s.netAvail = new Float64Array(n + 1);
  s.netRequest = new Float64Array(n + 1);

  let nThr = 0;
  for (const p of design.parts) {
    if (content.parts[partDefIndex(content, p.type)].kind === 'thruster') nThr++;
  }
  s.thrPart = new Int16Array(nThr);
  s.thrCx = new Float64Array(nThr);
  s.thrCy = new Float64Array(nThr);
  s.thrFx = new Float64Array(nThr);
  s.thrFy = new Float64Array(nThr);
  s.thrMax = new Float64Array(nThr);
  s.thrBurn = new Float64Array(nThr);
  s.thrThrottle = new Float64Array(nThr);
  s.thrEff = new Float64Array(nThr);

  design.parts.forEach((p, i) => {
    const def = content.parts[partDefIndex(content, p.type)];
    const w = rotW(def, p.rot);
    const h = rotH(def, p.rot);
    const px = p.x - b.minX;
    const py = p.y - b.minY;
    s.defs.push(def);
    s.partDef[i] = partDefIndex(content, p.type);
    s.partX[i] = px;
    s.partY[i] = py;
    s.partW[i] = w;
    s.partH[i] = h;
    s.partHp[i] = def.hp;
    for (let y = py; y < py + h; y++) {
      for (let x = px; x < px + w; x++) s.cellPart[y * b.w + x] = i;
    }
    if (def.kind === 'core') s.corePart = i;
    if (def.kind === 'computer') s.computerPart = i;
    const [dx, dy] = facing(p.rot);
    s.partDir[i] = p.rot / 90;
    if (def.kind === 'core' || def.kind === 'storage') s.stores.push(i);
    if (def.kind === 'collector') s.collectors.push(i);
    if (def.kind === 'turret') s.turrets.push(i);
    if (def.kind === 'inserter') {
      s.inserters.push(i);
      const sx = px - dx, sy = py - dy, tx = px + dx, ty = py + dy;
      if (sx >= 0 && sy >= 0 && sx < b.w && sy < b.h) s.insSrc[i] = sy * b.w + sx;
      if (tx >= 0 && ty >= 0 && tx < b.w && ty < b.h) s.insDst[i] = ty * b.w + tx;
      if (p.filter) s.insFilter[i] = cc.itemIndex[p.filter];
    }
    if (def.kind === 'machine') {
      s.machines.push(i);
      const options = cc.recipesByMachine[partDefIndex(content, p.type)];
      if (p.recipe) {
        s.partRecipe[i] = cc.recipes.findIndex((r) => r.id === p.recipe);
        s.partFixedRecipe[i] = 1;
      } else if (options.length === 1) {
        s.partRecipe[i] = options[0];
        s.partFixedRecipe[i] = 1;
      }
    }
    if (def.kind === 'thruster') {
      const t = s.nThr++;
      const [fx, fy] = facing(p.rot);
      s.thrPart[t] = i;
      s.thrCx[t] = px + w / 2;
      s.thrCy[t] = py + h / 2;
      s.thrFx[t] = fx === 0 ? 0 : -fx;
      s.thrFy[t] = fy === 0 ? 0 : -fy;
      s.thrMax[t] = def.thrust ?? 0;
      s.thrBurn[t] = def.burn ?? 0;
    }
  });

  rebuildFuelNetworks(s);
  rebuildBelts(s);
  recomputeMass(s, content, false);
  return s;
}

/**
 * Mass, center of mass and inertia from the grid (spec section 5). Each cell is
 * a point mass at its center: its tile, an even share of its part, and an even
 * share of the part's cargo. With keepMotion, the body's position and velocity
 * are moved to the new center of mass so the hull does not jump.
 */
export function recomputeMass(s: Ship, content: Content, keepMotion: boolean): void {
  const { gw, gh } = s;
  const k = content.constants;
  let m = 0;
  let mx = 0;
  let my = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const c = y * gw + x;
      if (!s.cellTile[c]) continue;
      const cm = cellMass(s, c, s.tileMass, k.itemMass, k.fuelMass);
      m += cm;
      mx += cm * (x + 0.5);
      my += cm * (y + 0.5);
    }
  }
  const oldX = s.comX;
  const oldY = s.comY;
  if (m <= 0) {
    s.mass = 0;
    s.inertia = 0;
    return;
  }
  const cx = mx / m;
  const cy = my / m;
  let inertia = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const c = y * gw + x;
      if (!s.cellTile[c]) continue;
      const cm = cellMass(s, c, s.tileMass, k.itemMass, k.fuelMass);
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      inertia += cm * (dx * dx + dy * dy) + cm / 6;
    }
  }
  s.mass = m;
  s.comX = cx;
  s.comY = cy;
  s.inertia = inertia;

  // Farthest grid corner from the center of mass.
  const fx = cx > gw - cx ? cx : gw - cx;
  const fy = cy > gh - cy ? cy : gh - cy;
  s.radius = Math.sqrt(fx * fx + fy * fy);

  if (keepMotion) {
    const dx = cx - oldX;
    const dy = cy - oldY;
    const wx = s.cos * dx - s.sin * dy;
    const wy = s.sin * dx + s.cos * dy;
    s.x += wx;
    s.y += wy;
    s.vx -= s.omega * wy;
    s.vy += s.omega * wx;
  }
}

function cellMass(s: Ship, c: number, tileMass: number, itemMass: number, fuelMass: number): number {
  const p = s.cellPart[c];
  if (p < 0) return tileMass;
  const cells = s.partW[p] * s.partH[p];
  return tileMass + (s.defs[p].mass + s.partItems[p] * itemMass + s.partFuel[p] * fuelMass) / cells;
}

/** Recomputes the cached rotation after theta changes. */
export function updateRotation(s: Ship): void {
  s.cos = dcos(s.theta);
  s.sin = dsin(s.theta);
}

/** Places the body so the given grid point sits at a world position. */
export function placeGridPointAt(s: Ship, gx: number, gy: number, wx: number, wy: number): void {
  const dx = gx - s.comX;
  const dy = gy - s.comY;
  s.x = wx - (s.cos * dx - s.sin * dy);
  s.y = wy - (s.sin * dx + s.cos * dy);
}

/** World x of the core's center. */
export function coreWorldX(s: Ship): number {
  const p = s.corePart;
  const dx = s.partX[p] + s.partW[p] / 2 - s.comX;
  const dy = s.partY[p] + s.partH[p] / 2 - s.comY;
  return s.x + s.cos * dx - s.sin * dy;
}

/** World y of the core's center. Lane distance is its negative. */
export function coreWorldY(s: Ship): number {
  const p = s.corePart;
  const dx = s.partX[p] + s.partW[p] / 2 - s.comX;
  const dy = s.partY[p] + s.partH[p] / 2 - s.comY;
  return s.y + s.sin * dx + s.cos * dy;
}

function destroyPart(s: Ship, p: number): void {
  s.partAlive[p] = 0;
  s.partHp[p] = 0;
  s.partFuel[p] = 0;
  s.partItems[p] = 0;
  s.partNet[p] = -1;
  s.inv.fill(0, p * s.nItems, (p + 1) * s.nItems);
  s.beltItem[p] = -1;
  s.partProgress[p] = 0;
  const x0 = s.partX[p];
  const y0 = s.partY[p];
  for (let y = y0; y < y0 + s.partH[p]; y++) {
    for (let x = x0; x < x0 + s.partW[p]; x++) {
      const c = y * s.gw + x;
      s.cellPart[c] = -1;
      s.cellTile[c] = 0;
      s.cellHp[c] = 0;
    }
  }
  s.lostQueue[s.lostCount++] = p;
  s.partsLost++;
  s.structureDirty = true;
  if (p === s.corePart) s.coreDestroyed = true;
}

/**
 * Applies damage to one cell. A part has one HP pool however many cells it
 * covers; destroying it removes all its cells and their tiles. Returns the
 * damage left over if the cell was destroyed, else 0.
 */
export function damageCell(s: Ship, cx: number, cy: number, damage: number): number {
  const c = cy * s.gw + cx;
  if (!s.cellTile[c]) return damage;
  const p = s.cellPart[c];
  if (p >= 0) {
    const hp = s.partHp[p] - damage;
    if (hp > 0) {
      s.partHp[p] = hp;
      return 0;
    }
    destroyPart(s, p);
    return -hp;
  }
  const hp = s.cellHp[c] - damage;
  if (hp > 0) {
    s.cellHp[c] = hp;
    return 0;
  }
  s.cellHp[c] = 0;
  s.cellTile[c] = 0;
  s.structureDirty = true;
  return -hp;
}

/**
 * Structure step: flood-fills from the core, detaches everything no longer
 * connected to it, then rebuilds fuel networks and mass properties. Returns the
 * number of parts detached.
 */
export function resolveStructure(s: Ship, content: Content): number {
  s.structureDirty = false;
  if (s.coreDestroyed) return 0;
  const { gw, gh } = s;
  const seen = s.seen;
  const stack = s.stack;
  seen.fill(0);
  let top = 0;
  const start = s.partY[s.corePart] * gw + s.partX[s.corePart];
  seen[start] = 1;
  stack[top++] = start;
  while (top > 0) {
    const c = stack[--top];
    const x = c % gw;
    const y = (c - x) / gw;
    if (x + 1 < gw && s.cellTile[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack[top++] = c + 1; }
    if (x > 0 && s.cellTile[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack[top++] = c - 1; }
    if (y + 1 < gh && s.cellTile[c + gw] && !seen[c + gw]) { seen[c + gw] = 1; stack[top++] = c + gw; }
    if (y > 0 && s.cellTile[c - gw] && !seen[c - gw]) { seen[c - gw] = 1; stack[top++] = c - gw; }
  }
  let detached = 0;
  for (let c = 0; c < gw * gh; c++) {
    if (!s.cellTile[c] || seen[c]) continue;
    const p = s.cellPart[c];
    if (p >= 0) {
      destroyPart(s, p);
      detached++;
    } else {
      s.cellTile[c] = 0;
      s.cellHp[c] = 0;
    }
  }
  s.structureDirty = false;
  rebuildFuelNetworks(s);
  rebuildBelts(s);
  recomputeMass(s, content, true);
  return detached;
}

function carriesFuel(def: PartDef): boolean {
  return def.kind === 'pipe' || def.kind === 'tank';
}

function usesFuel(def: PartDef): boolean {
  return def.kind === 'thruster' || def.kind === 'generator'
    || def.id === 'chem_plant' || def.id === 'alloy_furnace';
}

/**
 * Fuel networks (spec section 7): connected groups of pipes and tanks, plus
 * each consumer touching one. Called at build and whenever structure changes,
 * so a cut pipe can leave one fed half and one dry half.
 */
export function rebuildFuelNetworks(s: Ship): void {
  const { gw, gh } = s;
  const stack = s.stack;
  s.cellNet.fill(-1);
  s.partNet.fill(-1);
  let nets = 0;
  const carrier = (c: number) => {
    const p = s.cellPart[c];
    return p >= 0 && carriesFuel(s.defs[p]);
  };
  for (let c0 = 0; c0 < gw * gh; c0++) {
    if (s.cellNet[c0] >= 0 || !carrier(c0)) continue;
    const id = nets++;
    let top = 0;
    s.cellNet[c0] = id;
    stack[top++] = c0;
    while (top > 0) {
      const c = stack[--top];
      s.partNet[s.cellPart[c]] = id;
      const x = c % gw;
      const y = (c - x) / gw;
      if (x + 1 < gw && s.cellNet[c + 1] < 0 && carrier(c + 1)) { s.cellNet[c + 1] = id; stack[top++] = c + 1; }
      if (x > 0 && s.cellNet[c - 1] < 0 && carrier(c - 1)) { s.cellNet[c - 1] = id; stack[top++] = c - 1; }
      if (y + 1 < gh && s.cellNet[c + gw] < 0 && carrier(c + gw)) { s.cellNet[c + gw] = id; stack[top++] = c + gw; }
      if (y > 0 && s.cellNet[c - gw] < 0 && carrier(c - gw)) { s.cellNet[c - gw] = id; stack[top++] = c - gw; }
    }
  }
  s.netCount = nets;

  // A consumer joins the lowest-numbered network touching its footprint.
  for (let p = 0; p < s.n; p++) {
    if (!s.partAlive[p] || !usesFuel(s.defs[p])) continue;
    const x0 = s.partX[p];
    const y0 = s.partY[p];
    const x1 = x0 + s.partW[p] - 1;
    const y1 = y0 + s.partH[p] - 1;
    let best = -1;
    for (let x = x0; x <= x1; x++) {
      if (y0 > 0) best = lowerNet(best, s.cellNet[(y0 - 1) * gw + x]);
      if (y1 + 1 < gh) best = lowerNet(best, s.cellNet[(y1 + 1) * gw + x]);
    }
    for (let y = y0; y <= y1; y++) {
      if (x0 > 0) best = lowerNet(best, s.cellNet[y * gw + x0 - 1]);
      if (x1 + 1 < gw) best = lowerNet(best, s.cellNet[y * gw + x1 + 1]);
    }
    s.partNet[p] = best;
  }
  refreshFuelAvail(s);
}

function lowerNet(best: number, net: number): number {
  if (net < 0) return best;
  return best < 0 || net < best ? net : best;
}

/** Sums the fuel held by each network's tanks into netAvail. */
export function refreshFuelAvail(s: Ship): void {
  for (let i = 0; i < s.netCount; i++) s.netAvail[i] = 0;
  for (let p = 0; p < s.n; p++) {
    if (s.partFuel[p] > 0 && s.partNet[p] >= 0) s.netAvail[s.partNet[p]] += s.partFuel[p];
  }
}

export function totalFuel(s: Ship): number {
  let f = 0;
  for (let p = 0; p < s.n; p++) f += s.partFuel[p];
  return f;
}

/** Launch load: splits fuel evenly across tanks. What does not fit is left behind. */
export function loadFuel(s: Ship, amount: number): void {
  let left = amount;
  for (let pass = 0; pass < 8 && left > 1e-9; pass++) {
    let open = 0;
    for (let p = 0; p < s.n; p++) {
      if (s.partAlive[p] && (s.defs[p].fuelCapacity ?? 0) > s.partFuel[p]) open++;
    }
    if (open === 0) break;
    const share = left / open;
    for (let p = 0; p < s.n; p++) {
      const cap = s.defs[p].fuelCapacity ?? 0;
      if (!s.partAlive[p] || cap <= s.partFuel[p]) continue;
      const room = cap - s.partFuel[p];
      const add = share < room ? share : room;
      s.partFuel[p] += add;
      left -= add;
    }
  }
  refreshFuelAvail(s);
}

/**
 * Fuel step (tick order 4): each network serves its thrusters. When its tanks
 * hold less than the tick's total request, every consumer is scaled by the same
 * ratio. Tanks drain in proportion to what they hold.
 */
export function resolveFuel(s: Ship, dt: number): void {
  refreshFuelAvail(s);
  for (let i = 0; i < s.netCount; i++) s.netRequest[i] = 0;
  for (let t = 0; t < s.nThr; t++) {
    const p = s.thrPart[t];
    const net = s.partNet[p];
    if (!s.partAlive[p] || net < 0) {
      s.thrEff[t] = 0;
      continue;
    }
    s.netRequest[net] += s.thrThrottle[t] * s.thrBurn[t] * dt;
  }
  for (let t = 0; t < s.nThr; t++) {
    const p = s.thrPart[t];
    const net = s.partNet[p];
    if (!s.partAlive[p] || net < 0) continue;
    const req = s.netRequest[net];
    const avail = s.netAvail[net];
    s.thrEff[t] = req > avail ? s.thrThrottle[t] * (avail / req) : s.thrThrottle[t];
  }
  for (let p = 0; p < s.n; p++) {
    const net = s.partNet[p];
    if (net < 0 || s.partFuel[p] <= 0) continue;
    const req = s.netRequest[net];
    const avail = s.netAvail[net];
    if (req <= 0) continue;
    if (req >= avail) s.partFuel[p] = 0;
    else s.partFuel[p] -= req * (s.partFuel[p] / avail);
  }
}

/** Adds n of an item to a part's inventory and keeps its cargo count in step. */
export function addItem(s: Ship, p: number, item: number, n: number): void {
  s.inv[p * s.nItems + item] += n;
  s.partItems[p] += n;
}

export function itemCount(s: Ship, p: number, item: number): number {
  return s.inv[p * s.nItems + item];
}

/** Total of one item across every part. */
export function shipItemCount(s: Ship, item: number): number {
  let n = 0;
  for (let p = 0; p < s.n; p++) n += s.inv[p * s.nItems + item];
  return n;
}

const DIR_X = [0, 1, 0, -1];
const DIR_Y = [-1, 0, 1, 0];

/**
 * Works out where each belt hands its item on, and an update order that runs
 * from the head of each line backward so a full line moves together. A belt
 * feeds the belt it points at, including into its side, but not head-on.
 */
export function rebuildBelts(s: Ship): void {
  const { gw, gh } = s;
  const depth = s.stack;
  let count = 0;
  for (let p = 0; p < s.n; p++) {
    s.beltNext[p] = -1;
    if (!s.partAlive[p] || s.defs[p].kind !== 'belt') continue;
    s.beltOrder[count++] = p;
    const d = s.partDir[p];
    const x = s.partX[p] + DIR_X[d];
    const y = s.partY[p] + DIR_Y[d];
    if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
    const q = s.cellPart[y * gw + x];
    if (q >= 0 && s.defs[q].kind === 'belt' && ((s.partDir[q] + 2) & 3) !== d) s.beltNext[p] = q;
  }
  s.nBelts = count;
  // Depth = hops to the head of the line. Belts in a loop get a depth past every line.
  for (let i = 0; i < count; i++) {
    let p: number = s.beltOrder[i];
    let hops = 0;
    while (s.beltNext[p] >= 0 && hops <= count) {
      p = s.beltNext[p];
      hops++;
    }
    depth[s.beltOrder[i]] = hops > count ? count + 1 : hops;
  }
  // Insertion sort by (depth, part id); beltOrder starts in part-id order.
  for (let i = 1; i < count; i++) {
    const p = s.beltOrder[i];
    let j = i - 1;
    while (j >= 0 && depth[s.beltOrder[j]] > depth[p]) {
      s.beltOrder[j + 1] = s.beltOrder[j];
      j--;
    }
    s.beltOrder[j + 1] = p;
  }
}
