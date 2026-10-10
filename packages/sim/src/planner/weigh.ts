/**
 * What an actor is weighing, for the inspector (§what-a-crew-member-weighs): every candidate the
 * selector would rank, best first, the ones it ruled out and why, and what it decides. Pure over
 * the `AgentView`, like the selector, and never called by the pipeline: the inspector asks for it
 * on a tap.
 */
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView } from "../core/types/view";
import type { Intent } from "../core/types/work";
import { type Candidate, type Rejection, enumerateCandidates } from "./candidates";
import { compareCandidates, selectIntent } from "./select";

export interface Weighing {
  /** Best first, as the selector ranks them. */
  readonly ranked: readonly Candidate[];
  readonly rejected: readonly Rejection[];
  /** What the selector decides this tick (`continue` keeps the current activity). */
  readonly intent: Intent;
}

export function weighOptions(view: AgentView, config: PlannerConfig): Weighing {
  const { candidates, rejected } = enumerateCandidates(view, config);
  const ranked = [...candidates].sort((a, b) => compareCandidates(a, b, config));
  return { ranked, rejected, intent: selectIntent(view, config) };
}
