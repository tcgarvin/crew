/**
 * Small helper for indexing into a known-nonempty array under `noUncheckedIndexedAccess` without
 * a non-null assertion (forbidden by the repo's lint rules). Throwing on a genuinely empty array
 * is the right behaviour here: every caller in `mockKernel.ts` indexes one of the hardcoded,
 * statically nonempty arrays in `mockGeometry.ts`.
 */
export function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) {
    throw new Error(`index ${index} out of bounds for array of length ${array.length}`);
  }
  return value;
}
