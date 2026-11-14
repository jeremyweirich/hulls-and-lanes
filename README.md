# Hulls & Lanes

A mobile web game about designing automated factory-warships and sending them down asteroid lanes. The design lives in two docs: the Concept Brief and the Game Spec v0.1. Section numbers below refer to the spec.

## Status

Milestones 1 (Flight) and 3 (Factory and guns) of the build order are in place, sim side, along with the rules half of milestone 4 (The loop):

- Deterministic sim core: fixed 30 Hz tick, seeded RNG streams, engine-independent trig, input queue and replay, state hashing (section 3).
- Ship model: design format, placement rules, design hash, mass properties, damage, breakup (sections 4 and 5).
- Flight: thrusters, fuel tanks and pipe networks, gyro, behaviors, thrust allocator (section 6).
- Logistics: items, belts, inserters with filters, machines and all v1 recipes, collectors, fuel recipes, core repair (section 7).
- Combat: the autocannon, the damage multiplier table, targeting rules, chunk drops and boulder splitting (section 8).
- Lane 1: slice-based asteroid spawning, impacts with damage spill and impulses, launch load, run end conditions, haul (section 9).
- Headless runs, a balance harness, a determinism test, and a debug renderer.
- Game loop rules in `src/game/`: readiness checks on each lane's 20 fixed seeds (in Web Workers in the browser), benchmark records and the plain-language report, certification, idle income and accrual, design costs, banking a run, farming assignment, and the versioned save record with an IndexedDB store (sections 10, 11 and 14).
- Assist tools (section 13): Deck gun and Patch as sim commands, offered and sized per lane in lane data, replayable from the input log. The page takes taps: an asteroid for the Deck gun, a damaged part for Patch. A scripted assist bot lets the harness measure assisted runs.
- Two ships in `src/data/designs/`: the starter, and a two-gun Tier 1 reference ship.

Not built yet: the other four turrets and their projectiles, enemy ships, shields and power, contracts and unlocks, the shipyard, and every real screen. The debug page stands in for the run view and has a Readiness button; nothing is saved from it yet.

### Where the numbers stand

From `npm run balance -- --assist`, on Lane 1's 20 fixed seeds:

| Ship | Solo readiness | Assisted (bot) | Plate banked per clear | Idle income if farmed |
| --- | --- | --- | --- | --- |
| Starter Mk1 | 70% | 100% | about 9 | not certified |
| Tier 1 reference | 95% | 100% | about 46 | 649 plate per hour |

The bot taps about 15 times a minute, under the spec's limit of 20.

Twenty seeds is a noisy sample. Over 80 seeds the starter clears 51% solo and the reference ship 91%, against spec targets of 30–50% and 85–95%. The starter's haul is far below its 60-plate target; see the tuning notes below.

## Commands

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run balance -- --design starter --lane lane1 --seeds 20
```

```bash
npm run determinism
```

`npm run dev` serves the flight debug page: a ship flying Lane 1 on its own. Add `?design=reference1&seed=5&speed=4` to the URL to pick the ship and run.

`npm run balance` runs the lane's readiness check and prints the report. Add `--assist` to fly the same seeds again with the assist bot. It takes a design name from `src/data/designs/` or a path to a design JSON file.

`npm run determinism` runs fixed design, lane and seed triples under Node and in every browser engine Playwright can launch, and compares the final-state hashes with `tests/golden/determinism.json`. If a change to outcomes is intended, bump `SIM_VERSION` in `src/sim/types.ts` and rerun with `-- --update`.

## Deployment

Pushes to `main` run the tests, build, and deploy `dist/` to GitHub Pages through `.github/workflows/deploy.yml`. Pages must be enabled once in the repository settings, with the source set to GitHub Actions.

## Layout

| Path | Holds |
| --- | --- |
| `src/sim/` | The simulation. Imports nothing from the browser, `render/` or `ui/`. |
| `src/game/` | Hub-side rules over the save record. No DOM; only `readinessPool.ts` and `IndexedDbStore` need a browser. |
| `src/data/` | Every tunable number: parts, asteroids, behaviors, lanes, constants, designs. |
| `src/render/` | The debug renderer. Reads sim state, never writes it. |
| `scripts/` | Balance harness and determinism runner. |
| `tests/` | Unit tests and stored determinism hashes. |

## Rules for code in `src/sim/`

These keep runs identical across engines. Breaking one silently invalidates readiness scores.

- Arithmetic is `+ - * /` and `Math.sqrt` only. Use `dsin`, `dcos`, `datan2` from `dmath.ts`, never the built-ins. `Math.floor`, `Math.ceil` and `Math.imul` are exact and allowed.
- No `Math.random`, clock or DOM. Randomness comes from `Rng`, seeded per stream with `seedFor`.
- Iterate arrays in index order. Never iterate object keys, `Map` or `Set` in a way that affects outcomes.
- No allocation per tick. State lives in typed arrays sized at launch.
- Numbers belong in `src/data/`, not in code.

## Conventions

- Grid space: x right, y down, one unit per cell. Forward is −y. A part's `rot` is clockwise from facing forward; a thruster pushes the ship opposite the way it faces.
- World space has the same handedness. The ship flies toward −y, so lane distance is −y. Positive angles turn clockwise on screen.
- Part ids are indices into `design.parts`. That order is the sim's iteration order.
- The tick runs the ten steps of section 3 in order, in `Sim.step()`.
- A belt's `rot` is the way items move. An inserter's `rot` is the way it drops: it takes from the cell behind it.
- A machine with no `recipe` in the design and more than one possible recipe picks by input, like the crusher.

## Choices made where the spec was silent or needed adjusting

- **Trig** uses fixed polynomials rather than lookup tables. Both are bit-identical everywhere; polynomials are more accurate.
- **Drag** is applied per tick as `v *= 1 − 0.03/30`, which loses 2.96% per second rather than exactly 3%.
- **Impact damage** uses the closing speed along the contact normal, so a grazing hit does less than a head-on one.
- **Damage spill** counts only occupied cells against the size's limit; holes along the path are skipped.
- **Gyro tie-break**: the allocator has a small penalty on gyro use (`gyroReluctance`). Without it, differential thrust and the gyro can cancel each other and leave the gyro saturated for no benefit.
- **Asteroid counts** per slice are the density's whole part plus a coin flip for the fraction.
- **Collectors** reel items in at 8 u/s relative to the ship, and an item in range of two collectors goes to the first.
- **Turrets** hold at most 20 rounds, the same limit inserters fill them to. Launch ammo beyond that goes to the core.
- **Assist taps** need no tool selected first: the tap goes to the first ready tool that can use what was tapped. The spec has the player tap a tool button, then a target.
- **Offline cap**: time away beyond 8 hours is dropped. Following the spec's accrual steps literally would pay the excess at the next accrual.
- **Supply ran dry** is logged when none of that ammo is left anywhere on the ship, not when one turret is waiting on its inserter.
- **Collision course**, for targeting, means the asteroid's current relative velocity carries it into the hull's bounding box within 10 s.

## Tuning notes

Two data values depart from the spec because the factory loop did not close with the spec's numbers:

- **Slugs per plate is 8, not 4** (decided). A rock takes 10 slugs to kill and yields at most 16 at 4 per plate, so ammo only pays for itself if over 60% of chunks are collected. The gun reaches 14 u and a collector 6 u, so real collection is 30–50% and every ship ran dry. Raising collector range instead also works; it makes placement matter less.
- **Lane 1 densities** (provisional) are 12–20 pebbles and 4–7 rocks per 100 u, chosen so the reference ship lands in its 85–95% band.

The starter banks almost nothing: its single smelter feeds the fabricator first, and plate only overflows to the core when the gun is full. Hitting 60 plate per starter run needs either a richer lane or a different starter layout.
