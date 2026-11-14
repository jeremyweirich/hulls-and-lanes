// Number and material formatting shared by the screens.

import { content } from '../data';

const SHORT: Record<string, string> = { iron_plate: 'P', carbon: 'C', alloy: 'A', scrap: 'S' };

export function fmt(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '–';
  return n.toFixed(digits);
}

export function itemName(id: string): string {
  return content.items.find((it) => it.id === id)?.name ?? id;
}

/** "272 P" or "15 P 5 C". With showZero, an empty record reads "0 P". */
export function money(cost: Record<string, number>, showZero = false): string {
  const parts = Object.entries(cost).filter(([, n]) => Math.round(n) !== 0)
    .map(([id, n]) => `${Math.round(n)} ${SHORT[id] ?? id}`);
  if (!parts.length && showZero) return '0 P';
  return parts.join(' ');
}

/** "1 m 23 s" style durations for reports. */
export function duration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m ${s % 60} s`;
  const m = Math.floor(s / 60);
  return `${Math.floor(m / 60)} h ${m % 60} m`;
}
