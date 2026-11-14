// The shipyard (spec section 12). One finger acts with the selected tool; two
// fingers pan and zoom. Long-press a part with any tool but Erase to carry it.
// Readouts update on every edit. Each finished gesture is one undo step, and
// is written to the save at once: costs are paid and refunds made as you go.

import { content } from '../data';
import {
  DesignEditor, isCertified, readiness, reportLines, shipStats, updateDesign,
  type Preview, type ShipStats,
} from '../game';
import { ShipyardRenderer, type YardView } from '../render/shipyardRenderer';
import { KIND_COLOR } from '../render/partStyle';
import { rotH, rotW } from '../sim';
import type { PartDef, Rot } from '../sim';
import type { App } from './app';
import { fill, h, sheet, toast, type Screen } from './dom';
import { fmt, itemName, money } from './format';

type Tool = 'build' | 'rotate' | 'erase' | 'info';

/** Parts laid by dragging a path rather than placed one at a time. */
const PATH_KINDS = new Set(['tile', 'belt', 'pipe']);
/** Palette order: roughly the order a ship is built in. */
const PALETTE_ORDER = [
  'core', 'platform_tile', 'thruster', 'fuel_tank', 'fuel_pipe', 'computer_mk1', 'autocannon', 'fabricator',
  'smelter', 'crusher', 'collector', 'inserter', 'belt', 'storage',
];
const SHORT_NAME: Record<string, string> = {
  platform_tile: 'Tile', fuel_tank: 'Tank', fuel_pipe: 'Pipe', computer_mk1: 'Computer', autocannon: 'Gun',
};
const ARROW: Record<Rot, string> = { 0: '↑', 90: '→', 180: '↓', 270: '←' };
const LONG_PRESS_MS = 420;
const DRAG_PX = 9;

interface Gesture {
  id: number;
  sx: number;
  sy: number;
  cell: [number, number];
  moved: boolean;
  timer: number;
  kind: 'place' | 'path' | 'erase' | 'tap' | 'move';
  started: boolean;
  last: [number, number];
  layer: 'part' | 'tile' | 'any';
  moveIndex: number;
  grab: [number, number];
  preview: Preview | null;
  target: [number, number];
}

export class ShipyardScreen implements Screen {
  readonly el: HTMLElement;
  private readonly editor: DesignEditor;
  private readonly renderer: ShipyardRenderer;
  private readonly canvas: HTMLCanvasElement;
  private tool: Tool = 'build';
  private part: string;
  private rot: Rot = 0;
  private readonly view: YardView;
  private stats: ShipStats | null = null;
  private statsVersion = -1;
  private committedCost: Record<string, number>;
  private gesture: Gesture | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch: { d0: number; scale0: number; gx: number; gy: number } | null = null;
  private raf = 0;
  private readonly resizeObserver: ResizeObserver;

  // Elements updated in place.
  private readonly readout = h('div', { class: 'readout' });
  private readonly hint = h('div', { class: 'hint' });
  private readonly palette = h('div', { class: 'palette', role: 'listbox', 'aria-label': 'Parts' });
  private readonly toolButtons: Record<string, HTMLButtonElement> = {};
  private readonly title = h('button', { class: 'title' });
  private readonly testBtn: HTMLButtonElement;

  constructor(private readonly app: App, private readonly shipId: string) {
    const ship = app.ship(shipId)!;
    this.committedCost = shipStats(content, ship.design).cost;
    this.editor = new DesignEditor(content, ship.design, () => {
      // What this ship may cost: the stockpile plus what it is already worth.
      const out: Record<string, number> = { ...this.app.save.stockpile };
      for (const [id, n] of Object.entries(this.committedCost)) out[id] = (out[id] ?? 0) + n;
      return out;
    });
    this.part = this.editor.coreIndex() < 0 ? 'core' : 'platform_tile';
    const lane = app.lane();
    this.view = { ghost: null, lifted: -1, selected: -1, laneMax: lane.maxSize, stats: null };

    this.canvas = h('canvas', { class: 'yard-canvas', 'aria-label': 'Ship design grid' });
    this.renderer = new ShipyardRenderer(this.canvas, content);

    const tool = (id: Tool | 'sym', label: string, icon: string, onClick: () => void) => {
      const b = h('button', { class: 'tool', 'aria-pressed': 'false', on: { click: onClick } },
        h('span', { class: 'ico', 'aria-hidden': 'true' }, icon), h('span', null, label));
      this.toolButtons[id] = b;
      return b;
    };
    const undoBtn = h('button', { class: 'tool', 'aria-label': 'Undo', on: { click: () => this.history('undo') } },
      h('span', { class: 'ico' }, '↶'), h('span', null, 'Undo'));
    const redoBtn = h('button', { class: 'tool', 'aria-label': 'Redo', on: { click: () => this.history('redo') } },
      h('span', { class: 'ico' }, '↷'), h('span', null, 'Redo'));
    this.toolButtons.undo = undoBtn;
    this.toolButtons.redo = redoBtn;

    this.testBtn = h('button', { class: 'btn', on: { click: () => this.openTest() } }, 'Test');
    this.el = h('div', { class: 'screen yard' },
      h('header', { class: 'bar' },
        h('button', { class: 'btn back', on: { click: () => this.leave() } }, '‹ Hub'),
        this.title,
        this.testBtn,
        h('button', { class: 'btn primary', on: { click: () => this.launch() } }, 'Launch'),
      ),
      this.readout,
      h('div', { class: 'yard-main' }, this.canvas, this.hint),
      this.palette,
      h('nav', { class: 'tools' },
        tool('build', 'Build', '✚', () => this.setTool('build')),
        tool('rotate', 'Rotate', '⟳', () => this.setTool('rotate')),
        tool('erase', 'Erase', '⌫', () => this.setTool('erase')),
        tool('info', 'Info', 'ⓘ', () => this.setTool('info')),
        tool('sym', 'Mirror', '⇋', () => this.toggleSymmetry()),
        undoBtn, redoBtn,
        h('button', { class: 'tool', 'aria-label': 'More', on: { click: () => this.openMore() } },
          h('span', { class: 'ico' }, '⋯'), h('span', null, 'More')),
      ),
    );
    this.title.addEventListener('click', () => this.rename());

    this.bindPointer();
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.buildPalette();
    this.setTool('build');
    this.refresh();
  }

  mounted(): void {
    this.resizeObserver.observe(this.canvas);
    this.onResize(true);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.raf);
    this.app.changed.delete(this.onAppChange);
  }

  private readonly onAppChange = () => this.refresh();

  private onResize(frame = false): void {
    const firstTime = this.renderer.w === 0;
    this.renderer.resize();
    if (frame || firstTime) this.frameShip();
    this.redraw();
    if (firstTime) this.app.changed.add(this.onAppChange);
  }

  /** Fits the lane's size limit around the ship (or the middle of the grid). */
  private frameShip(): void {
    const s = this.currentStats();
    const [mw, mh] = this.view.laneMax;
    if (s.width > 0) {
      const w = Math.max(mw, s.width);
      const hgt = Math.max(mh, s.height);
      this.renderer.frame(s.minX + s.width / 2 - w / 2, s.minY, w, hgt);
    } else {
      this.renderer.frame(32 - mw / 2, 32 - mh / 2, mw, mh);
    }
  }

  // ---- State ---------------------------------------------------------------

  private currentStats(): ShipStats {
    if (this.statsVersion !== this.editor.version || !this.stats) {
      this.stats = shipStats(content, this.editor.design);
      this.statsVersion = this.editor.version;
    }
    return this.stats;
  }

  /** Writes a finished edit to the save: the design, and the cost difference to the stockpile. */
  private sync(): void {
    const cost = this.editor.cost();
    const stock = this.app.save.stockpile;
    const ids = new Set([...Object.keys(cost), ...Object.keys(this.committedCost)]);
    for (const id of ids) stock[id] = (stock[id] ?? 0) - ((cost[id] ?? 0) - (this.committedCost[id] ?? 0));
    this.committedCost = cost;
    const wasFarming = !!this.app.ship(this.shipId)?.farming;
    updateDesign(this.app.save, this.shipId, this.editor.normalized());
    if (wasFarming && !this.app.ship(this.shipId)?.farming) toast('Design changed: farming stopped until it is re-tested.');
    this.app.persistSoon();
  }

  private refresh(): void {
    this.renderReadout();
    this.renderPaletteState();
    this.toolButtons.undo.disabled = !this.editor.canUndo;
    this.toolButtons.redo.disabled = !this.editor.canRedo;
    this.toolButtons.sym.setAttribute('aria-pressed', String(this.editor.symmetry));
    this.title.textContent = this.editor.design.name || 'Unnamed ship';
    this.redraw();
  }

  private redraw(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.view.stats = this.currentStats();
      this.renderer.draw(this.editor, this.view);
    });
  }

  // ---- Readouts ------------------------------------------------------------

  private renderReadout(): void {
    const s = this.currentStats();
    const lane = this.app.lane();
    const [mw, mh] = lane.maxSize;
    const fits = s.width <= mw && s.height <= mh;
    const left = this.editor.remaining() ?? {};
    const problems = this.editor.problems();
    const m = s.mass || 1;
    const acc = (f: number) => (s.mass ? fmt(f / m, 2) : '0');
    const deg = (t: number) => (s.inertia ? fmt(((t / s.inertia) * 180) / Math.PI, 0) : '0');
    const cell = (label: string, force: number, accel: string, unit: string) =>
      h('div', { class: force > 0 ? 'cell' : 'cell zero' },
        h('span', { class: 'k' }, label), h('b', null, fmt(force, 0)), h('span', { class: 'u' }, `${accel} ${unit}`));

    fill(this.readout,
      h('div', { class: 'row' },
        h('span', { class: fits ? 'ok' : 'bad' }, `Size ${s.width}×${s.height}`, h('small', null, ` / ${mw}×${mh}`)),
        h('span', null, `Mass ${fmt(s.mass, 0)}`),
        h('span', { class: (left.iron_plate ?? 0) < 0 ? 'bad' : '' }, `Cost ${money(s.cost)}`),
        h('span', { class: 'muted' }, `Left ${money(left, true)}`),
      ),
      h('div', { class: 'thrust' },
        cell('Fwd', s.thrust.forward, acc(s.thrust.forward), 'u/s²'),
        cell('Back', s.thrust.back, acc(s.thrust.back), 'u/s²'),
        cell('Left', s.thrust.left, acc(s.thrust.left), 'u/s²'),
        cell('Right', s.thrust.right, acc(s.thrust.right), 'u/s²'),
        cell('Turn ⟳', s.torque.cw, deg(s.torque.cw), '°/s²'),
        cell('Turn ⟲', s.torque.ccw, deg(s.torque.ccw), '°/s²'),
      ),
      problems.length || !fits
        ? h('button', { class: 'problems', on: { click: () => this.showProblems() } },
          `⚠ ${problems.length + (fits ? 0 : 1)} ${problems.length + (fits ? 0 : 1) === 1 ? 'problem blocks' : 'problems block'} launch`)
        : h('div', { class: 'problems ok' }, `✓ Ready to launch on ${lane.name}`),
    );
  }

  private showProblems(): void {
    const lane = this.app.lane();
    const s = this.currentStats();
    const list = this.editor.problems().map((p) => p.replace(/^Part \d+ \(([a-z_0-9]+)\)/, (_, t) => this.editor.def(t).name));
    if (s.width > lane.maxSize[0] || s.height > lane.maxSize[1]) {
      list.unshift(`Ship is ${s.width}×${s.height}; ${lane.name} allows ${lane.maxSize[0]}×${lane.maxSize[1]}.`);
    }
    sheet('Problems', h('ul', { class: 'list' }, list.map((p) => h('li', null, p))));
  }

  // ---- Palette and tools ---------------------------------------------------

  private paletteParts(): PartDef[] {
    const unlocked = new Set(this.app.save.unlocks.parts);
    const defs = content.parts.filter((p) => unlocked.has(p.id));
    const rank = (id: string) => {
      const i = PALETTE_ORDER.indexOf(id);
      return i < 0 ? 100 : i;
    };
    return defs.sort((a, b) => rank(a.id) - rank(b.id));
  }

  private buildPalette(): void {
    fill(this.palette, this.paletteParts().map((def) => {
      const w = def.w;
      const hh = def.h;
      const swatch = h('span', { class: 'swatch', style: `width:${w * 10}px;height:${hh * 10}px;background:${KIND_COLOR[def.kind]}` });
      const cost = Object.values(def.cost)[0] ?? 0;
      return h('button', {
        class: 'chip', role: 'option', 'data-part': def.id, 'aria-selected': 'false',
        on: { click: () => this.pick(def.id) },
      },
      h('span', { class: 'swatch-box' }, swatch),
      h('span', { class: 'name' }, SHORT_NAME[def.id] ?? def.name),
      h('span', { class: 'price' }, cost ? `${cost}` : 'free'),
      h('span', { class: 'rot', 'aria-hidden': 'true' }));
    }));
  }

  private renderPaletteState(): void {
    const left = this.editor.remaining() ?? {};
    const hasCore = this.editor.coreIndex() >= 0;
    for (const chip of Array.from(this.palette.children) as HTMLElement[]) {
      const id = chip.dataset.part!;
      const def = this.editor.def(id);
      const selected = id === this.part && this.tool === 'build';
      chip.setAttribute('aria-selected', String(selected));
      const short = Object.entries(def.cost).some(([m, n]) => (left[m] ?? 0) < n);
      chip.classList.toggle('short', short);
      chip.classList.toggle('done', def.kind === 'core' && hasCore);
      const rotEl = chip.querySelector('.rot')!;
      rotEl.textContent = selected && def.kind !== 'core' && def.kind !== 'tile' && def.kind !== 'pipe' ? ARROW[this.rot] : '';
    }
  }

  /** Picks a part. Picking the selected part again turns it 90°. */
  private pick(id: string): void {
    const turns = !['core', 'tile', 'pipe'].includes(this.editor.def(id).kind);
    if (this.tool === 'build' && this.part === id) {
      if (turns) this.rot = ((this.rot + 90) % 360) as Rot;
    } else {
      this.part = id;
      // Thrusters usually face back, so a new pick starts that way.
      this.rot = this.editor.def(id).kind === 'thruster' ? 180 : 0;
    }
    this.setTool('build');
    const def = this.editor.def(id);
    if (!turns) this.rot = 0;
    if (PATH_KINDS.has(def.kind)) this.showHint(`${def.name}: drag to lay a line${def.kind === 'belt' ? ', it follows your finger' : ''}.`);
    else this.showHint(`${def.name} ${ARROW[this.rot]}: tap the grid to place. Tap the chip again to turn it.`);
  }

  private setTool(t: Tool): void {
    this.tool = t;
    for (const id of ['build', 'rotate', 'erase', 'info']) {
      this.toolButtons[id].setAttribute('aria-pressed', String(id === t));
    }
    this.palette.classList.toggle('dim', t !== 'build');
    if (t === 'rotate') this.showHint('Tap a part to turn it 90°.');
    if (t === 'erase') this.showHint('Tap or drag to erase. Parts first, then bare tiles. Refunds in full.');
    if (t === 'info') this.showHint('Tap a part to see it and set its recipe or filter.');
    this.refresh();
  }

  private toggleSymmetry(): void {
    if (this.editor.axis2() === null) {
      toast('Place the core first: mirroring works across its centre line.');
      return;
    }
    this.editor.symmetry = !this.editor.symmetry;
    this.showHint(this.editor.symmetry ? 'Mirror on: placing and erasing are copied across the core.' : 'Mirror off.');
    this.refresh();
  }

  private history(which: 'undo' | 'redo'): void {
    if (which === 'undo' ? this.editor.undo() : this.editor.redo()) {
      this.view.selected = -1;
      this.sync();
      this.refresh();
    }
  }

  private hintTimer = 0;
  private showHint(text: string, bad = false): void {
    this.hint.textContent = text;
    this.hint.className = bad ? 'hint show bad' : 'hint show';
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => { this.hint.className = 'hint'; }, bad ? 2600 : 2200);
  }

  // ---- Pointer input -------------------------------------------------------

  private bindPointer(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e, false));
    c.addEventListener('pointercancel', (e) => this.up(e, true));
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.renderer.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
      this.redraw();
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private local(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private cellAt(px: number, py: number): [number, number] {
    const [gx, gy] = this.renderer.toGrid(px, py);
    return [Math.floor(gx), Math.floor(gy)];
  }

  private down(e: PointerEvent): void {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const [px, py] = this.local(e);
    this.pointers.set(e.pointerId, { x: px, y: py });
    if (this.pointers.size === 2) {
      this.abortGesture();
      this.startPinch();
      return;
    }
    if (this.pointers.size > 2 || this.gesture) return;

    const cell = this.cellAt(px, py);
    const g: Gesture = {
      id: e.pointerId, sx: px, sy: py, cell, moved: false, timer: 0, kind: 'tap', started: false,
      last: cell, layer: 'any', moveIndex: -1, grab: [0, 0], preview: null, target: cell,
    };
    this.gesture = g;
    const def = this.editor.def(this.part);
    if (this.tool === 'build') g.kind = PATH_KINDS.has(def.kind) ? 'path' : 'place';
    else if (this.tool === 'erase') g.kind = 'erase';

    if (g.kind === 'erase') {
      this.editor.begin();
      this.eraseCell(g, cell);
    } else {
      g.timer = window.setTimeout(() => this.longPress(g), LONG_PRESS_MS);
      if (g.kind === 'place') this.updatePlaceGhost(g, cell);
    }
    this.refresh();
  }

  private move(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    const [px, py] = this.local(e);
    this.pointers.set(e.pointerId, { x: px, y: py });
    if (this.pinch) {
      this.updatePinch();
      return;
    }
    const g = this.gesture;
    if (!g || g.id !== e.pointerId) return;
    if (!g.moved && Math.hypot(px - g.sx, py - g.sy) > DRAG_PX) {
      g.moved = true;
      clearTimeout(g.timer);
    }
    const cell = this.cellAt(px, py);
    switch (g.kind) {
      case 'place':
        this.updatePlaceGhost(g, cell);
        break;
      case 'move':
        this.updateMoveGhost(g, cell);
        break;
      case 'path':
        if (!g.moved) return;
        if (!g.started) {
          g.started = true;
          this.editor.begin();
          this.pathAt(g.cell, this.rot);
        }
        this.walk(g, cell, (from, to, rot) => {
          // Direction follows the drag: the cell left behind points to the new one.
          if (this.editor.def(this.part).kind === 'belt') this.pathAt(from, rot, true);
          this.pathAt(to, rot);
        });
        break;
      case 'erase':
        this.walk(g, cell, (_from, to) => this.eraseCell(g, to));
        break;
      default:
        return;
    }
    this.refresh();
  }

  private up(e: PointerEvent, cancelled: boolean): void {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    const g = this.gesture;
    if (!g || g.id !== e.pointerId) return;
    clearTimeout(g.timer);
    this.gesture = null;
    this.view.ghost = null;
    if (cancelled) {
      this.editor.cancel();
      this.view.lifted = -1;
      this.refresh();
      return;
    }

    switch (g.kind) {
      case 'place': {
        const p = g.preview;
        if (p && !p.reason) {
          this.editor.begin();
          this.editor.place(this.part, g.target[0], g.target[1], this.rot);
          this.finish();
          if (this.editor.def(this.part).kind === 'core') this.pick('platform_tile');
        } else if (p?.reason) {
          this.showHint(p.reason, true);
        }
        break;
      }
      case 'path': {
        if (!g.started) {
          // A tap: lay one, or turn an existing belt.
          this.editor.begin();
          const i = this.editor.partAt(g.cell[0], g.cell[1]);
          const existing = i >= 0 ? this.editor.design.parts[i] : null;
          if (existing && existing.type === this.part && this.editor.def(this.part).kind === 'belt') {
            this.editor.setRotation(i, ((existing.rot + 90) % 360) as Rot);
          } else {
            this.pathAt(g.cell, this.rot);
          }
        }
        this.finish();
        break;
      }
      case 'erase':
        this.finish();
        break;
      case 'move': {
        const p = g.preview;
        this.view.lifted = -1;
        if (p && !p.reason) {
          this.editor.begin();
          this.editor.moveTo(g.moveIndex, g.target[0], g.target[1]);
          this.finish();
        } else if (p?.reason) {
          this.showHint(p.reason, true);
        }
        break;
      }
      case 'tap':
        if (!g.moved) this.tap(g.cell);
        break;
    }
    this.refresh();
  }

  /** Ends an edit gesture: records the undo step and writes it to the save. */
  private finish(): void {
    if (this.editor.commit()) this.sync();
  }

  private abortGesture(): void {
    const g = this.gesture;
    if (!g) return;
    clearTimeout(g.timer);
    this.gesture = null;
    this.editor.cancel();
    this.view.ghost = null;
    this.view.lifted = -1;
    this.refresh();
  }

  private longPress(g: Gesture): void {
    if (this.gesture !== g || g.moved) return;
    const i = this.editor.partAt(g.cell[0], g.cell[1]);
    if (i < 0) return;
    const p = this.editor.design.parts[i];
    g.kind = 'move';
    g.moveIndex = i;
    g.grab = [g.cell[0] - p.x, g.cell[1] - p.y];
    this.view.lifted = i;
    navigator.vibrate?.(12);
    this.showHint(`Moving the ${this.editor.def(p.type).name.toLowerCase()}. Drag and let go.`);
    this.updateMoveGhost(g, g.cell);
    this.refresh();
  }

  /** Steps one cell at a time from the last cell to this one, so fast drags leave no gaps. */
  private walk(g: Gesture, to: [number, number], visit: (from: [number, number], to: [number, number], rot: Rot) => void): void {
    let [x, y] = g.last;
    let guard = 0;
    while ((x !== to[0] || y !== to[1]) && guard++ < 200) {
      const dx = to[0] - x;
      const dy = to[1] - y;
      const from: [number, number] = [x, y];
      let rot: Rot;
      if (Math.abs(dx) >= Math.abs(dy)) {
        x += Math.sign(dx);
        rot = dx > 0 ? 90 : 270;
      } else {
        y += Math.sign(dy);
        rot = dy > 0 ? 180 : 0;
      }
      visit(from, [x, y], rot);
    }
    g.last = [x, y];
  }

  /** Lays the selected path part on a cell. repoint only turns a belt already there. */
  private pathAt(cell: [number, number], rot: Rot, repoint = false): void {
    if (repoint) {
      const i = this.editor.partAt(cell[0], cell[1]);
      if (i >= 0 && this.editor.design.parts[i].type === this.part) this.editor.setRotation(i, rot);
      return;
    }
    const r = this.editor.pathCell(this.part, cell[0], cell[1], rot);
    if (!r.ok && r.reason) this.showHint(r.reason, true);
  }

  private eraseCell(g: Gesture, cell: [number, number]): void {
    const r = this.editor.erase(cell[0], cell[1], g.layer);
    // The first thing erased decides whether this drag takes parts or tiles.
    if (r.erased && g.layer === 'any') g.layer = r.erased;
    if (!r.ok && r.reason) this.showHint(r.reason, true);
  }

  private tap(cell: [number, number]): void {
    if (this.tool === 'rotate') {
      this.editor.begin();
      const r = this.editor.rotateAt(cell[0], cell[1]);
      if (!r.ok && r.reason) this.showHint(r.reason, true);
      this.finish();
    } else if (this.tool === 'info') {
      const i = this.editor.partAt(cell[0], cell[1]);
      if (i >= 0) this.openInfo(i);
    }
  }

  /** The top-left cell that centres a footprint on the finger. */
  private anchor(type: string, rot: Rot, cell: [number, number]): [number, number] {
    const def = this.editor.def(type);
    return [cell[0] - Math.floor((rotW(def, rot) - 1) / 2), cell[1] - Math.floor((rotH(def, rot) - 1) / 2)];
  }

  private updatePlaceGhost(g: Gesture, cell: [number, number]): void {
    const [x, y] = this.anchor(this.part, this.rot, cell);
    if (g.preview && g.target[0] === x && g.target[1] === y) return;
    g.target = [x, y];
    g.preview = this.editor.preview(this.part, x, y, this.rot);
    this.showGhost(g.preview, this.part);
  }

  private updateMoveGhost(g: Gesture, cell: [number, number]): void {
    const x = cell[0] - g.grab[0];
    const y = cell[1] - g.grab[1];
    if (g.preview && g.target[0] === x && g.target[1] === y) return;
    g.target = [x, y];
    g.preview = this.editor.previewMove(g.moveIndex, x, y);
    this.showGhost(g.preview, this.editor.design.parts[g.moveIndex].type, true);
  }

  private showGhost(p: Preview, type: string, moving = false): void {
    this.view.ghost = { parts: p.parts, tiles: p.tiles, valid: !p.reason };
    const def = this.editor.def(type);
    if (p.reason) {
      this.showHint(p.reason, true);
    } else {
      const tileCost = p.tiles.length * (this.editor.def('platform_tile').cost.iron_plate ?? 0);
      const each = moving ? 0 : (def.cost.iron_plate ?? 0) * p.parts.length;
      const parts = p.parts.length > 1 ? `${p.parts.length}× ${def.name}` : def.name;
      const tiles = p.tiles.length ? ` + ${p.tiles.length} tiles ${tileCost} P` : '';
      this.showHint(moving ? `${def.name}${tiles}` : `${parts} ${each} P${tiles}`);
    }
  }

  private startPinch(): void {
    const [a, b] = Array.from(this.pointers.values());
    const d0 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const [gx, gy] = this.renderer.toGrid((a.x + b.x) / 2, (a.y + b.y) / 2);
    this.pinch = { d0, scale0: this.renderer.scale, gx, gy };
  }

  private updatePinch(): void {
    const p = this.pinch!;
    const [a, b] = Array.from(this.pointers.values());
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const r = this.renderer;
    r.scale = Math.max(8, Math.min(96, p.scale0 * (d / p.d0)));
    // Keep the grid point that started under the fingers under them.
    r.ox = (a.x + b.x) / 2 - p.gx * r.scale;
    r.oy = (a.y + b.y) / 2 - p.gy * r.scale;
    this.redraw();
  }

  // ---- Sheets --------------------------------------------------------------

  private openInfo(i: number): void {
    const ed = this.editor;
    const p = ed.design.parts[i];
    const def = ed.def(p.type);
    this.view.selected = i;
    this.redraw();
    const rows: [string, string][] = [
      ['Size', `${def.w}×${def.h}`], ['Mass', fmt(def.mass, 1)], ['HP', String(def.hp)],
      ['Cost', money(def.cost) || 'free'],
    ];
    if (def.thrust) rows.push(['Thrust', `${def.thrust}, burns ${def.burn} fuel/s`]);
    if (def.fuelCapacity) rows.push(['Holds', `${def.fuelCapacity} fuel`]);
    if (def.itemCapacity) rows.push(['Holds', `${def.itemCapacity} items`]);
    const turret = content.turretRules.turrets.find((t) => t.part === def.id);
    if (turret) {
      rows.push(['Range', `${turret.range} u`],
        ['Fire', `${turret.damage} ${turret.damageType} × ${turret.shotsPerSecond}/s`], ['Ammo', itemName(turret.ammo)]);
    }
    if (def.kind === 'collector') rows.push(['Reach', `${content.constants.logistics.collectorRange} u`]);
    if (def.kind === 'computer') {
      rows.push(['Behaviors', (p.behaviors ?? []).map((b) => content.behaviors.find((d) => d.id === b.id)?.name ?? b.id).join(', ') || 'none'],
        ['', 'Set behaviors in launch setup.']);
    }

    const body = h('div', { class: 'info' },
      h('dl', null, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])));

    const recipes = this.recipesFor(def.id);
    if (def.kind === 'machine' && recipes.length > 1) {
      const sel = h('select', {
        on: {
          change: () => {
            ed.begin();
            ed.configure(i, { recipe: sel.value || undefined });
            this.finish();
            this.refresh();
          },
        },
      },
      h('option', { value: '' }, 'By input'),
      recipes.map((r) => h('option', { value: r.id, selected: p.recipe === r.id }, recipeLabel(r.id))));
      body.append(h('label', { class: 'field' }, h('span', null, 'Recipe'), sel));
    }
    if (def.kind === 'inserter') {
      const sel = h('select', {
        on: {
          change: () => {
            ed.begin();
            ed.configure(i, { filter: sel.value || null });
            this.finish();
            this.refresh();
          },
        },
      },
      h('option', { value: '' }, 'Anything'),
      this.availableItems().map((id) => h('option', { value: id, selected: p.filter === id }, itemName(id))));
      body.append(h('label', { class: 'field' }, h('span', null, 'Filter'), sel));
    }
    const close = sheet(def.name, h('div', null, body,
      h('div', { class: 'actions' },
        def.kind !== 'core' ? h('button', {
          class: 'btn', on: {
            click: () => {
              ed.begin();
              const r = ed.rotateAt(p.x, p.y);
              if (!r.ok && r.reason) toast(r.reason, 'bad');
              this.finish();
              close();
            },
          },
        }, '⟳ Rotate') : null,
        h('button', {
          class: 'btn danger', on: {
            click: () => {
              ed.begin();
              ed.erase(p.x, p.y, 'part');
              this.finish();
              close();
            },
          },
        }, `Erase (+${money(def.cost) || '0'})`),
      ),
      h('p', { class: 'muted small' }, 'Long-press a part on the grid to move it.'),
    ), () => {
      this.view.selected = -1;
      this.refresh();
    });
  }

  private recipesFor(partId: string) {
    const avail = new Set(this.availableItems());
    return content.recipes.filter((r) => r.machine === partId && Object.keys(r.inputs).every((id) => avail.has(id)));
  }

  /** Items a ship can get with the parts unlocked so far: lane chunks and what machines make from them. */
  private availableItems(): string[] {
    const unlocked = new Set(this.app.save.unlocks.parts);
    const have = new Set<string>(['metal_chunk']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of content.recipes) {
        if (!unlocked.has(r.machine) || !Object.keys(r.inputs).every((id) => have.has(id))) continue;
        for (const out of Object.keys(r.outputs)) {
          if (!have.has(out)) {
            have.add(out);
            grew = true;
          }
        }
      }
    }
    return content.items.filter((it) => have.has(it.id)).map((it) => it.id);
  }

  private openMore(): void {
    const close = sheet('Ship', h('div', { class: 'stack' },
      h('button', { class: 'btn', on: { click: () => { close(); this.rename(); } } }, 'Rename'),
      h('button', { class: 'btn', on: { click: () => { close(); this.frameShip(); this.redraw(); } } }, 'Re-centre view'),
      h('button', {
        class: 'btn danger', on: {
          click: () => {
            close();
            this.editor.begin();
            this.editor.clear();
            this.finish();
            this.editor.symmetry = false;
            this.pick('core');
            this.refresh();
            toast('Cleared. Everything was refunded; Undo brings it back.');
          },
        },
      }, 'Clear the grid (full refund)'),
      h('p', { class: 'muted small' },
        'One finger uses the selected tool. Two fingers pan and zoom. Long-press a part to move it. '
        + 'Tap a selected palette part again to turn it.'),
    ));
  }

  private rename(): void {
    const name = prompt('Ship name', this.editor.design.name);
    if (name === null || !name.trim()) return;
    this.editor.rename(name.trim().slice(0, 32));
    this.sync();
    this.refresh();
  }

  private openTest(): void {
    const problems = this.editor.problems();
    const s = this.currentStats();
    const lane = this.app.lane();
    if (problems.length || s.width > lane.maxSize[0] || s.height > lane.maxSize[1]) {
      this.showProblems();
      return;
    }
    const check = this.app.startCheck(this.shipId);
    const out = h('div', { class: 'report' });
    const render = () => {
      const b = check.benchmark;
      const ship = this.app.ship(this.shipId)!;
      if (!b) {
        fill(out, h('p', null, `Flying ${content.economy.readinessRuns} solo runs of ${lane.name}…`));
        return;
      }
      const pct = Math.round(readiness(b) * 100);
      fill(out,
        h('div', { class: 'big' }, h('b', { class: pct >= lane.readinessThreshold * 100 ? 'ok' : 'warn' }, `${pct}%`),
          ' solo readiness', check.done ? '' : h('small', null, `  ${b.runs} of ${content.economy.readinessRuns} runs`)),
        h('progress', { max: content.economy.readinessRuns, value: b.runs }),
        check.done ? h('ul', { class: 'list' }, reportLines(content, b).map((l) => h('li', null, l))) : null,
        check.done ? h('p', null, isCertified(content, b, ship.design, lane)
          ? `Certified for ${lane.name}. Assign it to farm from the hub.`
          : `Not certified: ${lane.name} needs ${Math.round(lane.readinessThreshold * 100)}%.`) : null,
      );
    };
    check.listeners.add(render);
    render();
    sheet(`Readiness on ${lane.name}`, out, () => check.listeners.delete(render));
  }

  private launch(): void {
    this.app.toLaunch(this.shipId);
  }

  private leave(): void {
    this.app.persistSoon();
    this.app.toHub();
  }
}

function recipeLabel(id: string): string {
  const r = content.recipes.find((x) => x.id === id)!;
  const ins = Object.entries(r.inputs).map(([k, n]) => `${n} ${itemName(k).toLowerCase()}`).join(' + ');
  const outs = Object.entries(r.outputs).map(([k, n]) => `${n} ${itemName(k).toLowerCase()}`).join(' + ');
  return `${outs || 'fuel'} from ${ins}`;
}

