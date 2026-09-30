/// <reference lib="webworker" />
/**
 * Web Worker entry point. Wires the real `@crew/sim` kernel: a registry with the spatial system
 * (W3) plus a temporary dev-only wander system, the authored `@crew/content` bundle, and the
 * narrator stub. `host.ts` itself never imports any of this file's dependencies directly, so it
 * stays kernel-agnostic.
 */
import { createKernel, createRegistry, registerSpatial } from "@crew/sim";
import type { ToWorker } from "@crew/sim";
import { loadWebContent } from "./content";
import { DEV_WANDER, devWanderSystem } from "./devWander";
import { createHost } from "./host";
import { stubNarrator } from "./narrator";

declare const self: DedicatedWorkerGlobalScope;

const registry = createRegistry();
registerSpatial(registry);
// TODO(W4a): remove when the planner lands.
if (DEV_WANDER) {
  registry.registerSystem(devWanderSystem);
}

const kernel = createKernel(registry);
const { bundle, config } = loadWebContent();

const host = createHost({
  kernel,
  content: bundle,
  config,
  postMessage: (message) => self.postMessage(message),
  narrator: stubNarrator,
});

self.onmessage = (event: MessageEvent<ToWorker>) => {
  host.handleMessage(event.data);
};
