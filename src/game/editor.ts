// The shipyard's editing model (spec section 12): place, path, rotate, move and
// erase on a design, with symmetry, undo and redo. No DOM, so it runs in tests.
//
// The editor works in a 64x64 workspace with the ship near the middle, so the
// player can build out in any direction. normalized() moves the result back so
// its top-left tile is at (0,0), which is how designs are stored.
//
// Placement errors come from the sim's own validateDesign: an edit is refused
// when it would add a problem the design did not already have. Costs come from
// designCost and are checked against the funds the player has for this ship
// (stockpile plus what the ship is already worth, since removing refunds 100%).

import { designBounds, MAX_GRID, partDefIndex, rotH, rotW, validateDesign } from '../sim';
import type { Content, Design, PartDef, PartInstance, Rot } from '../sim';
import { designCost } from './game';

export interface EditResult {
  ok: boolean;
  /** Why the edit was refused, in plain words. */
  reason?: string;
}

/** What an edit would add, and why it would be refused (null if it would not). */
export interface Preview {
  parts: PartInstance[];
  tiles: [number, number][];
  reason: string | null;
}

const OK: EditResult = { ok: true };
const UNDO_LIMIT = 100;

export function cloneDesign(d: Design): Design {
  return {
    name: d.name,
    tiles: d.tiles.map(([x, y]) => [x, y] as [number, number]),
    parts: d.parts.map((p) => ({ ...p, behaviors: p.behaviors?.map((b) => ({ ...b })) })),
  };
}

export function translateDesign(d: Design, dx: number, dy: number): Design {
  const out = cloneDesign(d);
  for (const t of out.tiles) {
    t[0] += dx;
    t[1] += dy;
  }
  for (const p of out.parts) {
    p.x += dx;
    p.y += dy;
  }
  return out;
}

/** The design moved so its top-left tile is at (0,0). */
export function normalizeDesign(d: Design): Design {
  if (d.tiles.length === 0) return cloneDesign(d);
  const b = designBounds(d);
  return translateDesign(d, -b.minX, -b.minY);
}

/** Rotation of a part's mirror image across a vertical line. */
export function mirrorRot(rot: Rot): Rot {
  return rot === 90 ? 270 : rot === 270 ? 90 : rot;
}

function nextRot(rot: Rot): Rot {
  return ((rot + 90) % 360) as Rot;
}

/** Number in "N platform tiles are not connected to the core." */
function disconnected(errors: string[]): number {
  for (const e of errors) {
    const m = /^(\d+) platform tiles are not connected/.exec(e);
    if (m) return Number(m[1]);
  }
  return 0;
}

export class DesignEditor {
  /** The design being edited, in workspace coordinates. */
  design: Design;
  symmetry = false;
  /** Bumped on every change, so views know when to redraw. */
  version = 0;

  private undoStack: Design[] = [];
  private redoStack: Design[] = [];
  private txStart: Design | null = null;
  private readonly cellPart = new Int16Array(MAX_GRID * MAX_GRID);
  private readonly cellTile = new Uint8Array(MAX_GRID * MAX_GRID);

  /**
   * design is a stored (normalized) design; it is centred in the workspace.
   * funds caps what the design may cost; null means no limit. A function is
   * asked each time, so income that arrives while editing counts at once.
   */
  constructor(
    readonly content: Content,
    design: Design,
    private readonly fundsSource: Record<string, number> | (() => Record<string, number>) | null = null,
  ) {
    const b = designBounds(design);
    const dx = Math.floor(MAX_GRID / 2 - b.w / 2) - b.minX;
    const dy = Math.floor(MAX_GRID / 2 - b.h / 2) - b.minY;
    this.design = design.tiles.length ? translateDesign(design, dx, dy) : cloneDesign(design);
    this.reindex();
  }

  /** The design as it is stored: top-left tile at (0,0). */
  normalized(): Design {
    return normalizeDesign(this.design);
  }

  // ---- Queries -------------------------------------------------------------

  def(type: string): PartDef {
    return this.content.parts[partDefIndex(this.content, type)];
  }

  inGrid(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < MAX_GRID && y < MAX_GRID;
  }

  /** Index of the part on a cell, or -1. */
  partAt(x: number, y: number): number {
    return this.inGrid(x, y) ? this.cellPart[y * MAX_GRID + x] : -1;
  }

  hasTile(x: number, y: number): boolean {
    return this.inGrid(x, y) && this.cellTile[y * MAX_GRID + x] === 1;
  }

  coreIndex(): number {
    return this.design.parts.findIndex((p) => this.def(p.type).kind === 'core');
  }

  /**
   * Twice the x of the ship's vertical centre line (the core's centre), in cell
   * edges, or null with no core. A cell x mirrors to axis2 - 1 - x.
   */
  axis2(): number | null {
    const i = this.coreIndex();
    if (i < 0) return null;
    const p = this.design.parts[i];
    return 2 * p.x + rotW(this.def(p.type), p.rot);
  }

  footprint(p: PartInstance): { x: number; y: number; w: number; h: number } {
    const def = this.def(p.type);
    return { x: p.x, y: p.y, w: rotW(def, p.rot), h: rotH(def, p.rot) };
  }

  /** The mirror image of a part across the centre line. */
  mirrorOf(p: PartInstance, axis2: number): PartInstance {
    const w = rotW(this.def(p.type), p.rot);
    return { ...p, x: axis2 - p.x - w, rot: mirrorRot(p.rot), behaviors: p.behaviors?.map((b) => ({ ...b })) };
  }

  /** The part that is this one's mirror image, if symmetry is on and there is one. */
  partnerOf(i: number): number {
    const axis2 = this.axis2();
    if (!this.symmetry || axis2 === null) return -1;
    const m = this.mirrorOf(this.design.parts[i], axis2);
    const j = this.partAt(m.x, m.y);
    if (j < 0 || j === i) return -1;
    const q = this.design.parts[j];
    return q.type === m.type && q.x === m.x && q.y === m.y && q.rot === m.rot ? j : -1;
  }

  /** Errors that block launch, from the sim's own rules. */
  problems(): string[] {
    return validateDesign(this.content, this.design);
  }

  cost(): Record<string, number> {
    return designCost(this.content, this.design);
  }

  /** What the design may cost in all, or null with no limit. */
  get funds(): Record<string, number> | null {
    const f = this.fundsSource;
    return typeof f === 'function' ? f() : f;
  }

  /** Funds left after paying for the current design, or null with no limit. */
  remaining(): Record<string, number> | null {
    const funds = this.funds;
    if (!funds) return null;
    const cost = this.cost();
    const out: Record<string, number> = { ...funds };
    for (const [id, n] of Object.entries(cost)) out[id] = (out[id] ?? 0) - n;
    return out;
  }

  /** Would a candidate design be acceptable? Returns a reason when not. */
  check(candidate: Design): string | null {
    const before = validateDesign(this.content, this.design);
    const after = validateDesign(this.content, candidate);
    const known = new Set(before);
    for (const e of after) {
      if (known.has(e)) continue;
      // Fewer cut-off tiles than before is an improvement, not a new problem.
      if (/platform tiles are not connected/.test(e) && disconnected(after) <= disconnected(before)) continue;
      return this.friendly(e, candidate);
    }
    const funds = this.funds;
    if (funds) {
      const cost = designCost(this.content, candidate);
      for (const [id, n] of Object.entries(cost)) {
        const have = funds[id] ?? 0;
        if (n > have) {
          const name = this.content.items.find((it) => it.id === id)?.name.toLowerCase() ?? id;
          return `Not enough ${name}: needs ${n - have} more.`;
        }
      }
    }
    return null;
  }

  private friendly(e: string, candidate: Design): string {
    let m = /overlaps part (\d+)/.exec(e);
    if (m) return `Overlaps the ${this.def(candidate.parts[Number(m[1])].type).name.toLowerCase()}.`;
    m = /^Part (\d+) \(([a-z_0-9]+)\) needs/.exec(e);
    if (m) {
      return this.def(m[2]).kind === 'thruster' && Number(m[1]) >= this.design.parts.length
        ? 'A thruster needs the two cells behind its nozzle empty.'
        : "That would block a thruster's exhaust.";
    }
    if (/not connected/.test(e)) return 'It must connect to the hull.';
    if (/exactly one core/.test(e)) return 'A ship has exactly one core.';
    if (/at most one flight computer/.test(e)) return 'A ship can have only one flight computer.';
    if (/outside/.test(e) || /no platform tile/.test(e)) return 'Outside the build area.';
    return e;
  }

  // ---- Transactions and history -------------------------------------------

  /** Starts a gesture. Everything until commit() is one undo step. */
  begin(): void {
    if (!this.txStart) this.txStart = cloneDesign(this.design);
  }

  /** Ends a gesture, recording an undo step if anything changed. */
  commit(): boolean {
    const start = this.txStart;
    this.txStart = null;
    if (!start || JSON.stringify(start) === JSON.stringify(this.design)) return false;
    this.undoStack.push(start);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    return true;
  }

  /** Abandons a gesture, putting the design back as it was. */
  cancel(): void {
    if (!this.txStart) return;
    this.setDesign(this.txStart);
    this.txStart = null;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(cloneDesign(this.design));
    this.setDesign(prev);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(cloneDesign(this.design));
    this.setDesign(next);
    return true;
  }

  private setDesign(d: Design): void {
    this.design = d;
    this.reindex();
  }

  private apply(candidate: Design): EditResult {
    const reason = this.check(candidate);
    if (reason) return { ok: false, reason };
    this.setDesign(candidate);
    return OK;
  }

  private reindex(): void {
    this.cellPart.fill(-1);
    this.cellTile.fill(0);
    for (const [x, y] of this.design.tiles) if (this.inGrid(x, y)) this.cellTile[y * MAX_GRID + x] = 1;
    this.design.parts.forEach((p, i) => {
      const f = this.footprint(p);
      for (let y = f.y; y < f.y + f.h; y++) {
        for (let x = f.x; x < f.x + f.w; x++) if (this.inGrid(x, y)) this.cellPart[y * MAX_GRID + x] = i;
      }
    });
    this.version++;
  }

  // ---- Edits ---------------------------------------------------------------

  /** Adds a part to a candidate, with platform tiles under it where missing. Returns the tiles added. */
  private addPart(d: Design, p: PartInstance, push = true): [number, number][] {
    const added: [number, number][] = [];
    const f = this.footprint(p);
    for (let y = f.y; y < f.y + f.h; y++) {
      for (let x = f.x; x < f.x + f.w; x++) {
        if (!d.tiles.some(([tx, ty]) => tx === x && ty === y)) {
          d.tiles.push([x, y]);
          added.push([x, y]);
        }
      }
    }
    if (push) d.parts.push(p);
    return added;
  }

  private withMirror(p: PartInstance): PartInstance[] {
    const axis2 = this.axis2();
    if (!this.symmetry || axis2 === null || this.def(p.type).kind === 'core') return [p];
    const m = this.mirrorOf(p, axis2);
    const a = this.footprint(p);
    const b = this.footprint(m);
    const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    return overlap ? [p] : [p, m];
  }

  /** Default settings for a new part: fabricators make slugs, computers drive forward. */
  defaults(type: string): Partial<PartInstance> {
    const def = this.def(type);
    if (type === 'fabricator') return { recipe: 'slugs' };
    if (def.kind === 'computer') {
      const drive = this.content.behaviors.find((b) => b.id === 'drive_forward');
      return drive ? { behaviors: [{ id: drive.id, cruise: drive.params.cruise.default }] } : {};
    }
    return {};
  }

  private buildPlace(type: string, x: number, y: number, rot: Rot): Preview & { design: Design } {
    const d = cloneDesign(this.design);
    const parts = this.withMirror({ type, x, y, rot, ...this.defaults(type) });
    const tiles: [number, number][] = [];
    for (const p of parts) tiles.push(...this.addPart(d, p));
    return { design: d, parts, tiles, reason: null };
  }

  /** What placing a part would do, without doing it: for the ghost. */
  preview(type: string, x: number, y: number, rot: Rot = 0): Preview {
    const b = this.buildPlace(type, x, y, rot);
    return { parts: b.parts, tiles: b.tiles, reason: this.check(b.design) };
  }

  /** Places a part with its top-left cell at (x,y), mirrored if symmetry is on. */
  place(type: string, x: number, y: number, rot: Rot = 0): EditResult {
    if (this.def(type).kind === 'tile') return this.placeTile(x, y);
    return this.apply(this.buildPlace(type, x, y, rot).design);
  }

  /** Lays a bare platform tile, mirrored if symmetry is on. */
  placeTile(x: number, y: number): EditResult {
    if (!this.inGrid(x, y)) return { ok: false, reason: 'Outside the build area.' };
    const d = cloneDesign(this.design);
    const cells: [number, number][] = [[x, y]];
    const axis2 = this.axis2();
    if (this.symmetry && axis2 !== null && axis2 - 1 - x !== x) cells.push([axis2 - 1 - x, y]);
    let added = false;
    for (const [cx, cy] of cells) {
      if (this.hasTile(cx, cy)) continue;
      d.tiles.push([cx, cy]);
      added = true;
    }
    return added ? this.apply(d) : OK;
  }

  /**
   * One cell of a path drag. Belts are laid pointing rot, and an existing belt
   * is re-pointed. Pipes and tiles are laid where missing.
   */
  pathCell(type: string, x: number, y: number, rot: Rot): EditResult {
    const i = this.partAt(x, y);
    if (i >= 0 && this.def(type).kind === 'tile') return OK;
    if (i >= 0) {
      const p = this.design.parts[i];
      if (p.type !== type) return { ok: false, reason: `There is a ${this.def(p.type).name.toLowerCase()} here.` };
      if (this.def(type).kind !== 'belt' || p.rot === rot) return OK;
      return this.setRotation(i, rot);
    }
    return this.place(type, x, y, this.def(type).kind === 'belt' ? rot : 0);
  }

  /** Turns a part to a given rotation in place, and its mirror partner to match. */
  setRotation(i: number, rot: Rot): EditResult {
    const j = this.partnerOf(i);
    const d = cloneDesign(this.design);
    d.parts[i].rot = rot;
    if (j >= 0) d.parts[j].rot = mirrorRot(rot);
    return this.apply(d);
  }

  /**
   * Rotates the part on a cell 90° clockwise. A part that changes shape keeps
   * its top-left corner if it fits there, otherwise turns about its centre.
   */
  rotateAt(x: number, y: number): EditResult {
    const i = this.partAt(x, y);
    if (i < 0) return { ok: false, reason: 'Nothing to rotate here.' };
    const p = this.design.parts[i];
    if (this.def(p.type).kind === 'core') return { ok: false, reason: 'The core does not turn.' };
    const rot = nextRot(p.rot);
    const f = this.footprint(p);
    const def = this.def(p.type);
    const nw = rotW(def, rot);
    const nh = rotH(def, rot);
    const anchors: [number, number][] = [
      [p.x, p.y],
      [p.x + Math.floor((f.w - nw) / 2), p.y + Math.floor((f.h - nh) / 2)],
      [p.x + Math.ceil((f.w - nw) / 2), p.y + Math.ceil((f.h - nh) / 2)],
    ];
    let last: EditResult = OK;
    for (const [ax, ay] of anchors) {
      last = this.moveTo(i, ax, ay, rot);
      if (last.ok) return last;
    }
    return last;
  }

  private buildMove(i: number, x: number, y: number, rot?: Rot): Preview & { design: Design } {
    const j = this.partnerOf(i);
    const d = cloneDesign(this.design);
    const moved: PartInstance = { ...d.parts[i], x, y, rot: rot ?? d.parts[i].rot };
    d.parts[i] = moved;
    const parts = [moved];
    const axis2 = this.axis2();
    if (j >= 0 && axis2 !== null) {
      const m = this.mirrorOf(moved, axis2);
      const a = this.footprint(moved);
      const b = this.footprint(m);
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      if (!overlap) {
        d.parts[j] = { ...d.parts[j], x: m.x, y: m.y, rot: m.rot };
        parts.push(d.parts[j]);
      }
    }
    const tiles: [number, number][] = [];
    for (const q of parts) tiles.push(...this.addPart(d, q, false));
    return { design: d, parts, tiles, reason: null };
  }

  /** What moving part i would do, without doing it: for the ghost while carrying a part. */
  previewMove(i: number, x: number, y: number, rot?: Rot): Preview {
    const b = this.buildMove(i, x, y, rot);
    return { parts: b.parts, tiles: b.tiles, reason: this.check(b.design) };
  }

  /**
   * Moves (and optionally turns) part i so its top-left is at (x,y). It keeps
   * its place in the part order. Its mirror partner moves the mirrored way.
   */
  moveTo(i: number, x: number, y: number, rot?: Rot): EditResult {
    return this.apply(this.buildMove(i, x, y, rot).design);
  }

  /**
   * Erases what is on a cell: the part if there is one, else the bare tile.
   * layer limits a drag to one or the other, so dragging across a machine
   * does not also take the floor out from under it. Returns what was erased.
   */
  erase(x: number, y: number, layer: 'part' | 'tile' | 'any' = 'any'): EditResult & { erased?: 'part' | 'tile' } {
    const i = this.partAt(x, y);
    if (i >= 0) {
      if (layer === 'tile') return { ok: false };
      const j = this.partnerOf(i);
      const d = cloneDesign(this.design);
      d.parts = d.parts.filter((_, k) => k !== i && k !== j);
      this.setDesign(d);
      return { ok: true, erased: 'part' };
    }
    if (!this.hasTile(x, y) || layer === 'part') return { ok: false };
    const cells = new Set([y * MAX_GRID + x]);
    const axis2 = this.axis2();
    const mx = axis2 === null ? x : axis2 - 1 - x;
    if (this.symmetry && axis2 !== null && this.hasTile(mx, y) && this.partAt(mx, y) < 0) cells.add(y * MAX_GRID + mx);
    const d = cloneDesign(this.design);
    d.tiles = d.tiles.filter(([tx, ty]) => !cells.has(ty * MAX_GRID + tx));
    const before = disconnected(validateDesign(this.content, this.design));
    const after = disconnected(validateDesign(this.content, d));
    if (after > before) return { ok: false, reason: `That would cut off ${after - before} tiles from the core.` };
    this.setDesign(d);
    return { ok: true, erased: 'tile' };
  }

  /** Removes everything. Refunds the lot. */
  clear(): void {
    this.setDesign({ name: this.design.name, tiles: [], parts: [] });
  }

  /** Changes a part's settings (recipe, filter, behaviors). Not mirrored. */
  configure(i: number, patch: Partial<Pick<PartInstance, 'recipe' | 'filter' | 'behaviors'>>): void {
    const d = cloneDesign(this.design);
    const p = { ...d.parts[i], ...patch };
    for (const key of ['recipe', 'filter'] as const) if (p[key] === undefined || p[key] === null) delete p[key];
    d.parts[i] = p;
    this.setDesign(d);
  }

  rename(name: string): void {
    this.design.name = name;
    this.version++;
  }
}
