/// <reference lib="webworker" />
/**
 * Web Worker entry point. Wires the real `@crew/sim` kernel with every V1 system
 * (`createFullRegistry`) and the authored `@crew/content` bundle. `host.ts` itself never imports
 * a concrete kernel, so it stays kernel-agnostic. The narrator is called from the main thread
 * (which holds the auth token); the worker only halts and waits for the answering commands.
 */
import type { ToWorker } from "@crew/sim";
import { createKernel } from "@crew/sim";
import { loadWebContent } from "./content";
import { createHost } from "./host";
import { createFullRegistry } from "./registry";
import { weighAgent } from "./weighing";

declare const self: DedicatedWorkerGlobalScope;

const kernel = createKernel(createFullRegistry());
const { bundle, config } = loadWebContent();

const host = createHost({
  kernel,
  content: bundle,
  config,
  dirtFrameEverySeconds: config.values.host.dirtFrameEverySeconds,
  postMessage: (message) => self.postMessage(message),
  weigh: weighAgent,
});

self.onmessage = (event: MessageEvent<ToWorker>) => {
  host.handleMessage(event.data);
};
