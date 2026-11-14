// Game content. Every tunable number lives in these JSON files, not in code.

import type {
  AsteroidSizeDef, BehaviorDef, Constants, Content, Design, Economy, ItemDef, LaneDef, PartDef, RecipeDef, TurretRules,
} from '../sim/types';
import asteroids from './asteroids.json';
import behaviors from './behaviors.json';
import constants from './constants.json';
import economy from './economy.json';
import reference1 from './designs/reference1.json';
import starter from './designs/starter.json';
import lane1 from './lanes/lane1.json';
import items from './items.json';
import parts from './parts.json';
import recipes from './recipes.json';
import turrets from './turrets.json';

export const content: Content = {
  constants: constants as Constants,
  parts: parts as PartDef[],
  asteroidSizes: asteroids.sizes as AsteroidSizeDef[],
  materials: asteroids.materials,
  behaviors: behaviors as BehaviorDef[],
  items: items as ItemDef[],
  recipes: recipes as unknown as RecipeDef[],
  turretRules: turrets as TurretRules,
  economy: economy as Economy,
};

export const lanes: Record<string, LaneDef> = {
  lane1: lane1 as unknown as LaneDef,
};

export const designs: Record<string, Design> = {
  starter: starter as unknown as Design,
  reference1: reference1 as unknown as Design,
};
