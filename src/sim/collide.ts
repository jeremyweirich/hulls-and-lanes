// Asteroid impacts on a ship's grid (spec section 5).

import type { Asteroids } from './asteroids';
import { damageCell, type Ship } from './ship';
import type { Content } from './types';

/**
 * Tick order 6. Each asteroid is tested as a circle against the occupied cells
 * under its bounding box, in the ship's grid frame. A closing contact deals
 * damage that scales with the square of the closing speed, spills through
 * destroyed cells along the impact direction, costs the asteroid as much HP as
 * it dealt, and pushes and spins the ship by the matching impulse.
 */
export function collideAsteroids(ship: Ship, asteroids: Asteroids, content: Content): void {
  const k = content.constants;
  const sizes = content.asteroidSizes;
  const { gw, gh } = ship;
  const c = ship.cos;
  const s = ship.sin;

  for (let i = 0; i < asteroids.high; i++) {
    if (!asteroids.alive[i]) continue;
    const def = sizes[asteroids.size[i]];
    const r = def.radius;
    const dx = asteroids.x[i] - ship.x;
    const dy = asteroids.y[i] - ship.y;
    const reach = ship.radius + r;
    if (dx * dx + dy * dy > reach * reach) continue;

    // Asteroid center in grid space.
    const gx = ship.comX + c * dx + s * dy;
    const gy = ship.comY - s * dx + c * dy;
    let x0 = Math.floor(gx - r);
    let x1 = Math.floor(gx + r);
    let y0 = Math.floor(gy - r);
    let y1 = Math.floor(gy + r);
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > gw - 1) x1 = gw - 1;
    if (y1 > gh - 1) y1 = gh - 1;

    // Deepest overlap: the occupied cell whose nearest point is closest to the center.
    let hitX = -1;
    let hitY = -1;
    let hitQx = 0;
    let hitQy = 0;
    let bestD2 = r * r;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (!ship.cellTile[cy * gw + cx]) continue;
        const qx = gx < cx ? cx : gx > cx + 1 ? cx + 1 : gx;
        const qy = gy < cy ? cy : gy > cy + 1 ? cy + 1 : gy;
        const d2 = (gx - qx) * (gx - qx) + (gy - qy) * (gy - qy);
        if (d2 < bestD2) {
          bestD2 = d2;
          hitX = cx;
          hitY = cy;
          hitQx = qx;
          hitQy = qy;
        }
      }
    }
    if (hitX < 0) continue;

    // Velocity of the asteroid relative to the hull at the contact point,
    // in the ship frame.
    const rsx = hitQx - ship.comX;
    const rsy = hitQy - ship.comY;
    const rwx = c * rsx - s * rsy;
    const rwy = s * rsx + c * rsy;
    const rvx = asteroids.vx[i] - (ship.vx - ship.omega * rwy);
    const rvy = asteroids.vy[i] - (ship.vy + ship.omega * rwx);
    const relX = c * rvx + s * rvy;
    const relY = -s * rvx + c * rvy;
    const relSpeed = Math.sqrt(relX * relX + relY * relY);

    // Contact normal, from the hull toward the asteroid. When the center is
    // already inside the cell, the asteroid came from where it is moving from.
    let nx: number;
    let ny: number;
    let dist = 0;
    if (bestD2 > 1e-12) {
      dist = Math.sqrt(bestD2);
      nx = (gx - hitQx) / dist;
      ny = (gy - hitQy) / dist;
    } else if (relSpeed > 1e-9) {
      nx = -relX / relSpeed;
      ny = -relY / relSpeed;
    } else {
      continue;
    }
    const closing = -(relX * nx + relY * ny);
    if (closing <= 0) continue;

    // Damage to the struck cell, then onward through whatever it destroys.
    const ratio = closing / k.impactReferenceSpeed;
    const damage = def.impactDamage * ratio * ratio;
    let left = damageCell(ship, hitX, hitY, damage);
    if (left > 0 && def.spillCells !== 0) {
      const dirX = relX / relSpeed;
      const dirY = relY / relSpeed;
      const stepX = dirX > 0 ? 1 : -1;
      const stepY = dirY > 0 ? 1 : -1;
      const tDeltaX = dirX !== 0 ? 1 / (dirX < 0 ? -dirX : dirX) : Infinity;
      const tDeltaY = dirY !== 0 ? 1 / (dirY < 0 ? -dirY : dirY) : Infinity;
      let tMaxX = tDeltaX / 2;
      let tMaxY = tDeltaY / 2;
      let cx = hitX;
      let cy = hitY;
      let spills = def.spillCells;
      while (left > 0 && spills !== 0) {
        if (tMaxX < tMaxY) {
          cx += stepX;
          tMaxX += tDeltaX;
        } else {
          cy += stepY;
          tMaxY += tDeltaY;
        }
        if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) break;
        if (!ship.cellTile[cy * gw + cx]) continue;
        left = damageCell(ship, cx, cy, left);
        spills--;
      }
    }
    const dealt = damage - left;

    // Impulse with restitution, applied at the contact point.
    const mass = def.mass;
    const rn = rsx * ny - rsy * nx;
    const j = (1 + k.restitution) * closing
      / (1 / ship.mass + 1 / mass + (rn * rn) / ship.inertia);
    const nwx = c * nx - s * ny;
    const nwy = s * nx + c * ny;
    ship.vx -= (j * nwx) / ship.mass;
    ship.vy -= (j * nwy) / ship.mass;
    ship.omega -= (j * rn) / ship.inertia;

    asteroids.hp[i] -= dealt;
    if (asteroids.hp[i] <= 0) {
      // Destroyed by ramming: drops nothing.
      asteroids.remove(i);
    } else {
      asteroids.vx[i] += (j * nwx) / mass;
      asteroids.vy[i] += (j * nwy) / mass;
      const push = r - dist + 0.001;
      asteroids.x[i] += nwx * push;
      asteroids.y[i] += nwy * push;
    }
  }
}
