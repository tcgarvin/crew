/**
 * Owns the sim worker's lifecycle: constructs it, exposes a typed `send`/`subscribe` pair over
 * the `ToWorker`/`FromWorker` protocol, and pauses/resumes it on tab visibility change (task
 * brief: "Pause on `document.visibilityState === 'hidden'`" — `document` only exists on the main
 * thread, so this listener lives here, not in `worker/host.ts`).
 */
import type { FromWorker, ToWorker } from "@crew/sim";

export interface SimConnection {
  send(message: ToWorker): void;
  subscribe(listener: (message: FromWorker) => void): () => void;
  /** Track whether the player explicitly paused, so a tab becoming visible again doesn't
   * override that choice. */
  setUserPaused(paused: boolean): void;
  dispose(): void;
}

export function createSimConnection(): SimConnection {
  const worker = new Worker(new URL("../worker/sim.worker.ts", import.meta.url), {
    type: "module",
  });
  const listeners = new Set<(message: FromWorker) => void>();

  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    for (const listener of listeners) listener(event.data);
  };

  let userPaused = false;

  function send(message: ToWorker): void {
    worker.postMessage(message);
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === "hidden") {
      send({ type: "pause" });
    } else if (!userPaused) {
      send({ type: "resume" });
    }
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  return {
    send,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setUserPaused(paused: boolean): void {
      userPaused = paused;
    },
    dispose() {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      worker.terminate();
    },
  };
}
