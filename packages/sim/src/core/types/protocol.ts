/**
 * Worker ↔ main-thread protocol (PLAN §6 W0, D14 run-ahead with buffered playback).
 *
 * The worker owns the kernel and runs ahead of the viewer, up to `config.host.runAheadCapSeconds`,
 * stopping at the next hook or decision. The main thread buffers frames and plays them back at
 * human speed.
 *
 * Two clocks:
 * - **simTick**: the kernel's `state.tick`, the head of simulated time (in the worker).
 * - **viewTick**: the tick of the frame the player is currently looking at (main thread). Always
 *   `<= simTick`. The main thread reports it with `viewProgress` so the worker can enforce the
 *   run-ahead cap; the inspector reads snapshots at `viewTick`, never the ahead-state, so the
 *   future does not leak (D14).
 *
 * All messages are structured-clone safe plain data. `requestId` correlates replies.
 */
import type { Command, EnqueueResult } from "./commands";
import type { Tick } from "./common";
import type { Decision, NarratorHook } from "./decisions";
import type { SimEvent } from "./events";
import type { ActorId, ScenarioDefId } from "./ids";
import type { SaveEnvelope } from "./save";
import type { WorldState } from "./state";
import type { AgentViewSnapshot, DirtFrame, RenderFrame } from "./view";
import type { UrgencyClass } from "./work";

/** D90: one option an actor is weighing, in words, for the inspector. */
export interface WeighedOptionWords {
  readonly text: string;
  readonly urgency: UrgencyClass;
  /** Walk, tool fetch and work, whole seconds. */
  readonly seconds: number;
  /** What they are doing now; what the selector picks next. */
  readonly mark?: "doing" | "next";
}

/** D90: what an actor is weighing (`weighOptions`), worded by the host. */
export interface WeighingWords {
  /** One line: what they will do and why, e.g. "keeps playing cards: nothing outranks it". */
  readonly verdict: string;
  /** Best first. */
  readonly options: readonly WeighedOptionWords[];
  readonly ruledOut: readonly { readonly text: string; readonly reason: string }[];
}

/**
 * What to load. W0 decision: the worker imports the static content bundle itself, so `load`
 * carries only a save or a scenario reference, never the bundle.
 */
export type LoadSource =
  | { readonly kind: "save"; readonly envelope: SaveEnvelope }
  | { readonly kind: "scenario"; readonly scenarioId: ScenarioDefId; readonly seed: number };

export type ToWorker =
  | { readonly type: "load"; readonly source: LoadSource }
  /** Sim-seconds per real second (1 = real time). Does not change dt (SD §5.1). */
  | { readonly type: "setSpeed"; readonly speed: number }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  /** Player/narrator commands; the worker replies with `commandResult`. */
  | { readonly type: "command"; readonly requestId: string; readonly command: Command }
  /** Playback position, so the worker can cap run-ahead. */
  | { readonly type: "viewProgress"; readonly viewTick: Tick }
  | { readonly type: "requestSave"; readonly requestId: string }
  /** Inspector: full state as of a past tick from the view-time snapshot ring. */
  | { readonly type: "requestSnapshotAt"; readonly requestId: string; readonly tick: Tick }
  | {
      readonly type: "requestAgentView";
      readonly requestId: string;
      readonly actorId: ActorId;
      readonly tick: Tick;
    };

export type FromWorker =
  /** Frames are produced ahead of the viewer; the main thread buffers and plays them by tick. */
  | { readonly type: "frame"; readonly frame: RenderFrame }
  /**
   * D82: the dirt grid, on load and every `host.dirtFrameEverySeconds`; the main thread queues
   * these by tick and applies the newest with `tick <= viewTick` in the playback step (D14).
   */
  | { readonly type: "dirt"; readonly frame: DirtFrame }
  | { readonly type: "events"; readonly events: readonly SimEvent[] }
  /** The worker stopped at a hook at `tick`; the main thread shows the narrator loading state when playback reaches it. */
  | { readonly type: "hookRaised"; readonly hook: NarratorHook; readonly tick: Tick }
  | { readonly type: "decisionPending"; readonly decision: Decision }
  | { readonly type: "commandResult"; readonly requestId: string; readonly result: EnqueueResult }
  | { readonly type: "saveBlob"; readonly requestId: string; readonly envelope: SaveEnvelope }
  | {
      readonly type: "snapshot";
      readonly requestId: string;
      readonly tick: Tick;
      readonly state: WorldState;
    }
  | {
      readonly type: "agentViewResult";
      readonly requestId: string;
      readonly actorId: ActorId;
      readonly tick: Tick;
      readonly view: AgentViewSnapshot;
      /** D90: what they are weighing and what they will do next. */
      readonly weighing: WeighingWords;
    }
  | {
      readonly type: "runAheadStatus";
      readonly simTick: Tick;
      /** Last viewTick the main thread reported; absent before the first report. */
      readonly viewTick?: Tick;
      /** Frames produced but not yet acknowledged as viewed. */
      readonly buffered: number;
    }
  /** A request failed (e.g. snapshot tick outside the ring). */
  | { readonly type: "error"; readonly requestId?: string; readonly message: string };
