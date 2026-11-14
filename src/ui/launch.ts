// Launch setup (spec section 12): the lane summary, the size and launch check,
// the launch allowance, and the flight computer's behavior slots. Behaviors
// are part of the design, so changing them clears certification like any edit.

import { content } from '../data';
import { isCurrent, readiness, updateDesign } from '../game';
import { checkLaunch, designBounds } from '../sim';
import type { BehaviorConfig, Design } from '../sim';
import type { App } from './app';
import { fill, h, type Screen } from './dom';
import { duration, itemName } from './format';

export class LaunchScreen implements Screen {
  readonly el: HTMLElement;
  private readonly body = h('div', { class: 'scroll' });
  private readonly launchBtn: HTMLButtonElement;

  constructor(private readonly app: App, private readonly shipId: string, private readonly laneId = 'lane1') {
    this.launchBtn = h('button', { class: 'btn primary', on: { click: () => app.toRun(shipId, 'assisted') } }, 'Launch');
    this.el = h('div', { class: 'screen launch' },
      h('header', { class: 'bar' },
        h('button', { class: 'btn back', on: { click: () => app.toShipyard(shipId) } }, '‹ Shipyard'),
        h('h1', null, 'Launch setup')),
      this.body,
      h('nav', { class: 'bottom-actions' },
        h('button', { class: 'btn', on: { click: () => app.toHub() } }, 'Hub'),
        this.launchBtn));
    this.render();
  }

  private get design(): Design {
    return this.app.ship(this.shipId)!.design;
  }

  private render(): void {
    const lane = this.app.lane(this.laneId);
    const ship = this.app.ship(this.shipId)!;
    const d = ship.design;
    const b = designBounds(d);
    const problems = checkLaunch(content, d, lane);
    const fits = b.w <= lane.maxSize[0] && b.h <= lane.maxSize[1];
    this.launchBtn.disabled = problems.length > 0;
    const refTime = lane.length / lane.referenceSpeed;
    const bench = ship.benchmarks[lane.id];

    const fuelCap = d.parts.reduce((n, p) => n + (content.parts.find((x) => x.id === p.type)?.fuelCapacity ?? 0), 0);
    const allowance = Object.entries(lane.allowance).map(([id, n]) => {
      if (id === 'fuel') return `${n} fuel${fuelCap < n ? ` (tanks hold ${fuelCap})` : ''}`;
      return `${n} ${itemName(id).toLowerCase()}`;
    });

    fill(this.body,
      h('div', { class: 'card' },
        h('div', { class: 'head' }, h('h2', null, `Lane 1 · ${lane.name}`),
          h('span', { class: `tag ${this.app.save.lanes[lane.id]?.cleared ? 'ok' : ''}` }, this.app.save.lanes[lane.id]?.cleared ? 'Cleared' : 'Not cleared')),
        h('div', { class: 'info' }, h('dl', null,
          h('dt', null, 'Length'), h('dd', null, `${lane.length} u, ${lane.width} u wide`),
          h('dt', null, 'Hazards'), h('dd', null, 'Metal pebbles and rocks, thicker toward the end'),
          h('dt', null, 'Pace'), h('dd', null, `${lane.referenceSpeed} u/s takes ${duration(refTime)}; time limit ${duration(refTime * 3)}`),
          h('dt', null, 'Allowance'), h('dd', null, `${allowance.join(', ')}. Free; leftovers are not banked.`),
          h('dt', null, 'Assist'), h('dd', null, (lane.assist ?? []).map((a) => `${a.tool === 'deck_gun' ? 'Deck gun' : 'Patch'} (${a.cooldownSeconds} s)`).join(', ') || 'none'),
        ))),
      h('h3', null, 'Ship check'),
      h('div', { class: 'card' },
        h('div', { class: 'head' }, h('h2', null, d.name),
          h('span', { class: fits ? 'ok' : 'bad' }, `${b.w}×${b.h} of ${lane.maxSize[0]}×${lane.maxSize[1]}`)),
        problems.length
          ? h('ul', { class: 'list bad' }, problems.map((p) => h('li', null, p)))
          : h('div', { class: 'ok' }, '✓ Ready to launch'),
        isCurrent(bench, d) ? h('div', { class: 'sub' }, `Solo readiness ${Math.round(readiness(bench) * 100)}%`) : h('div', { class: 'sub' }, 'Not tested yet. A readiness check runs after the run.')),
      h('h3', null, 'Flight computer'),
      this.behaviorCard(),
    );
  }

  private behaviorCard(): HTMLElement {
    const d = this.design;
    const ci = d.parts.findIndex((p) => content.parts.find((x) => x.id === p.type)?.kind === 'computer');
    if (ci < 0) return h('div', { class: 'card bad' }, 'No flight computer: the ship will drift and fire no thrusters.');
    const comp = d.parts[ci];
    const def = content.parts.find((x) => x.id === comp.type)!;
    const slots = def.slots ?? 0;
    const behaviors = comp.behaviors ?? [];
    const unlocked = content.behaviors.filter((bd) => this.app.save.unlocks.behaviors.includes(bd.id));
    const rows: HTMLElement[] = [];
    for (let i = 0; i < slots; i++) {
      const cfg = behaviors[i];
      const bdef = cfg ? content.behaviors.find((x) => x.id === cfg.id) : undefined;
      const sel = h('select', {
        'aria-label': `Slot ${i + 1}`,
        on: { change: () => this.setSlot(ci, i, sel.value) },
      },
      h('option', { value: '' }, 'Empty'),
      unlocked.map((bd) => h('option', { value: bd.id, selected: cfg?.id === bd.id }, bd.name)));
      const params = bdef ? Object.entries(bdef.params).map(([name, spec]) => {
        const value = typeof cfg![name] === 'number' ? (cfg![name] as number) : spec.default;
        const out = h('b', { class: 'num' }, `${value} u/s`);
        const range = h('input', {
          type: 'range', min: spec.min, max: spec.max, step: 1, value,
          'aria-label': name,
          on: {
            input: () => { out.textContent = `${range.value} u/s`; },
            change: () => this.setParam(ci, i, name, Number(range.value)),
          },
        });
        return h('label', { class: 'field' }, h('span', null, name === 'cruise' ? 'Cruise' : name), range, out);
      }) : [];
      rows.push(h('div', { class: 'slot' },
        h('div', { class: 'slot-head' }, h('span', { class: 'muted' }, `Slot ${i + 1}`), sel,
          slots > 1 ? h('button', { class: 'icon', 'aria-label': 'Move up', disabled: i === 0 || !cfg, on: { click: () => this.swap(ci, i, i - 1) } }, '↑') : null),
        params,
        bdef ? h('div', { class: 'muted small' }, this.describe(bdef.id)) : null));
    }
    return h('div', { class: 'card' },
      h('div', { class: 'sub' }, `${def.name}: ${slots} ${slots === 1 ? 'slot' : 'slots'}. The first active behavior in the list wins each channel.`),
      rows,
      h('div', { class: 'muted small' }, 'Changing behaviors changes the design, so the ship needs re-testing to stay certified.'));
  }

  private describe(id: string): string {
    if (id === 'drive_forward') return 'Holds the cruise speed down the lane. Faster meets more rock per minute and hits it harder.';
    if (id === 'center_in_lane') return 'Steers back toward the middle when the ship drifts a quarter of the way out.';
    return '';
  }

  private edit(ci: number, fn: (list: BehaviorConfig[]) => BehaviorConfig[]): void {
    const d = structuredClone(this.design);
    d.parts[ci].behaviors = fn(d.parts[ci].behaviors ?? []);
    updateDesign(this.app.save, this.shipId, d);
    void this.app.persist();
    this.render();
  }

  private setSlot(ci: number, i: number, id: string): void {
    this.edit(ci, (list) => {
      const next = list.slice();
      if (!id) {
        next.splice(i, 1);
        return next;
      }
      const bd = content.behaviors.find((x) => x.id === id)!;
      const cfg: BehaviorConfig = { id };
      for (const [name, spec] of Object.entries(bd.params)) cfg[name] = spec.default;
      if (i < next.length) next[i] = cfg;
      else next.push(cfg);
      return next;
    });
  }

  private setParam(ci: number, i: number, name: string, value: number): void {
    this.edit(ci, (list) => list.map((b, k) => (k === i ? { ...b, [name]: value } : b)));
  }

  private swap(ci: number, a: number, b: number): void {
    this.edit(ci, (list) => {
      const next = list.slice();
      [next[a], next[b]] = [next[b], next[a]];
      return next.filter(Boolean);
    });
  }
}

