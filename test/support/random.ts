export interface Random {
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
}

export function random(seed: number): Random {
  if (!Number.isInteger(seed)) throw new Error(`Seed must be a whole number, got ${seed}`);
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new Error(`Bad range ${min} to ${max}`);
    return min + Math.floor(next() * (max - min + 1));
  };
  return {
    int,
    chance: (probability) => next() < probability,
    pick: (items) => {
      if (items.length === 0) throw new Error("Cannot pick from an empty list");
      return items[int(0, items.length - 1)];
    },
    shuffle: (items) => {
      const result = [...items];
      for (let i = result.length - 1; i > 0; i--) {
        const j = int(0, i);
        [result[i], result[j]] = [result[j], result[i]];
      }
      return result;
    },
  };
}
