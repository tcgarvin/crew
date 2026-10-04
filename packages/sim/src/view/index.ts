/**
 * The AgentView (the only truth-shaped surface the planner is allowed to see) and its plain-data
 * snapshot for the inspector.
 */
import type { KernelRegistry, Unregister } from "../core/registry";
import { buildAgentView } from "./agentView";

export { toAgentViewSnapshot } from "./snapshot";

/** Install the W4a AgentView builder on `registry`. */
export function registerAgentView(registry: KernelRegistry): Unregister {
  return registry.setAgentViewBuilder(buildAgentView);
}
