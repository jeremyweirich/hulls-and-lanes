// The hub (spec section 12): stockpile, hangar slots, and the ships in them.

import { content } from '../data';
import { designBounds } from '../sim';
import type { App } from './app';
import { fill, h, type Screen } from './dom';

export class HubScreen implements Screen {
  readonly el: HTMLElement;
  private readonly body = h('div', { class: 'scroll' });

  constructor(private readonly app: App) {
    this.el = h('div', { class: 'screen hub' },
      h('header', { class: 'bar' }, h('h1', null, 'Hub 1')),
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
    fill(this.body,
      h('h3', null, 'Stockpile'),
      h('div', { class: 'stock' },
        ['iron_plate', 'carbon', 'alloy', 'scrap']
          .filter((id) => id === 'iron_plate' || (save.stockpile[id] ?? 0) > 0)
          .map((id) => h('div', { class: 'mat' }, h('b', null, Math.floor(save.stockpile[id] ?? 0)),
            h('span', null, content.items.find((it) => it.id === id)!.name)))),
      h('h3', null, `Hangar · ${save.ships.length} of ${save.unlocks.hangarSlots} slots`),
      save.ships.map((ship) => {
        const b = designBounds(ship.design);
        return h('div', { class: 'card' },
          h('div', { class: 'head' }, h('h2', null, ship.design.name || 'Unnamed ship'),
            h('span', { class: 'muted small' }, `${b.w}×${b.h}`)),
          h('div', { class: 'actions' },
            h('button', { class: 'btn primary', on: { click: () => this.app.toShipyard(ship.id) } }, 'Shipyard')));
      }),
      Array.from({ length: Math.max(0, save.unlocks.hangarSlots - save.ships.length) }, () =>
        h('button', { class: 'card empty btn wide', on: { click: () => this.newShip() } }, '+ New ship (empty grid)')),
    );
  }

  private newShip(): void {
    const save = this.app.save;
    let n = 1;
    while (save.ships.some((s) => s.id === `s${n}`)) n++;
    save.ships.push({
      id: `s${n}`, design: { name: `Ship ${save.ships.length + 1}`, tiles: [], parts: [] },
      salvagedParts: [], benchmarks: {}, farming: null,
    });
    void this.app.persist();
    this.app.toShipyard(`s${n}`);
  }
}
