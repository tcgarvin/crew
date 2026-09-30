import type { EntityId } from "../core/types";
import { VIEW_PLACEHOLDER } from "../view/index";

/**
 * Task selection. Per SD §4.3, planner code may only import from
 * `core/types*` and `view/**` (plus planner siblings) — never `systems/**`
 * or raw world state.
 */
export const PLANNER_PLACEHOLDER = { view: VIEW_PLACEHOLDER } satisfies Record<string, unknown>;

export type PlannerAgentId = EntityId;
