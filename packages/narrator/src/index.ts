import { placeholderSchema } from "@crew/content";
import type { EntityId } from "@crew/sim";

/**
 * Digest projection, prompts, output schemas, intent-to-command translation
 * and the narrator authority table. Placeholder for the V1 slice.
 */
export const NARRATOR_PLACEHOLDER = { schema: placeholderSchema } as const;

export type NarratorActorId = EntityId;
