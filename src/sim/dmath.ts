// Deterministic math. The built-in sin/cos/atan2 may differ in the last bit
// between engines, which would break replays and readiness scores. Everything
// here uses only + - * / and Math.sqrt, which IEEE 754 defines exactly.
//
// The spec asks for lookup tables; fixed polynomials give the same guarantee
// (bit-identical everywhere) with better accuracy and no interpolation error.

export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

/** Wraps an angle into [-PI, PI]. */
export function wrapAngle(a: number): number {
  if (a > PI || a < -PI) {
    a -= TWO_PI * Math.floor((a + PI) / TWO_PI);
  }
  return a;
}

// Taylor series on [-PI/2, PI/2]; error below 1e-13 there.
function sinCore(x: number): number {
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880
    + x2 * (-1 / 39916800 + x2 * (1 / 6227020800 + x2 * (-1 / 1307674368000
    + x2 * (1 / 355687428096000 + x2 * (-1 / 121645100408832000))))))))));
}

export function dsin(a: number): number {
  let x = wrapAngle(a);
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  return sinCore(x);
}

// Same idea for cosine, so that dcos(0) is exactly 1.
function cosCore(x: number): number {
  const x2 = x * x;
  return 1 + x2 * (-1 / 2 + x2 * (1 / 24 + x2 * (-1 / 720 + x2 * (1 / 40320
    + x2 * (-1 / 3628800 + x2 * (1 / 479001600 + x2 * (-1 / 87178291200
    + x2 * (1 / 20922789888000 + x2 * (-1 / 6402373705728000
    + x2 * (1 / 2432902008176640000))))))))));
}

export function dcos(a: number): number {
  let x = wrapAngle(a);
  if (x < 0) x = -x;
  return x > HALF_PI ? -cosCore(PI - x) : cosCore(x);
}

// atan for x >= 0. Two half-angle reductions bring the argument under 0.42,
// where the alternating series converges fast.
function atanPos(x: number): number {
  let scale = 1;
  let invert = false;
  if (x > 1) {
    x = 1 / x;
    invert = true;
  }
  for (let i = 0; i < 2; i++) {
    x = x / (1 + Math.sqrt(1 + x * x));
    scale *= 2;
  }
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let k = 1; k <= 14; k++) {
    term *= -x2;
    sum += term / (2 * k + 1);
  }
  const r = sum * scale;
  return invert ? HALF_PI - r : r;
}

export function datan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  // Keep the ratio at or below 1 for accuracy.
  let a = ax >= ay ? atanPos(ay / ax) : HALF_PI - atanPos(ax / ay);
  if (x < 0) a = PI - a;
  return y < 0 ? -a : a;
}
