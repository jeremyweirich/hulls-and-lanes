# Hulls & Lanes

Read `README.md` first: it has the status, layout, sim rules, conventions, and every place the code departs from the spec.

The design docs are two Claude Docs artifacts, "Hulls & Lanes — Game Spec v0.1" and "Hulls & Lanes — Concept Brief". Section numbers in code comments refer to the spec.

## Before committing

```bash
npm run typecheck && npm test
```

If anything under `src/sim/` or `src/data/` changed, also run `npm run determinism`. If run outcomes changed on purpose, bump `SIM_VERSION` in `src/sim/types.ts` and run `npm run determinism -- --update`.

`npm run balance -- --design reference1 --assist` shows what a data or sim change did to readiness, haul and assisted runs.

## Rules that are easy to break

- `src/sim/` must stay deterministic: no `Math.sin`/`cos`/`atan2`/`pow`/`hypot`/`random`, no clock, no DOM, no per-tick allocation, no iteration order that depends on timing. See the README section.
- `src/sim/` and `src/game/` import nothing from `src/render/` or the page. Renderers and UI read sim state and never write it; player input goes in through `sim.enqueue()`.
- Tunable numbers go in `src/data/*.json`, not in code.

## Where things stand

Built: the sim for Tier 1 (flight, factory, autocannon, assist tools), the hub rules (readiness, certification, idle farming, saves), and the playable Tier 1 loop in `src/ui/`: hub, shipyard, launch setup, run view and run report. `src/debug.ts` and `debug.html` are a debug page, not the game's UI.

Next: play the Tier 1 loop on a phone and judge whether it is fun (spec section 15) before adding content. Left for later: the map screen, contracts, blueprints, the item-flow overlay, and Tiers 2 and up.

The UI uses no framework. Check screens in a real browser at phone size (Playwright with `devices['iPhone 13']`), not only with unit tests.

Decided by the owner: 8 slugs per plate. Still provisional: Lane 1 densities, and tapping a target without first choosing an assist tool.

Pushes to `main` deploy to GitHub Pages. Work is pushed to `main` directly.
