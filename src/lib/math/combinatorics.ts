/**
 * Exact combinatorics for system (combination) coupons.
 *
 * The column count is money: it is multiplied by the stake. It is computed with
 * BigInt and a multiplicative recurrence, never with factorials (which overflow
 * at 21!) and never with floating point (§18).
 */

export class InvalidSystemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSystemError';
  }
}

/**
 * C(n, k) = n! / (k! * (n-k)!), evaluated as a product so no intermediate
 * factorial is ever materialised.
 */
export function combinationCount(n: number, k: number): bigint {
  assertValidSystem(n, k);

  // C(n, k) === C(n, n-k); pick the cheaper side.
  const kk = Math.min(k, n - k);
  let result = 1n;
  for (let i = 1; i <= kk; i++) {
    // Multiply first, then divide: the running value is always an integer
    // because C(n, i) is an integer at every step.
    result = (result * BigInt(n - kk + i)) / BigInt(i);
  }
  return result;
}

export function assertValidSystem(n: number, k: number): void {
  if (!Number.isInteger(n) || !Number.isInteger(k)) {
    throw new InvalidSystemError(`n and k must be integers, received n=${n}, k=${k}`);
  }
  if (n < 0) {
    throw new InvalidSystemError(`n must be >= 0, received ${n}`);
  }
  if (k < 0) {
    throw new InvalidSystemError(`k must be >= 0, received ${k}`);
  }
  if (k > n) {
    throw new InvalidSystemError(`k must be <= n, received n=${n}, k=${k}`);
  }
}

/** Hard ceiling so an operator cannot request a 10-million-column coupon. */
export const MAX_SYSTEM_COLUMNS = 100_000n;

export function assertColumnCountWithinLimit(columns: bigint): void {
  if (columns > MAX_SYSTEM_COLUMNS) {
    throw new InvalidSystemError(
      `System would produce ${columns} columns, above the ${MAX_SYSTEM_COLUMNS} limit`,
    );
  }
}

/**
 * Lazily yields every k-sized combination in lexicographic index order, so
 * `columnIndex` is stable and reproducible across runs.
 */
export function* combinations<T>(items: readonly T[], k: number): Generator<T[]> {
  const n = items.length;
  assertValidSystem(n, k);

  if (k === 0) {
    yield [];
    return;
  }

  const indices = Array.from({ length: k }, (_, i) => i);

  while (true) {
    yield indices.map((i) => items[i] as T);

    // Find the rightmost index that can still be advanced.
    let i = k - 1;
    while (i >= 0 && (indices[i] as number) === i + n - k) {
      i--;
    }
    if (i < 0) return;

    indices[i] = (indices[i] as number) + 1;
    for (let j = i + 1; j < k; j++) {
      indices[j] = (indices[j - 1] as number) + 1;
    }
  }
}

/** Parses "SYSTEM_3" into k=3. Returns null for anything else. */
export function parseSystemType(systemType: string): number | null {
  const match = /^SYSTEM_(\d+)$/.exec(systemType);
  if (!match) return null;
  const k = Number.parseInt(match[1] as string, 10);
  return Number.isInteger(k) && k > 0 ? k : null;
}

export function formatSystemType(k: number): string {
  return `SYSTEM_${k}`;
}
