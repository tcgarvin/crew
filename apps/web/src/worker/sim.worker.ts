/// <reference lib="webworker" />
/**
 * Web Worker entry point. The only file that wires a concrete `Kernel` into `createHost` — swap
 * `mockKernel`/`MOCK_CONTENT_BUNDLE`/`MOCK_CONFIG` and `mockNarrator` for the real
 * `@crew/sim` kernel export, a real content bundle load and a `fetch` to the narrator server to
 * go live. `host.ts` itself never imports the mock.
 */
import type { ToWorker } from "@crew/sim";
import { createHost } from "./host";
import { MOCK_CONFIG, MOCK_CONTENT_BUNDLE, mockDecisionCard, mockKernel } from "./mockKernel";
import { mockNarrator } from "./mockNarrator";

declare const self: DedicatedWorkerGlobalScope;

const host = createHost({
  kernel: mockKernel,
  content: MOCK_CONTENT_BUNDLE,
  config: MOCK_CONFIG,
  postMessage: (message) => self.postMessage(message),
  narrator: (hook) => mockNarrator(hook, mockDecisionCard),
});

self.onmessage = (event: MessageEvent<ToWorker>) => {
  host.handleMessage(event.data);
};
