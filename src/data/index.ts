// Game content. Every tunable number lives in these JSON files, not in code.

import type {
  AsteroidSizeDef, BehaviorDef, Constants, Content, Design, LaneDef, PartDef,
} from '../sim/types';
import asteroids from './asteroids.json';
import behaviors from './behaviors.json';
import constants from './constants.json';
import starter from './designs/starter.json';
import lane1 from './lanes/lane1.json';
import parts from './parts.json';

export const content: Content = {
  constants: constants as Constants,
  parts: parts as PartDef[],
  asteroidSizes: asteroids.sizes as AsteroidSizeDef[],
  materials: asteroids.materials,
  behaviors: behaviors as BehaviorDef[],
};

export const lanes: Record<string, LaneDef> = {
  lane1: lane1 as unknown as LaneDef,
};

export const designs: Record<string, Design> = {
  starter: starter as unknown as Design,
};
