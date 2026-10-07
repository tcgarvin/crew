/**
 * The capability list (D11): exactly what the six narrator levers can do in this game,
 * generated from content, config and the ship's machines so the prompt never promises what the
 * sim cannot do. It sits in the cached system prefix: nearly all of it is fixed for a game, and
 * the parts that are not (each port's market, and since passengers-and-galaxy §2.4 the hop
 * count and distance of every port from the one the ship is at or heading for) change only
 * when the ship moves or the narrator restocks, so the cache still serves a run of calls.
 * Per-call limits (budgets) are in the digest.
 */
import {
  type ConfigDef,
  type ContentBundle,
  type FaultEffect,
  HAZARD_KINDS,
  JOB_URGENCIES,
  MARKET_PRICE_TIERS,
  type MarketPriceTier,
  basePriceFor,
  effectiveMarket,
} from "@crew/sim";
import { HAZARD_DIFFICULTIES } from "./contract";
import {
  JOB_QUANTITY_UNITS,
  SPAWN_QUANTITY_UNITS,
  type State,
  faultWindowSeconds,
  itemName,
  machineCompartment,
  machineName,
  pathBetween,
  portHereOrNext,
} from "./lookups";
import { HAZARD_NAMES } from "./watch-digest";

function effectText(effect: FaultEffect): string {
  switch (effect.kind) {
    case "inoperable":
      return "stops the machine";
    case "derate":
      return "reduces its output";
    case "overheat":
      return "makes it run hot";
  }
}

function humanKey(key: string): string {
  return key.replace(/_/g, " ");
}

function seconds(n: number): string {
  return `${Math.round(n)}s`;
}

/** D47: a live price as a tier word against the content price, never a number. */
function priceTierWord(price: number, base: number, config: ConfigDef): MarketPriceTier {
  const tiers = config.commerce.market.priceTiers;
  let best: MarketPriceTier = "fair";
  let gap = Number.POSITIVE_INFINITY;
  for (const tier of MARKET_PRICE_TIERS) {
    const d = Math.abs(price - base * tiers[tier]);
    if (d < gap) {
      gap = d;
      best = tier;
    }
  }
  return best;
}

/** D47: one port's market, item by item: "item.x "Name" x4 (fair)"; "nothing" when empty. */
export function marketLine(
  state: State,
  content: ContentBundle,
  config: ConfigDef,
  portId: keyof ContentBundle["ports"],
): string {
  const stock = effectiveMarket(state, content, portId);
  const lines = Object.entries(stock)
    .filter(([, line]) => line.count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([itemDefId, line]) => {
      const name = itemName(content, itemDefId);
      const base = basePriceFor(content, config, portId, itemDefId as keyof ContentBundle["items"]);
      return `${itemDefId} "${name}" x${line.count} (${priceTierWord(line.price, base, config)})`;
    });
  return lines.length === 0 ? "nothing" : lines.join(", ");
}

/**
 * §2.4: where a port stands from the ship: "here", or its hop count and path distance from the
 * port the ship is at or heading for, naming the waypoints of a multi-hop path.
 */
function reachLine(content: ContentBundle, hereId: string, portId: string): string {
  if (portId === hereId) return "here (the ship is at or heading for this port)";
  const path = pathBetween(content, hereId, portId);
  if (path === undefined) return "unreachable from here";
  const legs = path.hops === 1 ? "1 hop" : `${path.hops} hops`;
  const via = path.path.slice(1, -1);
  const stops = via.length === 0 ? "" : ` via ${via.join(", ")}`;
  return `${legs}, ${seconds(path.distance)} transit in all${stops}`;
}

/** D78: the sixth lever, with its kinds, tiers and windows from config. */
function hazardLever(config: ConfigDef): string[] {
  const windows = faultWindowSeconds(config);
  const tiers = HAZARD_DIFFICULTIES.map((t) => `${t} (${config.hazards.difficulty[t]})`).join(", ");
  return [
    "## 6. scheduleHazard: a navigation hazard on the leg under way, a piloting check for whoever has the helm",
    `- hazard: ${HAZARD_KINDS.map((k) => `${k} (${HAZARD_NAMES[k]})`).join(", ")}. Both are the same check; pick the one that fits the leg and the story.`,
    `- difficulty: ${tiers}: the piloting it is rolled against, on the 1-10 scale of "good at: piloting" under Crew. A pilot at or above it usually comes through clean; well below it, usually not.`,
    `- window: soon (${seconds(windows.soon[0])}-${seconds(windows.soon[1])}), later (${seconds(windows.later[0])}-${seconds(windows.later[1])}), muchLater (${seconds(windows.muchLater[0])}-${seconds(windows.muchLater[1])}) from now. It goes off at the first moment the ship is in transit at or after that, so one placed while docked with a course set waits for that leg's transit.`,
    "- Only while a course is set or the ship is under way, and only on a leg with transit left: dropped while docked with no course, on approach or docking, or when the window opens after this leg's transit ends. One hazard waits at a time. Uses one hazard from the budget in the digest.",
    `- The sim rolls it against whoever has the helm when it goes off, never you: clean (nothing happens), a scrape (one of the ship's machines takes a fault, which the crew must find and repair like any other), or a delay (about ${seconds(config.hazards.delaySeconds)} lost on the leg). With nobody at the helm it is a scrape and a delay both. The next digest shows who was at the helm and how it went.`,
  ];
}

export function buildCapabilities(state: State, content: ContentBundle, config: ConfigDef): string {
  const ports = Object.values(content.ports).sort((a, b) => a.id.localeCompare(b.id));
  const here = portHereOrNext(state);
  const cargo = Object.values(content.items)
    .filter((i) => i.cargoClass !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
  const machines = Object.values(state.machines)
    .filter((m) => (content.machines[m.defId]?.faults.length ?? 0) > 0)
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  const windows = faultWindowSeconds(config);
  const q = (units: Record<string, number>) =>
    Object.entries(units)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");

  const lines: string[] = [];
  lines.push("# What you can do");
  lines.push(
    "You have exactly six levers. Anything not listed here does not exist in this game yet: no combat, no injuries, no direct changes to money, needs, moods or positions, no messages, no new places.",
  );
  lines.push(
    "The ids below (ports, store keys, cargo items, machines, faultKeys) are the only ones the plan may use; copy them exactly.",
  );
  lines.push("");
  lines.push("## The galaxy: ports and legs");
  lines.push(
    `${ports.length} ports joined by legs; a leg's transit time is listed with it. Any port is a possible destination for an offer or a course: beyond one hop the ship makes a voyage of it, docking at each port on the way (a real stop: the fee is paid, the ramps open, the market is open, and the dock is dressed as she comes alongside) and continuing on its own when nothing holds her. The long legs are where the far ports are, and where the quiet in-transit stretches happen. "From here" is measured from ${here} (${content.ports[here]?.name ?? here}), the port the ship is at or heading for.`,
  );
  for (const port of ports) {
    const routes = port.routes
      .map((r) => `${r.toPortId} (${seconds(r.distance)} transit)`)
      .join(", ");
    const stores = port.externalStores.map((s) => `${s.key} (${s.kind})`).join(", ");
    lines.push(`- ${port.id} "${port.name}": ${port.description}`);
    lines.push(`  character: ${port.character}`);
    lines.push(`  from here: ${reachLine(content, here, port.id)}`);
    lines.push(`  legs to: ${routes || "none"}; store keys: ${stores || "none"}`);
    lines.push(`  market sells: ${marketLine(state, content, config, port.id)}`);
  }
  lines.push("");
  lines.push("## Cargo items and classes");
  for (const item of cargo) {
    lines.push(`- ${item.id} "${item.name}" (class ${item.cargoClass})`);
  }
  lines.push("");
  lines.push("## 1. offerJob: a freight contract, or a passenger");
  lines.push(
    '- fromPort must be the port the ship is docked at (see the digest): offers are made in person at the dock, never in flight. toPort may be any port reachable from fromPort (see "from here" above); a far port means a voyage with real stops on the way, which the ship routes by itself.',
  );
  lines.push(`- One cargo item kind per job. quantity: ${q(JOB_QUANTITY_UNITS)} units.`);
  lines.push(
    "- payTier low | standard | generous is a private lever: it places the pay inside the class price band for the route and the engine computes it. No text ever mentions pay.",
  );
  lines.push(
    `- issuerName, issuerRole and issuerOrg (or empty) name the one person offering it; pitch is one line they say to the captain. urgency ${JOB_URGENCIES.join(" | ")} colours the card only; nothing enforces a deadline.`,
  );
  lines.push(
    "- surface=true puts it to the captain as an accept/decline card (counts as this call's one card), which comes up when the captain meets the issuer: on the dock, beyond the gate, or at the foot of the ramp. surface=false posts it quietly on the port board. One offer per call.",
  );
  lines.push(
    "- passenger=true makes it a passage: the issuer rides. They board at fromPort when the job is accepted, live aboard like crew (eat, sleep, walk the deck, talk) and never work; cargoItem is their luggage (one unit of a cargo item, hauled like freight) or empty for none, and quantity is ignored. roundTrip=true (passenger only) takes them to toPort, where they go ashore for a while and the ship waits for them, then home to fromPort; roundTrip without passenger is dropped. The fare is private, by distance (doubled for a round trip), placed by payTier. A passenger offer is always surfaced: it is a person at the ramp. The ship carries one job at a time, so a passenger competes with freight for the ship: any offerJob while a job is in hand (accepted, under way, or delivered and not yet paid) is dropped, and a port that is a waypoint of a voyage gets no offer. A passenger offer whose card is already taken this call is dropped, not posted quietly. The sim raises its own card, brought by the first officer, if a round-trip passenger is overdue ashore (Wait for them / Leave without them); you dress it on that policyDecision call, you never cause it.",
  );
  lines.push("");
  lines.push("## 2. spawnAtBoundary: put existing items into a port store, off the ship");
  lines.push(
    `- Only into a port store listed above, never aboard. quantity: ${q(SPAWN_QUANTITY_UNITS)}, at most ${config.narrator.maxSpawnsPerCommand} per command. Uses one spawn from the budget in the digest.`,
  );
  lines.push("- Only existing cargo items; new item kinds are not available yet.");
  lines.push("");
  lines.push(
    "## 3. scheduleFault: a machine develops one of its own faults at a moment the engine picks",
  );
  lines.push(
    `- window: soon (${seconds(windows.soon[0])}-${seconds(windows.soon[1])}), later (${seconds(windows.later[0])}-${seconds(windows.later[1])}), muchLater (${seconds(windows.muchLater[0])}-${seconds(windows.muchLater[1])}) from now. Uses one fault from the budget in the digest.`,
  );
  lines.push(
    "- Not on a machine that already has or is already scheduled for that fault. The crew must notice, diagnose and repair it themselves; you do not control who or when.",
  );
  if (machines.length === 0) {
    lines.push("- No machine aboard has a fault catalog, so this lever is unavailable.");
  }
  for (const machine of machines) {
    const def = content.machines[machine.defId];
    if (def === undefined) continue;
    const where = machineCompartment(content, machine);
    lines.push(
      `- machine ${machine.id} "${machineName(content, machine)}"${where ? ` in ${where}` : ""}:`,
    );
    for (const fault of def.faults) {
      lines.push(
        `  - faultKey ${fault.key} "${fault.name}": ${effectText(fault.effect)}; first sign is ${fault.symptom.channel === "audible" ? "an" : "a"} ${fault.symptom.channel} symptom (${humanKey(fault.symptom.key)})`,
      );
    }
  }
  lines.push("");
  lines.push("## 4. surfaceDecision: a binary card for the captain");
  lines.push(
    "- Each side has a label and an effect: none; setCourse to coursePort (only while docked, to any port reachable from here); endPassage; or privateTalk. While the ship is on a voyage, setCourse to a neighbouring port is a detour: the voyage destination stays and the ship routes on from wherever it ends up. Use it only when the story makes the route a captain's choice; otherwise the ship picks its own way. The crew carry out the choice; you do not script outcomes.",
  );
  lines.push(
    '- endPassage puts the current passenger off: valid only while a passenger is aboard or ashore on a live passage (see "Aboard" under Crew). They leave at the next docking (now, if docked) with no fare and stay at that port as someone in your cast. That is the real side of a crew-friction card ("Put him off at Kessler." / "He stays."); the sim does the rest.',
  );
  // D86: a side effect of a card, not a seventh lever.
  lines.push(
    '- privateTalk is a private word in the captain\'s cabin, warm or stern (tone warm | stern), with the crew member named in talkWith (their full name as "Crew" lists it): the crew member walks there and the talk moves how they feel about the captain, which shows next call ("close to" / "at odds with", their mood). Only crew aboard, never the captain herself, a passenger or someone ashore, and one talk at a time. It is the real side of a card about someone\'s conduct ("Send Jax up." / "Let it go."); the crew carry it out, and whether it lands is the sim\'s.',
  );
  lines.push(
    "- At most one card per call (a surfaced job counts). No new cards on a policyDecision hook: dress the existing one instead.",
  );
  lines.push(
    "- leftAftermath / rightAftermath: what happens next on each side, shown to the captain for a moment after the choice.",
  );
  lines.push("");
  lines.push("## 5. stockMarket: set what a port's market sells of one item");
  lines.push(
    `- port and cargoItem (any item id, including item ids not listed as cargo above, e.g. spare parts), count 0-${config.commerce.market.maxStockPerCommand} units on sale after this (0 withdraws it), priceTier ${MARKET_PRICE_TIERS.join(" | ")} against the port's usual price. The market line under each port above is what is on sale now.`,
  );
  lines.push(
    "- This is the only way a part reaches a port. The crew buy what a stalled repair needs themselves, from the ship's money, while docked there; you never buy, deliver, repair or pay. Stock a port the ship is at to make a part available now, another port to make the story go there, or set 0 to make it scarce.",
  );
  // D81: the galley's stores are bought like parts; name them by id so the model can stock them.
  const provisions = Object.values(content.items)
    .filter((def) => def.tags.includes("provisions"))
    .map((def) => def.id)
    .sort();
  if (provisions.length > 0) {
    lines.push(
      `- Provisions are an item like any other (${provisions.join(", ")}): stock them where the galley should restock, or withdraw them to make a port go hungry; the crew buy them themselves when the galley runs low.`,
    );
  }
  lines.push("");
  lines.push(...hazardLever(config));
  return lines.join("\n");
}
