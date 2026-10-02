import { describe, expect, it } from "vitest";
import { buildCapabilities } from "./capabilities";
import { quietTooLongRequest } from "./fixtures";
import { content } from "./test-support";

describe("buildCapabilities", () => {
  const req = quietTooLongRequest(content());
  const text = buildCapabilities(req.snapshot.state, content(), req.snapshot.config);

  it("lists every machine that has a fault catalog, with exactly its fault keys", () => {
    for (const machine of Object.values(req.snapshot.state.machines)) {
      const def = content().machines[machine.defId];
      const listed = text.includes(`machine ${machine.id} `);
      expect(listed).toBe((def?.faults.length ?? 0) > 0);
      for (const fault of def?.faults ?? []) {
        expect(text).toContain(`faultKey ${fault.key} "${fault.name}"`);
      }
    }
  });

  it("lists every port with its routes and stores, and every freight item", () => {
    for (const port of Object.values(content().ports)) {
      expect(text).toContain(`- ${port.id} "${port.name}"`);
      for (const route of port.routes) expect(text).toContain(route.toPortId);
      for (const store of port.externalStores)
        expect(text).toContain(`${store.key} (${store.kind})`);
    }
    for (const item of Object.values(content().items)) {
      expect(text.includes(`- ${item.id} "`)).toBe(item.cargoClass !== undefined);
    }
  });

  it("derives fault windows and spawn limits from config", () => {
    const max = req.snapshot.config.narrator.maxFaultWindowSeconds;
    expect(text).toContain(`muchLater (${Math.round((2 * max) / 3)}s-${Math.round(max)}s)`);
    expect(text).toContain(
      `at most ${req.snapshot.config.narrator.maxSpawnsPerCommand} per command`,
    );
  });

  it("names exactly the five narrator levers (D47 added stockMarket)", () => {
    const levers = [...text.matchAll(/^## \d\. (\w+)/gm)].map((m) => m[1]);
    expect(levers).toEqual([
      "offerJob",
      "spawnAtBoundary",
      "scheduleFault",
      "surfaceDecision",
      "stockMarket",
    ]);
    expect(text).toContain("You have exactly five levers");
  });

  it("lists each port's market as items, counts and price tier words, no prices (D47)", () => {
    for (const port of Object.values(content().ports)) {
      for (const line of port.market) {
        const name = content().items[line.itemDefId]?.name ?? "";
        const entry = `${line.itemDefId} "${name}" x${line.count} (fair)`;
        expect(text.includes(entry)).toBe(line.count > 0);
        expect(text).not.toContain(`${line.price} cr`);
      }
    }
    expect(text).toContain("The crew buy what a stalled repair needs themselves");
  });
});
