# Hulls & Lanes

A mobile web game about designing automated factory-warships and sending them down asteroid lanes. The design lives in two docs: the Concept Brief and the Game Spec v0.1. Section numbers below refer to the spec.

## Status

Milestone 1 of the build order (Flight) is in place, plus the parts of later milestones that the physics depends on:

- Deterministic sim core: fixed 30 Hz tick, seeded RNG streams, engine-independent trig, input queue and replay, state hashing (section 3).
- Ship model: design format, placement rules, design hash, mass properties, damage, breakup (sections 4 and 5).
- Flight: thrusters, fuel tanks and pipe networks, gyro, behaviors, thrust allocator (sections 6 and 7, fuel only).
- Lane 1: slice-based asteroid spawning, impacts with damage spill and impulses, run end conditions (sections 5 and 9).
- Headless runs, a balance harness, a determinism test, and a debug renderer.

Not built yet: turrets, belts, inserters, machines, collectors, enemy ships, the shipyard, readiness checks, saves, and every screen other than the debug view.

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

`npm run dev` serves the flight debug page: the starter ship flying Lane 1 on its own. Add `?seed=9&speed=4` to the URL to pick a run.

`npm run determinism` runs fixed design, lane and seed triples under Node and in every browser engine Playwright can launch, and compares the final-state hashes with `tests/golden/determinism.json`. If a change to outcomes is intended, bump `SIM_VERSION` in `src/sim/types.ts` and rerun with `-- --update`.

## Layout

| Path | Holds |
| --- | --- |
| `src/sim/` | The simulation. Imports nothing from the browser, `render/` or `ui/`. |
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
- The tick runs the ten steps of section 3 in order, in `Sim.step()`. Steps 7 (turrets) and 8 (logistics) are empty and marked.

## Choices made where the spec was silent or needed adjusting

- **Trig** uses fixed polynomials rather than lookup tables. Both are bit-identical everywhere; polynomials are more accurate.
- **Drag** is applied per tick as `v *= 1 − 0.03/30`, which loses 2.96% per second rather than exactly 3%.
- **Impact damage** uses the closing speed along the contact normal, so a grazing hit does less than a head-on one.
- **Damage spill** counts only occupied cells against the size's limit; holes along the path are skipped.
- **Gyro tie-break**: the allocator has a small penalty on gyro use (`gyroReluctance`). Without it, differential thrust and the gyro can cancel each other and leave the gyro saturated for no benefit.
- **Asteroid counts** per slice are the density's whole part plus a coin flip for the fraction.
- **Lane 1 densities** and its 40 u clear start are placeholders. They need tuning once the autocannon exists.
