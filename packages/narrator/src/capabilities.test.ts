import { describe, expect, it } from "vitest";
import { buildCapabilities } from "./capabilities";
import { jobBoardRequest, quietTooLongRequest } from "./fixtures";
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

  it("says one job at a time: an offer with a job in hand is dropped, a passenger offer never goes quiet", () => {
    expect(text).toContain(
      "any offerJob while a job is in hand (accepted, under way, or delivered and not yet paid) is dropped",
    );
    expect(text).toContain("a port that is a waypoint of a voyage gets no offer");
    expect(text).toContain(
      "A passenger offer whose card is already taken this call is dropped, not posted quietly",
    );
    expect(text).toContain("One offer per call.");
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

  it("lists every port's character, legs and distance from the port the ship is heading for (§2.4)", () => {
    // The fixture is in transit Hub -> Green Meridian, so "here" is Green Meridian.
    expect(text).toContain('"From here" is measured from port.green_meridian (Green Meridian)');
    for (const port of Object.values(content().ports)) {
      expect(text).toContain(`  character: ${port.character}`);
      for (const route of port.routes)
        expect(text).toContain(`${route.toPortId} (${route.distance}s transit)`);
    }
    const reach = Object.fromEntries(
      [...text.matchAll(/^- (port\.\w+) ".*\n.*\n {2}from here: (.*)$/gm)].map((m) => [m[1], m[2]]),
    );
    expect(reach).toEqual({
      "port.crossroads_hub": "1 hop, 45s transit in all",
      "port.green_meridian": "here (the ship is at or heading for this port)",
      "port.kessler_drift": "1 hop, 70s transit in all",
      "port.ossory_station": "2 hops, 190s transit in all via port.kessler_drift",
      "port.terns_rest": "2 hops, 135s transit in all via port.crossroads_hub",
      "port.vesper_gate": "1 hop, 120s transit in all",
    });
  });

  it("explains voyages, waypoints and detours (§2.3)", () => {
    expect(text).toContain("toPort may be any port reachable from fromPort");
    expect(text).toContain("docking at each port on the way (a real stop");
    expect(text).toContain("setCourse to a neighbouring port is a detour");
    expect(text).not.toContain("passengers and new item kinds are not available yet");
    expect(text).not.toContain("on a route from");
  });

  it("documents passenger and roundTrip on offerJob: the issuer rides, luggage, fare by distance, one job at a time (§4.1)", () => {
    expect(text).toContain("## 1. offerJob: a freight contract, or a passenger");
    expect(text).toContain("passenger=true makes it a passage: the issuer rides");
    expect(text).toContain("cargoItem is their luggage");
    expect(text).toContain("or empty for none");
    expect(text).toContain("roundTrip without passenger is dropped");
    expect(text).toContain("by distance (doubled for a round trip)");
    expect(text).toContain("A passenger offer is always surfaced");
    expect(text).toContain("a passenger competes with freight for the ship");
  });

  it("documents endPassage on a card side and that the sim raises the overdue card itself (§4.2, §3.3)", () => {
    expect(text).toContain("effect: none; setCourse to coursePort");
    expect(text).toContain("or endPassage");
    expect(text).toContain("endPassage puts the current passenger off");
    expect(text).toContain("They leave at the next docking (now, if docked) with no fare");
    expect(text).toContain("stay at that port as someone in your cast");
    expect(text).toContain("The sim raises its own card, brought by the first officer");
    expect(text).toContain("Wait for them / Leave without them");
    expect(text).toContain("you never cause it");
  });

  it("measures distance from the docked port when docked", () => {
    const req = jobBoardRequest(content());
    const docked = buildCapabilities(req.snapshot.state, content(), req.snapshot.config);
    expect(docked).toContain('"From here" is measured from port.kessler_drift (Kessler Drift)');
    expect(docked).toContain('port.ossory_station "Ossory Station"');
    expect(docked).toMatch(
      /port\.ossory_station "Ossory Station".*\n.*\n {2}from here: 1 hop, 120s transit in all$/m,
    );
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
