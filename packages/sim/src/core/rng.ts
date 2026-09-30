/**
 * Seeded randomness (SD §5.4, review §C.5, CONTRACTS rule 10).
 *
 * Each named stream in `state.rng` holds an sfc32 state `[a, b, c, d]`. Drawing replaces the
 * stream's tuple in state, so the stream position is saved with the world and survives a JSON
 * round-trip. Streams are seeded independently from `(masterSeed, streamName)` via splitmix32.
 * Determinism is not a goal (D4); seeding exists for stable tests and bug reports.
 */
import { RNG_STREAMS, type RngStreamName, type Sfc32State } from "./types/common";
import type { RngApi } from "./types/pipeline";

const TWO_POW_32 = 4294967296;
/** sfc32 warm-up rounds after seeding, so nearby seeds decorrelate. */
const SFC32_WARMUP_ROUNDS = 12;

/** One splitmix32 step: returns the next state and a 32-bit output. */
function splitmix32(state: number): { state: number; value: number } {
  const next = (state + 0x9e3779b9) | 0;
  let z = next;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  z ^= z >>> 16;
  return { state: next, value: z >>> 0 };
}

/** FNV-1a over a string, as an unsigned 32-bit integer. */
export function hashString32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** One sfc32 step. Returns the new state and a 32-bit unsigned output. */
export function sfc32Next(state: Sfc32State): { state: Sfc32State; value: number } {
  let [a, b, c, d] = state;
  a |= 0;
  b |= 0;
  c |= 0;
  d |= 0;
  const t = (((a + b) | 0) + d) | 0;
  d = (d + 1) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) | 0;
  return { state: [a >>> 0, b >>> 0, c >>> 0, d >>> 0], value: t >>> 0 };
}

/** Seed one stream from the master seed and the stream's name. */
export function seedStream(masterSeed: number, streamName: string): Sfc32State {
  if (!Number.isInteger(masterSeed)) {
    throw new RangeError(`RNG master seed must be an integer, got ${masterSeed}`);
  }
  let mix = (masterSeed ^ hashString32(streamName)) | 0;
  const words: number[] = [];
  for (let i = 0; i < 4; i++) {
    const step = splitmix32(mix);
    mix = step.state;
    words.push(step.value);
  }
  let state = words as unknown as Sfc32State;
  for (let i = 0; i < SFC32_WARMUP_ROUNDS; i++) {
    state = sfc32Next(state).state;
  }
  return state;
}

/** Fresh state for every stream in `RNG_STREAMS`. */
export function seedAllStreams(masterSeed: number): Record<RngStreamName, Sfc32State> {
  const out = {} as Record<RngStreamName, Sfc32State>;
  for (const name of RNG_STREAMS) {
    out[name] = seedStream(masterSeed, name);
  }
  return out;
}

/** The slice of state the RNG reads and writes. */
export interface RngHost {
  readonly seed: number;
  rng: Record<RngStreamName, Sfc32State>;
}

/** Build the `RngApi` over a state's streams. Draws write the advanced stream back into `host.rng`. */
export function createRngApi(host: RngHost): RngApi {
  const nextU32 = (stream: RngStreamName): number => {
    const step = sfc32Next(host.rng[stream]);
    host.rng[stream] = step.state;
    return step.value;
  };
  const float = (stream: RngStreamName): number => nextU32(stream) / TWO_POW_32;

  return {
    float,
    int(stream, min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
        throw new RangeError(`rng.int needs integers min <= max, got [${min}, ${max}]`);
      }
      return min + Math.floor(float(stream) * (max - min + 1));
    },
    chance(stream, probability) {
      if (!(probability >= 0 && probability <= 1)) {
        throw new RangeError(`rng.chance probability must be in [0, 1], got ${probability}`);
      }
      return float(stream) < probability;
    },
    pick(stream, items) {
      if (items.length === 0) {
        throw new RangeError("rng.pick from an empty list");
      }
      const index = Math.floor(float(stream) * items.length);
      return items[index] as (typeof items)[number];
    },
    weighted(stream, items) {
      let total = 0;
      for (const entry of items) {
        if (!(entry.weight >= 0) || !Number.isFinite(entry.weight)) {
          throw new RangeError(`rng.weighted weights must be finite and >= 0, got ${entry.weight}`);
        }
        total += entry.weight;
      }
      if (total <= 0) {
        throw new RangeError("rng.weighted needs at least one positive weight");
      }
      let target = float(stream) * total;
      for (const entry of items) {
        if (target < entry.weight) {
          return entry.item;
        }
        target -= entry.weight;
      }
      // Float rounding can leave `target` a hair above the last weight: take the last positive one.
      for (let i = items.length - 1; i >= 0; i--) {
        const entry = items[i];
        if (entry !== undefined && entry.weight > 0) {
          return entry.item;
        }
      }
      throw new RangeError("rng.weighted: unreachable");
    },
    keyedFloat(stream, key, counter) {
      let mix = (host.seed ^ hashString32(`${stream}|${key}|${counter}`)) | 0;
      // Two splitmix rounds so small key/counter changes spread over all bits.
      mix = splitmix32(mix).value | 0;
      return splitmix32(mix).value / TWO_POW_32;
    },
  };
}
