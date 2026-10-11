import { FIELD_SEVERITIES, HAZARD_KINDS, isSite } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { buildCapabilities, fieldExpectation } from "./capabilities";
import {
  captainAshoreRequest,
  farCaptainAshoreRequest,
  quietTooLongRequest,
  siteArrivalRequest,
} from "./fixtures";
import { isArmsLocker, pathBetween, routeDistance } from "./lookups";
import { content } from "./test-support";

/** The ports the narrator lists as ports: every port but a landing site. */
const ports = () => Object.values(content().ports).filter((p) => !isSite(content(), p.id));
/** Expeditions A2: the landing sites, listed under "Sites". */
const sites = () => Object.values(content().ports).filter((p) => isSite(content(), p.id));

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

  it("lists every port with its routes and stores, and every freight item; a landing site only under Sites (expeditions A2)", () => {
    const galaxy = text.slice(text.indexOf("## The galaxy"), text.indexOf("## Sites"));
    for (const site of sites()) expect(galaxy).not.toContain(site.id);
    expect(ports()).toHaveLength(6);
    for (const port of ports()) {
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

  it("says under stockMarket that provisions are an item it may stock, by id (§galley-provisions)", () => {
    const stock = text.split("## 5. stockMarket")[1]?.split("## 6.")[0] ?? "";
    expect(stock).toContain(
      "- Provisions are an item like any other (item.provisions): stock them where the galley should restock",
    );
  });

  it("derives fault windows and spawn limits from config", () => {
    const max = req.snapshot.config.narrator.maxFaultWindowSeconds;
    expect(text).toContain(`muchLater (${Math.round((2 * max) / 3)}s-${Math.round(max)}s)`);
    expect(text).toContain(
      `at most ${req.snapshot.config.narrator.maxSpawnsPerCommand} per command`,
    );
  });

  it("names exactly the seven narrator levers (stockMarket §market-lever, scheduleHazard §hazard-and-field-levers, scheduleField §scheduling-a-field)", () => {
    const levers = [...text.matchAll(/^## \d\. (\w+)/gm)].map((m) => m[1]);
    expect(levers).toEqual([
      "offerJob",
      "spawnAtBoundary",
      "scheduleFault",
      "surfaceDecision",
      "stockMarket",
      "scheduleHazard",
      "scheduleField",
    ]);
    expect(text).toContain("You have exactly seven levers");
    expect(text).not.toContain("six levers");
  });

  it("documents scheduleHazard: kinds, tiers and windows from config, the budget, and that the sim rolls it (§hazard-and-field-levers)", () => {
    const config = req.snapshot.config;
    expect(text).toContain(
      "## 6. scheduleHazard: a navigation hazard on the leg under way, a piloting check for whoever has the helm",
    );
    for (const kind of HAZARD_KINDS) expect(text).toContain(`${kind} (`);
    const { easy, hard, brutal } = config.hazards.difficulty;
    expect(text).toContain(`difficulty: easy (${easy}), hard (${hard}), brutal (${brutal})`);
    const max = config.narrator.maxFaultWindowSeconds;
    expect(
      text.match(
        new RegExp(`muchLater \\(${Math.round((2 * max) / 3)}s-${Math.round(max)}s\\)`, "g"),
      ),
    ).toHaveLength(2);
    expect(text).toContain("Uses one hazard from the budget in the digest.");
    expect(text).toContain("One hazard waits at a time.");
    expect(text).toContain(
      "The sim rolls it against whoever has the helm when it goes off, never you",
    );
    expect(text).toContain(`about ${Math.round(config.hazards.delaySeconds)}s lost on the leg`);
    expect(text).toContain("With nobody at the helm it is a scrape and a delay both.");
  });

  it("documents scheduleField: severities priced from config, detection, scripted hits, the guard, one per leg (§scheduling-a-field)", () => {
    const config = req.snapshot.config;
    const lever = text.split("## 7. scheduleField")[1] ?? "";
    expect(lever).toContain(": an asteroid field on the leg, rocks that hit the ship");
    for (const severity of FIELD_SEVERITIES) {
      const e = fieldExpectation(config, severity);
      expect(lever).toContain(
        `${severity} (~${Math.round(e.rocks)} rocks over ${e.seconds}s, ~${Math.round(e.hull)} hull points)`,
      );
    }
    // The default config: 2/min over 90 s at a 10% large share of 3- and 8-point rocks.
    expect(lever).toContain("light (~3 rocks over 90s, ~11 hull points)");
    expect(lever).toContain(`check ${config.field.warningSeconds}s before it`);
    expect(lever).toContain("unseen (no warning whatever the helm does");
    expect(lever).toContain(`up to ${config.field.maxScripted} hits you choose`);
    expect(lever).toContain("at (early | middle | late in the field)");
    expect(lever).toContain("(none | graze | damage | knockout | fault, or empty to roll)");
    expect(lever).toContain("Never a person: nobody can be hurt yet");
    expect(lever).toContain("Scripted hits alone must leave the hull above zero");
    expect(lever).toContain("One field per leg, no budget");
    expect(lever).toContain("leaving with repairs unfinished is a story");
    // The hazard lever says the two hazard kinds are one check and points fields at lever 7.
    expect(text).toContain("debrisField and ionStorm are the same check");
  });

  it("lists every room aboard with its machines by id, as scripted targets (§scheduling-a-field)", () => {
    const lever = text.split("## 7. scheduleField")[1] ?? "";
    const deckId = Object.keys(req.snapshot.state.deck.tiles)[0];
    const deck = Object.values(content().decks).find((d) => d.id === deckId);
    for (const room of deck?.compartments ?? []) expect(lever).toContain(`  - "${room.name}": `);
    for (const machine of Object.values(req.snapshot.state.machines)) {
      // Expeditions A1 (call 4): the arms locker is the one machine the narrator does not see.
      const listed = !isArmsLocker(content(), machine);
      expect(new RegExp(`[:,] ${machine.id} `).test(lever), machine.id).toBe(listed);
    }
    expect(lever).toContain('  - "Galley": ');
  });

  it("lists every port's character, legs and distance from the port the ship is heading for (§2.4)", () => {
    // The fixture is in transit Hub -> Green Meridian, so "here" is Green Meridian.
    expect(text).toContain('"From here" is measured from port.green_meridian (Green Meridian)');
    for (const port of ports()) {
      expect(text).toContain(`  character: ${port.character}`);
      for (const route of port.routes)
        expect(text).toContain(`${route.toPortId} (${route.distance}s transit)`);
    }
    const reach = Object.fromEntries(
      [...text.matchAll(/^- (port\.\w+) ".*\n.*\n {2}from here: (.*)$/gm)].map((m) => [m[1], m[2]]),
    );
    // Distances come from content (spur legs are a watch long, §the-ships-day); the topology is
    // pinned.
    const far = (to: string) =>
      pathBetween(content(), req.snapshot.state, "port.green_meridian", to)?.distance;
    expect(reach).toEqual({
      "port.crossroads_hub": `1 hop, ${far("port.crossroads_hub")}s transit in all`,
      "port.green_meridian": "here (the ship is at or heading for this port)",
      "port.kessler_drift": `1 hop, ${far("port.kessler_drift")}s transit in all`,
      "port.ossory_station": `2 hops, ${far("port.ossory_station")}s transit in all via port.kessler_drift`,
      "port.terns_rest": `2 hops, ${far("port.terns_rest")}s transit in all via port.crossroads_hub`,
      "port.vesper_gate": `1 hop, ${far("port.vesper_gate")}s transit in all`,
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
    expect(text).toContain(
      "## 1. offerJob: a freight contract, a passenger, or an errand to a site",
    );
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
    expect(text).toContain("endPassage; or privateTalk");
    expect(text).toContain("endPassage puts the current passenger off");
    expect(text).toContain("They leave at the next docking (now, if docked) with no fare");
    expect(text).toContain("stay at that port as someone in your cast");
    // Expeditions A2 (v0.30): a captive put off fails the errand.
    expect(text).toContain("putting them off fails the errand: it pays nothing");
    expect(text).toContain("The sim raises its own card, brought by the first officer");
    expect(text).toContain("Wait for them / Leave without them");
    expect(text).toContain("you never cause it");
  });

  it("documents privateTalk as a card side effect, warm or stern, and not as a lever (§private-talk)", () => {
    expect(text).toContain("endPassage; or privateTalk");
    expect(text).toContain("privateTalk is a private word in the captain's cabin, warm or stern");
    expect(text).toContain("the talk moves how they feel about the captain");
    expect(text).toContain("never the captain herself, a passenger or someone ashore");
    expect(text).toContain("You have exactly seven levers.");
    expect(text.match(/^## \d\. /gm)).toHaveLength(7);
  });

  it("measures distance from the docked port when docked", () => {
    const req = captainAshoreRequest(content());
    const docked = buildCapabilities(req.snapshot.state, content(), req.snapshot.config);
    expect(docked).toContain('"From here" is measured from port.kessler_drift (Kessler Drift)');
    expect(docked).toContain('port.ossory_station "Ossory Station"');
    const leg = routeDistance(content(), "port.kessler_drift", "port.ossory_station");
    expect(docked).toMatch(
      new RegExp(
        `port\\.ossory_station "Ossory Station".*\\n.*\\n {2}from here: 1 hop, ${leg}s transit in all$`,
        "m",
      ),
    );
  });

  it("lists each port's market as items, counts and price tier words, no prices (§market-lever)", () => {
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

  it("points the hazard and field levers at the departure call (§requested-call-back)", () => {
    const sentence =
      "The departure call you ask for with callBack (when: departure) is the natural moment: the ship has just cast off and the whole leg is ahead.";
    const hazard = text.slice(text.indexOf("## 6. scheduleHazard"), text.indexOf("## 7."));
    const field = text.slice(text.indexOf("## 7. scheduleField"));
    expect(hazard).toContain(sentence);
    expect(field).toContain(sentence);
  });
});

describe("buildCapabilities: Sites and the errand (expeditions A2, §6, §10.2)", () => {
  const req = farCaptainAshoreRequest(content());
  const text = buildCapabilities(req.snapshot.state, content(), req.snapshot.config);
  const section = text.slice(text.indexOf("## Sites"), text.indexOf("## Cargo items"));

  it("lists every authored site once, under its near port, with its description, character and reach through the near port", () => {
    expect(sites().length).toBeGreaterThanOrEqual(2);
    for (const site of sites()) {
      expect(text.split(`  - ${site.id} "${site.name}": `)).toHaveLength(2);
      const entry = section.split(`  - ${site.id} "`)[1] ?? "";
      expect(entry).toContain(site.description);
      expect(entry).toContain(`    character: ${site.character}`);
      const near = site.nearPortId ?? "";
      const header = section.lastIndexOf("- near ", section.indexOf(`  - ${site.id} "`));
      expect(section.slice(header)).toMatch(new RegExp(`^- near ${near.replace(".", "\\.")} `));
    }
    // From the Hub, Harrow End is two hops through Green Meridian; the Boathouse through Tern's Rest.
    const there = pathBetween(
      content(),
      req.snapshot.state,
      "port.crossroads_hub",
      "port.harrow_end",
    );
    expect(section).toContain(
      `    from here: 2 hops, ${there?.distance}s transit in all via port.green_meridian`,
    );
    expect(section).toMatch(/from here: 2 hops, \d+s transit in all via port\.terns_rest/);
  });

  it("gives each site's default cast in words, the target by role only and never a number", () => {
    const boathouse = section.split('  - port.boathouse "')[1] ?? "";
    expect(boathouse).toContain(
      "    - the one a fetchPerson is after, under your targetName (else Corran Vale): boat-shed keeper, unarmed; grey, wiry, never still",
    );
    expect(boathouse).toContain("    - Hesk Marrow, hired hand, with a blaster;");
    expect(boathouse).toContain("    - Darrow Finch, the keeper's nephew, with a club;");
    expect(boathouse).toContain("    - Old Pell, net mender, a bystander, unarmed;");
    const castLines = section.split("\n").filter((line) => line.startsWith("    - "));
    expect(castLines.length).toBeGreaterThan(0);
    for (const line of castLines) expect(line).not.toMatch(/\d/);
    for (const tier of ["shaky", "steady", "devoted", "paid"]) {
      expect(castLines.join("\n")).not.toContain(` ${tier}`);
    }
  });

  it("says what an errand is on offerJob: its fields, toPort is the port the ship is at, the ship goes, the crew fight, it pays on the way back, a kill job is rare and dirty", () => {
    const offer = text.slice(text.indexOf("## 1. offerJob"), text.indexOf("## 2."));
    expect(offer).toContain("errandKind fetchPerson | fetchItem makes it an errand");
    expect(offer).toContain("toPort is fromPort, the port the ship is at");
    expect(offer).toContain("wants alive | either | dead is how");
    expect(offer).toContain("targetItem is an item id");
    expect(offer).toContain("the crew go out armed to whoever is there");
    expect(offer).toContain("once the ship is home with what it went for");
    expect(offer).toContain(
      "A kill job (wants dead) is rare, and whoever offers one is never clean: its target dies in the fight or, taken alive, is executed by the party at the scene.",
    );
    expect(offer).toContain("the arrival card (two plans for going in)");
    expect(offer).toContain("you never cause them");
    expect(offer).toContain("never a site");
  });

  it("measures from a site's near port while the ship is set down at one", () => {
    const at = siteArrivalRequest(content());
    const there = buildCapabilities(at.snapshot.state, content(), at.snapshot.config);
    expect(there).toContain(
      '"From here" is measured from port.green_meridian (Green Meridian), the near port of Harrow End, where the ship is set down or heading.',
    );
    expect(there).toContain('  - port.harrow_end "Harrow End": ');
    expect(there).toMatch(
      /port\.harrow_end "Harrow End".*\n.*\n {4}from here: 1 hop, 20s transit in all$/m,
    );
  });
});
