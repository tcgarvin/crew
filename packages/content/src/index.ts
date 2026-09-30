import type { EntityId } from "@crew/sim";
import { z } from "zod";

/**
 * Zod schemas, authored content and the content validator. Placeholder for
 * the V1 slice. `@crew/sim` is imported for types only, per the
 * content-sim-types-only dependency-cruiser rule.
 */
export const placeholderSchema = z.object({
  id: z.string(),
});

export type Placeholder = z.infer<typeof placeholderSchema> & { id: EntityId };
