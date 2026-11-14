// The hub (spec section 12): stockpile, the lane on offer, hangar slots and the
// ships in them. Assign a certified ship to farm, watch a farming run, copy or
// scrap a ship, and settings.

import { content } from '../data';
import {
  assignFarming, canAfford, designCost, incomePerHour, isCertified, readiness, stopFarming,
  type ShipRecord,
} from '../game';
import { designBounds } from '../sim';
import { App } from './app';
import { fill, h, sheet, toast, type Screen } from './dom';
import { money } from './format';

export class HubScreen implements Screen {
  readonly el: HTMLElement;
  private readonly body = h('div', { class: 'scroll' });

  constructor(private readonly app: App) {
    this.el = h('div', { class: 'screen hub' },
      h('header', { class: 'bar' }, h('h1', null, 'Hub 1'),
        h('button', { class: 'icon', 'aria-label': 'Settings', on: { click: () => this.settings() } }, '⚙')),
      this.body);
    this.render();
  }

  private readonly onChange = () => this.render();

  mounted(): void {
    this.app.changed.add(this.onChange);
  }

  dispose(): void {
    this.app.changed.delete(this.onChange);
  }

  render(): void {
    const save = this.app.save;
    const lane = this.app.lane();
    const cleared = !!save.lanes[lane.id]?.cleared;
    const farmer = save.ships.find((s) => s.farming?.laneId === lane.id);
    const income = farmer ? incomePerHour(content, farmer.benchmarks[lane.id]) : null;
    const scrollTop = this.body.scrollTop;

    fill(this.body,
      h('h3', null, 'Stockpile'),
      h('div', { class: 'stock' },
        ['iron_plate', 'carbon', 'alloy', 'scrap']
          .filter((id) => id === 'iron_plate' || (save.stockpile[id] ?? 0) > 0)
          .map((id) => h('div', { class: 'mat' }, h('b', null, Math.floor(save.stockpile[id] ?? 0)),
            h('span', null, content.items.find((it) => it.id === id)!.name)))),
      h('h3', null, 'Lanes'),
      h('div', { class: 'card' },
        h('div', { class: 'head' }, h('h2', null, `Lane 1 · ${lane.name}`),
          h('span', { class: `tag ${farmer ? 'gold' : cleared ? 'ok' : ''}` }, farmer ? 'Farmed' : cleared ? 'Cleared' : 'Open')),
        h('div', { class: 'sub' }, farmer && income
          ? `${farmer.design.name} brings in ${money(income) || 'nothing'} an hour.`
          : cleared ? 'Cleared. Assign a certified ship to farm it.'
            : `Clear it once to open farming. Ships up to ${lane.maxSize[0]}×${lane.maxSize[1]}.`)),
      h('h3', null, `Hangar · ${save.ships.length} of ${save.unlocks.hangarSlots} slots`),
      save.ships.map((ship) => this.shipCard(ship)),
      Array.from({ length: Math.max(0, save.unlocks.hangarSlots - save.ships.length) }, () =>
        h('button', { class: 'card empty btn wide', on: { click: () => this.newShip() } }, '+ New ship (empty grid)')),
    );
    this.body.scrollTop = scrollTop;
  }

  private shipCard(ship: ShipRecord): HTMLElement {
    const app = this.app;
    const lane = app.lane();
    const b = designBounds(ship.design);
    const { benchmark, check } = app.benchmarkFor(ship.id, lane.id);
    const certified = !!benchmark && isCertified(content, benchmark, ship.design, lane);
    const cleared = !!app.save.lanes[lane.id]?.cleared;
    const farming = ship.farming?.laneId === lane.id;
    let status: HTMLElement;
    if (farming) {
      const stale = !benchmark;
      status = h('span', { class: 'tag gold' }, stale ? 'Farming (old numbers)' : `Farming · ${money(incomePerHour(content, ship.benchmarks[lane.id]))}/h`);
    } else if (check) {
      status = h('span', { class: 'tag' }, `Testing ${check.benchmark?.runs ?? 0}/${content.economy.readinessRuns}`);
    } else if (benchmark) {
      status = h('span', { class: `tag ${certified ? 'ok' : 'warn'}` }, `${Math.round(readiness(benchmark) * 100)}% ${certified ? 'certified' : 'solo'}`);
    } else {
      status = h('span', { class: 'tag' }, 'Not tested');
    }

    const actions: HTMLElement[] = [
      h('button', { class: 'btn', on: { click: () => app.toShipyard(ship.id) } }, 'Shipyard'),
    ];
    if (farming) {
      actions.push(h('button', { class: 'btn', on: { click: () => app.toRun(ship.id, 'watch') } }, 'Watch'));
      actions.push(h('button', { class: 'btn', on: { click: () => this.stop(ship) } }, 'Stop'));
    } else {
      if (certified && cleared) actions.push(h('button', { class: 'btn primary', on: { click: () => this.farm(ship) } }, 'Farm'));
      actions.push(h('button', { class: `btn ${certified && cleared ? '' : 'primary'}`, on: { click: () => app.toLaunch(ship.id) } }, 'Launch'));
    }
    actions.push(h('button', { class: 'btn icon-btn', 'aria-label': `More for ${ship.design.name}`, on: { click: () => this.more(ship) } }, '⋯'));

    return h('div', { class: 'card' },
      h('div', { class: 'head' }, h('h2', null, ship.design.name || 'Unnamed ship'), status),
      h('div', { class: 'sub' }, `${b.w}×${b.h} · ${ship.design.parts.length} parts · worth ${money(designCost(content, ship.design), true)}`),
      h('div', { class: 'actions' }, actions));
  }

  private farm(ship: ShipRecord): void {
    const lane = this.app.lane();
    const save = this.app.save;
    const other = save.ships.find((s) => s.id !== ship.id && s.farming?.laneId === lane.id);
    if (other) stopFarming(save, other.id);
    const err = assignFarming(content, save, ship.id, lane, App.now());
    if (err) {
      toast(err, 'bad');
      return;
    }
    void this.app.persist();
    toast(`${ship.design.name} is farming ${lane.name}.${other ? ` ${other.design.name} stopped.` : ''}`);
    this.render();
  }

  private stop(ship: ShipRecord): void {
    this.app.accrue();
    stopFarming(this.app.save, ship.id);
    void this.app.persist();
    this.render();
  }

  private newShip(): void {
    const id = this.app.addShip({ name: `Ship ${this.app.save.ships.length + 1}`, tiles: [], parts: [] });
    this.app.toShipyard(id);
  }

  private more(ship: ShipRecord): void {
    const save = this.app.save;
    const cost = designCost(content, ship.design);
    const free = save.ships.length < save.unlocks.hangarSlots;
    const close = sheet(ship.design.name, h('div', { class: 'stack' },
      h('button', {
        class: 'btn', disabled: !free || !canAfford(save, cost),
        on: {
          click: () => {
            for (const [id, n] of Object.entries(cost)) save.stockpile[id] -= n;
            const copy = structuredClone(ship.design);
            copy.name = `${ship.design.name} copy`;
            this.app.addShip(copy);
            close();
            this.render();
          },
        },
      }, `Copy into a free slot (${money(cost, true)})`),
      !free ? h('div', { class: 'muted small' }, 'No free hangar slot.') : null,
      h('button', {
        class: 'btn danger',
        on: {
          click: () => {
            if (!confirm(`Scrap ${ship.design.name}? You get ${money(cost, true)} back.`)) return;
            if (ship.farming) this.app.accrue();
            for (const [id, n] of Object.entries(cost)) save.stockpile[id] = (save.stockpile[id] ?? 0) + n;
            save.ships = save.ships.filter((s) => s.id !== ship.id);
            void this.app.persist();
            close();
            this.render();
          },
        },
      }, `Scrap for a full refund (${money(cost, true)})`),
    ));
  }

  private settings(): void {
    const save = this.app.save;
    const toolFirst = h('input', {
      type: 'checkbox', checked: save.settings.assistToolFirst === true,
      on: {
        change: () => {
          save.settings.assistToolFirst = toolFirst.checked;
          void this.app.persist();
        },
      },
    });
    const file = h('input', {
      type: 'file', accept: 'application/json,.json', style: 'display:none',
      on: { change: () => void this.importFile(file) },
    });
    sheet('Settings', h('div', { class: 'stack' },
      h('label', { class: 'check' }, toolFirst,
        h('span', null, h('b', null, 'Choose an assist tool before tapping a target'),
          h('br'), h('span', { class: 'muted small' }, 'Off: a tap goes to the first ready tool that can use what you tapped.'))),
      h('button', { class: 'btn', on: { click: () => this.exportSave() } }, 'Export save'),
      h('button', { class: 'btn', on: { click: () => file.click() } }, 'Import save'),
      file,
      h('button', {
        class: 'btn danger', on: {
          click: () => {
            if (!confirm('Delete this save and start over?')) return;
            void this.app.reset();
          },
        },
      }, 'Start a new game'),
    ));
  }

  private exportSave(): void {
    const blob = new Blob([JSON.stringify(this.app.save, null, 1)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'hulls-and-lanes-save.json' });
    document.body.append(a);
    a.click();
    a.remove();
  }

  private async importFile(input: HTMLInputElement): Promise<void> {
    const f = input.files?.[0];
    if (!f) return;
    try {
      await this.app.replaceSave(await f.text());
      toast('Save imported.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That file is not a save.', 'bad');
    }
  }
}
