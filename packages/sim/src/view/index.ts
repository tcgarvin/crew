/**
 * AgentView builder, render projection, and narrator digest inputs. This is the only
 * truth-shaped surface the planner is allowed to see.
 */
import type { KernelRegistry, Unregister } from "../core/registry";
import { buildAgentView } from "./agentView";

export const VIEW_PLACEHOLDER = "view" as const;
export { buildAgentView } from "./agentView";
export { toAgentViewSnapshot } from "./snapshot";

/** Install the W4a AgentView builder on `registry`. */
export function registerAgentView(registry: KernelRegistry): Unregister {
  return registry.setAgentViewBuilder(buildAgentView);
}
