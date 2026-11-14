// Entry point for the game: load the save, then open the hub.

import { IndexedDbStore } from '../game';
import { App } from './app';
import './style.css';

async function main(): Promise<void> {
  const root = document.getElementById('app')!;
  const app = await App.boot(root, new IndexedDbStore());
  // Some mobile browsers clear storage for sites that go unused (spec section 14).
  void navigator.storage?.persist?.();
  app.toHub();
  Object.assign(window, { hl: app });
}

void main();
