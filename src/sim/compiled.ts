// Content resolved to indices once, so per-tick code never looks anything up
// by string. Cached per Content object.

import type { Content, TurretDef } from './types';

export interface CompiledRecipe {
  id: string;
  /** Index into content.parts of the machine that runs it. */
  machine: number;
  inItems: number[];
  inCounts: number[];
  outItems: number[];
  outCounts: number[];
  ticks: number;
  fuelIn: number;
  fuelOut: number;
}

export interface CompiledTurret {
  def: TurretDef;
  ammo: number;
  cooldownTicks: number;
  /** Damage multiplier by asteroid size index. */
  sizeMultiplier: number[];
}

export interface Compiled {
  nItems: number;
  itemIndex: Record<string, number>;
  bankable: number[];
  repairKit: number;
  recipes: CompiledRecipe[];
  /** Recipe indices by part-def index. */
  recipesByMachine: number[][];
  /** Turret by part-def index, or null. */
  turrets: (CompiledTurret | null)[];
  /** Chunk item dropped by each material index. */
  chunkOfMaterial: number[];
  /** Size index a size splits into, or -1. */
  splitInto: number[];
}

const cache = new WeakMap<Content, Compiled>();

export function compile(content: Content): Compiled {
  const hit = cache.get(content);
  if (hit) return hit;

  const itemIndex: Record<string, number> = {};
  content.items.forEach((it, i) => { itemIndex[it.id] = i; });
  const item = (id: string): number => {
    if (!(id in itemIndex)) throw new Error(`Unknown item "${id}".`);
    return itemIndex[id];
  };
  const partIndex = (id: string): number => {
    const i = content.parts.findIndex((p) => p.id === id);
    if (i < 0) throw new Error(`Unknown part "${id}".`);
    return i;
  };

  const recipes: CompiledRecipe[] = content.recipes.map((r) => ({
    id: r.id,
    machine: partIndex(r.machine),
    inItems: Object.keys(r.inputs).map(item),
    inCounts: Object.values(r.inputs),
    outItems: Object.keys(r.outputs).map(item),
    outCounts: Object.values(r.outputs),
    ticks: Math.round(r.seconds * content.constants.tickRate),
    fuelIn: r.fuelIn ?? 0,
    fuelOut: r.fuelOut ?? 0,
  }));
  const recipesByMachine: number[][] = content.parts.map(() => []);
  recipes.forEach((r, i) => recipesByMachine[r.machine].push(i));

  const rules = content.turretRules;
  const turrets: (CompiledTurret | null)[] = content.parts.map(() => null);
  for (const def of rules.turrets) {
    turrets[partIndex(def.part)] = {
      def,
      ammo: item(def.ammo),
      cooldownTicks: content.constants.tickRate / def.shotsPerSecond,
      sizeMultiplier: content.asteroidSizes.map((s) => rules.multipliers[def.damageType][s.targetClass]),
    };
  }

  const out: Compiled = {
    nItems: content.items.length,
    itemIndex,
    bankable: content.items.map((it, i) => (it.bankable ? i : -1)).filter((i) => i >= 0),
    repairKit: item('repair_kit'),
    recipes,
    recipesByMachine,
    turrets,
    chunkOfMaterial: content.materials.map((m) => item(m + '_chunk')),
    splitInto: content.asteroidSizes.map((s) =>
      (s.splitInto ? content.asteroidSizes.findIndex((o) => o.id === s.splitInto) : -1)),
  };
  cache.set(content, out);
  return out;
}
