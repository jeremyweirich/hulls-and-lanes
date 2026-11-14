// The run view (spec section 12): the ship in the lane, with pause, speed,
// assist tools and abort. The sim steps at a fixed tick on the main thread and
// the renderer interpolates. Player input enters only through sim.enqueue().
//
// A "watch" run replays a farming ship's solo run: no tools, nothing banked.

import { content } from '../data';
import { DebugRenderer, type Mark } from '../render/debugRenderer';
import { ASSIST_TOOLS, compile, shipItemCount, Sim, totalFuel } from '../sim';
import type { RunResult } from '../sim';
import type { App } from './app';
import { fill, h, type Screen } from './dom';
import { fmt, itemName } from './format';
import { partAtPoint, resolveTarget } from './targets';

export type RunMode = 'assisted' | 'watch';

export class RunScreen implements Screen {
  readonly el: HTMLElement;
  private readonly canvas = h('canvas', { class: 'run-canvas', 'aria-label': 'Lane view' });
  private readonly renderer: DebugRenderer;
  private readonly sim: Sim;
  private readonly cc = compile(content);
  private speed = 1;
  private paused = false;
  private acc = 0;
  private last = performance.now();
  private raf = 0;
  private ended = false;
  private endTimer = 0;
  private readonly marks: Mark[] = [];
  /** Tool armed by tapping its button, when the setting asks for a tool first. */
  private armed = -1;

  private readonly progress = h('i');
  private readonly topText = h('div', { class: 'run-top-text' });
  private readonly bottomText = h('div', { class: 'run-strip' });
  private readonly toolBar = h('div', { class: 'run-tools' });
  private readonly toolChips: { el: HTMLButtonElement; label: HTMLElement; bar: HTMLElement; name: string }[] = [];
  private readonly pauseBtn: HTMLButtonElement;
  private readonly speedBtns: HTMLButtonElement[] = [];
  private readonly panel = h('div', { class: 'run-panel', role: 'status' });

  constructor(
    private readonly app: App,
    private readonly shipId: string,
    private readonly mode: RunMode,
    readonly seed: number,
    private readonly laneId = 'lane1',
  ) {
    const ship = app.ship(shipId)!;
    const lane = app.lane(laneId);
    this.sim = new Sim(content, structuredClone(ship.design), lane, seed);
    this.renderer = new DebugRenderer(this.canvas);

    const tools = mode === 'assisted' ? lane.assist ?? [] : [];
    tools.forEach((a, i) => {
      const label = h('span');
      const bar = h('i');
      const el = h('button', { class: 'chip-tool', on: { click: () => this.arm(i) } }, label, bar);
      this.toolChips.push({ el, label, bar, name: ASSIST_TOOLS[a.tool].name });
      this.toolBar.append(el);
    });

    this.pauseBtn = h('button', { class: 'btn', 'aria-pressed': 'false', on: { click: () => this.togglePause() } }, 'Pause');
    for (const s of [1, 2, 4]) {
      this.speedBtns.push(h('button', { class: 'btn', 'aria-pressed': String(s === 1), on: { click: () => this.setSpeed(s) } }, `${s}×`));
    }
    this.el = h('div', { class: 'screen run' },
      h('div', { class: 'run-view' },
        this.canvas,
        h('div', { class: 'run-top' },
          h('div', { class: 'run-progress', role: 'progressbar', 'aria-label': 'Lane progress' }, this.progress),
          this.topText),
        this.panel),
      h('div', { class: 'run-bottom' },
        this.toolBar,
        this.bottomText,
        h('div', { class: 'run-controls' },
          this.pauseBtn, ...this.speedBtns,
          h('button', { class: 'btn danger', on: { click: () => this.abort() } }, mode === 'watch' ? 'Close' : 'Abort'))),
    );
    this.canvas.addEventListener('pointerdown', (e) => this.tap(e));
  }

  mounted(): void {
    this.renderer.resize();
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
    window.addEventListener('resize', this.onResize);
    this.resizeObserver.observe(this.canvas);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.endTimer);
    window.removeEventListener('resize', this.onResize);
    this.resizeObserver.disconnect();
  }

  private readonly onResize = () => this.renderer.resize();
  private readonly resizeObserver = new ResizeObserver(() => this.renderer.resize());

  private frame(now: number): void {
    const sim = this.sim;
    const elapsed = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    if (!this.paused && sim.outcome === 'running') {
      this.acc += elapsed * this.speed;
      while (this.acc >= sim.dt && sim.outcome === 'running') {
        sim.step();
        this.acc -= sim.dt;
      }
    }
    while (this.marks.length && this.marks[0].until < now) this.marks.shift();
    this.renderer.draw(sim, sim.outcome === 'running' && !this.paused ? this.acc / sim.dt : 1, this.marks);
    this.updateHud();
    if (sim.outcome !== 'running' && !this.ended) this.finish();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private updateHud(): void {
    const sim = this.sim;
    const s = sim.ship;
    const lane = sim.lane;
    this.progress.style.width = `${(sim.laneShare * 100).toFixed(1)}%`;
    const cap = s.defs.reduce((n, d) => n + (d.fuelCapacity ?? 0), 0);
    const fuel = totalFuel(s);
    fill(this.topText,
      h('span', null, `${fmt(sim.laneShare * 100)}% of ${lane.name}`),
      h('span', null, `${fmt(sim.forwardSpeed, 1)} u/s`),
      h('span', { class: cap && fuel / cap < 0.15 ? 'warn' : '' }, `Fuel ${fmt(fuel)}${cap ? `/${cap}` : ''}`),
      h('span', { class: 'muted' }, `${fmt(sim.tick / 30)} s`),
    );

    // Ammo by type, for every turret ammo the ship uses, and the active behavior.
    const ammo = new Set<string>();
    for (const p of s.turrets) {
      const t = this.cc.turrets[s.partDef[p]];
      if (t) ammo.add(content.items[t.ammo].id);
    }
    const slot = sim.autopilot.activeSlot();
    fill(this.bottomText,
      Array.from(ammo).map((id) => {
        const n = shipItemCount(s, this.cc.itemIndex[id]);
        return h('span', { class: n === 0 ? 'bad' : n < 20 ? 'warn' : '' }, `${itemName(id)} ${n}`);
      }),
      h('span', { class: 'muted' }, slot >= 0 ? sim.autopilot.slots[slot].def.name : 'No behavior'),
      s.partsLost ? h('span', { class: 'warn' }, `${s.partsLost} lost`) : null,
      this.mode === 'watch' ? h('span', { class: 'tag' }, 'Watching a farming run') : null,
    );

    const offered = sim.lane.assist ?? [];
    this.toolChips.forEach((c, i) => {
      const left = Math.max(0, sim.assistReady[i] - sim.tick) / 30;
      const ready = left === 0;
      c.el.classList.toggle('ready', ready);
      c.el.classList.toggle('armed', this.armed === i);
      c.label.textContent = ready ? c.name : `${c.name} ${left.toFixed(1)}s`;
      c.bar.style.width = `${100 * (1 - left / offered[i].cooldownSeconds)}%`;
    });
  }

  private toolFirst(): boolean {
    return this.app.save.settings.assistToolFirst === true;
  }

  private arm(i: number): void {
    if (!this.toolFirst()) {
      this.panel.textContent = `Tap ${this.toolChips[i].name === 'Patch' ? 'a damaged part' : 'an asteroid'} to use the ${this.toolChips[i].name.toLowerCase()}.`;
      this.panel.classList.add('open');
      setTimeout(() => this.panel.classList.remove('open'), 1500);
      return;
    }
    this.armed = this.armed === i ? -1 : i;
  }

  /**
   * A tap in the lane. By default it goes to the first ready tool that can use
   * what was tapped (an asteroid for the Deck gun, a damaged part for Patch).
   * With "choose a tool first" on, only the armed tool acts. While paused, a
   * tap on a part shows its state instead.
   */
  private tap(e: PointerEvent): void {
    const sim = this.sim;
    const r = this.canvas.getBoundingClientRect();
    const [wx, wy] = this.renderer.toWorld(e.clientX - r.left, e.clientY - r.top);
    if (this.paused) {
      this.inspect(partAtPoint(sim, wx, wy));
      return;
    }
    if (sim.outcome !== 'running' || this.mode !== 'assisted') return;
    const tools = sim.lane.assist ?? [];
    const until = performance.now() + 220;
    for (let i = 0; i < tools.length; i++) {
      if (this.toolFirst() && i !== this.armed) continue;
      const tool = ASSIST_TOOLS[tools[i].tool];
      const target = resolveTarget(sim, tool.targeting, wx, wy);
      if (!target) continue;
      if (sim.tick < sim.assistReady[i]) {
        this.marks.push({ kind: 'miss', x: wx, y: wy, until });
        return;
      }
      sim.enqueue({ tick: sim.tick, type: 'assist', tool: tool.id, target });
      this.marks.push({ kind: target.kind === 'part' ? 'ring' : 'shot', x: wx, y: wy, until });
      this.armed = -1;
      return;
    }
    this.marks.push({ kind: 'miss', x: wx, y: wy, until });
  }

  private inspect(p: number): void {
    const s = this.sim.ship;
    if (p < 0) {
      this.panel.classList.remove('open');
      return;
    }
    const def = s.defs[p];
    const items: string[] = [];
    for (let k = 0; k < s.nItems; k++) {
      const n = s.inv[p * s.nItems + k];
      if (n > 0) items.push(`${n} ${itemName(content.items[k].id).toLowerCase()}`);
    }
    if (def.kind === 'belt' && s.beltItem[p] >= 0) items.push(itemName(content.items[s.beltItem[p]].id).toLowerCase());
    const lines = [`${def.name}: ${fmt(s.partHp[p])}/${def.hp} HP`];
    if (def.fuelCapacity) lines.push(`Fuel ${fmt(s.partFuel[p])}/${def.fuelCapacity}`);
    if (def.kind === 'machine') {
      const r = s.partRecipe[p];
      lines.push(r >= 0 ? `Recipe: ${content.recipes[r].id.replace(/_/g, ' ')}` : 'Waiting for input');
      lines.push(s.partProgress[p] > 0 ? 'Working' : 'Idle');
    }
    lines.push(items.length ? `Holds ${items.join(', ')}` : 'Empty');
    this.panel.textContent = lines.join('\n');
    this.panel.classList.add('open');
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.pauseBtn.setAttribute('aria-pressed', String(this.paused));
    this.pauseBtn.textContent = this.paused ? 'Resume' : 'Pause';
    if (this.paused) {
      this.panel.textContent = 'Paused. Tap a part to see its state.';
      this.panel.classList.add('open');
    } else {
      this.panel.classList.remove('open');
    }
  }

  private setSpeed(s: number): void {
    this.speed = s;
    this.speedBtns.forEach((b, i) => b.setAttribute('aria-pressed', String([1, 2, 4][i] === s)));
  }

  private abort(): void {
    if (this.mode === 'watch') {
      this.app.toHub();
      return;
    }
    if (this.sim.outcome !== 'running') return;
    if (!confirm('Abort this run? Nothing is banked.')) return;
    this.sim.enqueue({ tick: this.sim.tick, type: 'abort' });
  }

  /** The run has ended: bank it (assisted only), then show the report. */
  private finish(): void {
    this.ended = true;
    const result: RunResult = this.sim.result();
    const firstClear = this.mode === 'assisted' ? this.app.recordRun(this.shipId, this.laneId, result) : false;
    this.endTimer = window.setTimeout(() => this.app.toReport(this.shipId, this.laneId, result, this.mode, firstClear), 1400);
  }
}
