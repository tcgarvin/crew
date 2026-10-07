/**
 * Plain-data copy of an `AgentView` for the inspector (W0 decision: the facade is not
 * structured-clone safe, so the worker ships this instead). Deep-copied through JSON so the
 * snapshot never aliases live state.
 */
import type { AgentView, AgentViewSnapshot } from "../core/types/view";

export function toAgentViewSnapshot(view: AgentView): AgentViewSnapshot {
  const snapshot: AgentViewSnapshot = {
    tick: view.tick,
    self: view.self,
    facts: view.facts(),
    problems: view.knownProblems(),
    tasks: view.knownTasks(),
    roster: view.roster(),
    sessions: view.sessions(),
  };
  const alert = view.alert();
  const withAlert: AgentViewSnapshot = alert === undefined ? snapshot : { ...snapshot, alert };
  return JSON.parse(JSON.stringify(withAlert)) as AgentViewSnapshot;
}
