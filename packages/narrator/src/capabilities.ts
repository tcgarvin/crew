/**
 * The capability list (§narrator-authority): exactly what the ten narrator levers can do in this
 * game, generated from content, config and the ship's machines so the prompt never promises what
 * the sim cannot do. It sits in the cached system prefix: nearly all of it is fixed for a game, and
 * the parts that are not (each port's market, and since passengers-and-galaxy §2.4 the hop
 * count and distance of every port, and since expeditions A2 of every landing site, from the one
 * the ship is at or heading for, or that site's near port) change only when the ship moves or the
 * narrator restocks, so the cache still serves a run of calls. Per-call limits (budgets) are in
 * the digest.
 */
import {
  BODY_PARTS,
  type CastArms,
  type ConfigDef,
  type ContentBundle,
  DAMAGE_TYPES,
  ERRAND_KINDS,
  ERRAND_WANTS,
  FIELD_SEVERITIES,
  type FaultEffect,
  type FieldSeverity,
  HAZARD_KINDS,
  JOB_URGENCIES,
  MARKET_PRICE_TIERS,
  type MarketPriceTier,
  type PortDef,
  type PortDefId,
  type SiteCastEntryDef,
  WOUND_SEVERITIES,
  basePriceFor,
  dockForPort,
  effectiveMarket,
  isSite,
  siteNearPort,
} from "@crew/sim";
import { FIELD_MOMENTS, HAZARD_DIFFICULTIES, SCRIPTED_EFFECTS } from "./contract";
import {
  JOB_QUANTITY_UNITS,
  SPAWN_QUANTITY_UNITS,
  type State,
  faultWindowSeconds,
  isArmsLocker,
  itemName,
  machineCompartment,
  machineName,
  pathBetween,
  portHereOrNext,
  reachFrom,
  shipDeckOf,
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

/** §market-lever: a live price as a tier word against the content price, never a number. */
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

/**
 * §market-lever: one port's market, item by item: "item.x "Name" x4 (fair)"; "nothing" when empty.
 */
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
function reachLine(content: ContentBundle, state: State, hereId: string, portId: string): string {
  if (portId === hereId) return "here (the ship is at or heading for this port)";
  const path = pathBetween(content, state, hereId, portId);
  if (path === undefined) return "unreachable from here";
  const legs = path.hops === 1 ? "1 hop" : `${path.hops} hops`;
  const via = path.path.slice(1, -1);
  const stops = via.length === 0 ? "" : ` via ${via.join(", ")}`;
  return `${legs}, ${seconds(path.distance)} transit in all${stops}`;
}

/** §6: how a cast member is armed, in words. */
const ARMS_WORDS: Readonly<Record<CastArms, string>> = {
  none: "unarmed",
  melee: "with a club",
  blaster: "with a blaster",
};

/**
 * Expeditions A2 (§5.3): one person of a site's default cast in words: who they are, how they look
 * and what they carry; the target by role only, since the errand's targetName becomes their name.
 * Never a tier or a number: the fight is the sim's.
 */
function castWords(entry: SiteCastEntryDef): string {
  const arms = ARMS_WORDS[entry.arms];
  switch (entry.part) {
    case "target":
      return `the one a fetchPerson is after, under your targetName (else ${entry.name}): ${entry.role}, ${arms}; ${entry.look}`;
    case "guard":
      return `${entry.name}, ${entry.role}, ${arms}; ${entry.look}`;
    case "ally":
      return `${entry.name}, ${entry.role}, ${arms}, who would side with the crew; ${entry.look}`;
    case "bystander":
      return `${entry.name}, ${entry.role}, a bystander, ${arms}; ${entry.look}`;
  }
}

/**
 * Expeditions A2 (§3.1, §10.2): "Sites": every authored landing site under its near port, with its
 * description, character, how far it is from here through the near port, and who is there by
 * default. Near ports in id order, each site once.
 */
function sitesSection(state: State, content: ContentBundle, here: string): string[] {
  const sites = Object.values(content.ports)
    .filter((p) => isSite(content, p.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const byNear = new Map<string, PortDef[]>();
  for (const site of sites) {
    const near = siteNearPort(content, site.id);
    if (near === undefined) continue;
    byNear.set(near, [...(byNear.get(near) ?? []), site]);
  }
  const lines = [
    "## Sites: where an errand goes",
    "A landing site is not a port: nobody there sells, buys or offers work, and no freight, passage or card's course goes to one. The ship goes to a site only for an errand (errandKind on offerJob, below) and sets down on open ground there, one leg past its near port; the crew go out to whoever is waiting. Listed under each site's near port, with how far it is from here through that port.",
  ];
  for (const [near, atNear] of [...byNear].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- near ${near} (${content.ports[near as PortDefId]?.name ?? near}):`);
    for (const site of atNear) {
      const cast = dockForPort(content, site.id)?.defaultCast ?? [];
      lines.push(`  - ${site.id} "${site.name}": ${site.description}`);
      lines.push(`    character: ${site.character}`);
      lines.push(`    from here: ${reachLine(content, state, here, site.id)}`);
      lines.push(`    who is there: ${cast.length === 0 ? "nobody" : ""}`.trimEnd());
      for (const entry of cast) lines.push(`    - ${castWords(entry)}`);
    }
  }
  return lines;
}

/** §hazard-and-field-levers: the sixth lever, with its kinds, tiers and windows from config. */
function hazardLever(config: ConfigDef): string[] {
  const windows = faultWindowSeconds(config);
  const tiers = HAZARD_DIFFICULTIES.map((t) => `${t} (${config.hazards.difficulty[t]})`).join(", ");
  return [
    "## 6. scheduleHazard: a navigation hazard on the leg under way, a piloting check for whoever has the helm",
    `- hazard: ${HAZARD_KINDS.map((k) => `${k} (${HAZARD_NAMES[k]})`).join(", ")}. debrisField and ionStorm are the same check; pick the one that fits the leg and the story. An asteroid field is not a hazard: it is scheduleField (7).`,
    `- difficulty: ${tiers}: the piloting it is rolled against, on the 1-10 scale of "good at: piloting" under Crew. A pilot at or above it usually comes through clean; well below it, usually not.`,
    `- window: soon (${seconds(windows.soon[0])}-${seconds(windows.soon[1])}), later (${seconds(windows.later[0])}-${seconds(windows.later[1])}), muchLater (${seconds(windows.muchLater[0])}-${seconds(windows.muchLater[1])}) from now. It goes off at the first moment the ship is in transit at or after that, so one placed while docked with a course set waits for that leg's transit.`,
    "- Only while a course is set or the ship is under way, and only on a leg with transit left: dropped while docked with no course, on approach or docking, or when the window opens after this leg's transit ends. The departure call you ask for with callBack (when: departure) is the natural moment: the ship has just cast off and the whole leg is ahead. One hazard waits at a time. Uses one hazard from the budget in the digest.",
    `- The sim rolls it against whoever has the helm when it goes off, never you: clean (nothing happens), a scrape (one of the ship's machines takes a fault, which the crew must find and repair like any other), or a delay (about ${seconds(config.hazards.delaySeconds)} lost on the leg). With nobody at the helm it is a scrape and a delay both. The next digest shows who was at the helm and how it went.`,
  ];
}

/**
 * §scheduling-a-field: what a field of each severity costs as it comes, before the helm: its rocks
 * (`impactsPerMinute` over `lengthSeconds`) and their hull points at the severity's large share.
 */
export function fieldExpectation(
  config: ConfigDef,
  severity: FieldSeverity,
): { readonly rocks: number; readonly hull: number; readonly seconds: number } {
  const s = config.field.severities[severity];
  const rocks = (s.impactsPerMinute * s.lengthSeconds) / 60;
  const perRock =
    config.field.hullDamage.small * (1 - s.largeShare) +
    config.field.hullDamage.large * s.largeShare;
  return { rocks, hull: rocks * perRock, seconds: s.lengthSeconds };
}

/** The helm's check tier for a field's severity (W1's detection: light/heavy/brutal). */
const FIELD_CHECK_TIER: Readonly<Record<FieldSeverity, (typeof HAZARD_DIFFICULTIES)[number]>> = {
  light: "easy",
  heavy: "hard",
  brutal: "brutal",
};

/**
 * §scheduling-a-field: the ship's rooms, each with its machines by id and name: what a scripted
 * impact may aim at. Rooms in deck order; a machine outside every room (none on the authored decks)
 * is left out.
 */
function targetLines(state: State, content: ContentBundle): string[] {
  const deckId = shipDeckOf(state);
  const deck = Object.values(content.decks).find((d) => d.id === deckId);
  if (deck === undefined) throw new Error(`capabilities: no deck def ${deckId}`);
  const byRoom = new Map<string, string[]>();
  const machines = Object.values(state.machines)
    // Expeditions A1 (call 4): the arms locker is not the narrator's until A2.
    .filter((m) => m.deckId === deckId && !isArmsLocker(content, m))
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  for (const machine of machines) {
    const room = machineCompartment(content, machine);
    if (room === undefined) continue;
    byRoom.set(room, [
      ...(byRoom.get(room) ?? []),
      `${machine.id} ${machineName(content, machine)}`,
    ]);
  }
  return deck.compartments.map(
    (c) => `  - "${c.name}": ${(byRoom.get(c.name) ?? []).join(", ") || "no machines"}`,
  );
}

/** The seventh lever, an asteroid field (§scheduling-a-field), from config and the ship's deck. */
function fieldLever(state: State, content: ContentBundle, config: ConfigDef): string[] {
  const f = config.field;
  const severities = FIELD_SEVERITIES.map((severity) => {
    const e = fieldExpectation(config, severity);
    return `${severity} (~${Math.round(e.rocks)} rocks over ${seconds(e.seconds)}, ~${Math.round(e.hull)} hull points)`;
  }).join(", ");
  const tiers = FIELD_SEVERITIES.map((s) => `${s} as ${FIELD_CHECK_TIER[s]}`).join(", ");
  const effects = SCRIPTED_EFFECTS.filter((e) => e !== "").join(" | ");
  return [
    "## 7. scheduleField: an asteroid field on the leg, rocks that hit the ship",
    `- severity: ${severities}, as it comes. The helm threads it: a pilot at the helm takes fewer rocks (up to ${Math.round(f.helmThreading * 100)}% fewer at piloting 10), an empty helm ${f.unmannedRateFactor}x as many. Against a hull of ${state.hull.max}, brutal can sink the ship.`,
    `- detection: rolled (whoever has the helm gets a piloting check ${seconds(f.warningSeconds)} before it, at the hazard tiers ${tiers}: pass, and they sight it, the ship goes on alert and braces; fail, or an empty helm, and nobody knows until the first rock) or unseen (no warning whatever the helm does: the first rock is the news).`,
    "- window: the same three windows as scheduleHazard. The field begins at the first moment the ship is in transit at or after it and lies along the leg for its length; one that would begin after this leg's transit ends is dropped.",
    `- The rocks are the sim's: they land anywhere on the deck with the same chance for every tile. A small rock hits one tile, a large one a 3x3; each costs the hull once (small ${f.hullDamage.small}, large ${f.hullDamage.large} points) and leaves a scar. Every machine under it rolls: glanced off, grazed, damaged (it runs derated), knocked out (stopped in one hit) or one of its own faults. Engines knocked out leave the ship stuck in the rocks, still being hit, until the engineers fix them or she drifts clear after ${f.stuckDriftImpacts} more rocks.`,
    `- scripted: up to ${f.maxScripted} hits you choose, to tell a story (the galley stove out before dinner, the engine knocked out on a long leg, the hold holed with the cargo in it). Each has target (a machine id or a room name from the list below), at (${FIELD_MOMENTS.join(" | ")} in the field), rock (small | large, or empty for the severity's draw) and effect on the machines it hits (${effects}, or empty to roll). A scripted hit takes the place of a random one, so the field is no heavier for it. Never a person (a name is dropped): to have a rock hurt someone, strike them (9) as well, and say so on the card. Scripted hits alone must leave the hull above zero (an empty rock is counted as large), or the field is dropped.`,
    "- One field per leg, no budget; only while a course is set or the ship is under way with transit left (dropped while docked with no course, on approach or docking). The departure call you ask for with callBack (when: departure) is the natural moment: the ship has just cast off and the whole leg is ahead. The hull is in the digest; at zero the ship is lost and the game ends.",
    "- What follows is the crew's: whoever sees damage reports it on the nearest intercom, the officer of the watch holds the bridge and sends someone to look, scars are patched underway with patch kits (half the damage back) and plated at a port that sells hull plating (the rest), and damaged machines are repaired. Nothing holds the ship in port for the hull; leaving with repairs unfinished is a story.",
    "- Rooms and their machines (scripted targets):",
    ...targetLines(state, content),
  ];
}

/**
 * D105: the eighth lever, the way in unseen on a site's arrival card. Not an intent: a field of the
 * card the narrator dresses, which the translator turns into `markUnseen`.
 */
const UNSEEN_LEVER: readonly string[] = [
  "## 8. card.unseen: the way in unseen, on a site's arrival card",
  "- Only on the policyDecision call for a site's arrival card (expedition.arrival): left or right names the side that gets in without the people there noticing; empty for neither, and empty on every other card.",
  "- If the captain picks that side, the party slips in unseen: nobody there notices them unless they fire first. If the captain picks the other side, the people there were waiting: they are on the party the moment it is on the ground. Empty leaves it to the sim, which rolls who notices and when.",
  "- Only when the story has set it up (a guard asleep, a back way, a friend inside, the people there looking the other way), never a side that holds the ramp (dropped), and never given away on the card: both sides read as plausible, a hint is fine, a tell is not. The captain still chooses and the sim fights the chosen side; you never choose the plan.",
];

/**
 * §strike-lever: the ninth lever, a wound, a down or a death by the body rules, in words from the
 * bodies config.
 */
function strikeLever(config: ConfigDef): string[] {
  const { tolerance, severityDamage } = config.bodies;
  const headKills = severityDamage.grave >= tolerance.head;
  return [
    "## 9. strike: wound, down or kill a person, by the body rules",
    "- who: the person's full name as the digest lists them (Crew, a passenger, someone on the dock, someone under At the site). byWho: who did it (a guard at the site, a crew member in a brawl), full name, or empty for an accident. Only someone alive and on the ship or the site floor: a passenger ashore, someone in a port's lounge or the dead are dropped.",
    `- severity: ${WOUND_SEVERITIES.join(" | ")}; type: ${DAMAGE_TYPES.join(" | ")} (stun knocks out, never kills); part: ${BODY_PARTS.join(" | ")}, or empty to let the body decide.`,
    `- What it does is the sim's body rules, never yours to state: a graze hurts and heals; a serious wound bleeds for a while, slows them and can put them down; a grave one ${headKills ? "to the head kills at once, and anywhere else" : "anywhere"} bleeds and can kill within minutes. You never write "dead": a grave head strike is how a death you have decided lands. Two strikes on one person in one call: the second may find them dead and be dropped.`,
    `- how: one line of what happened, as the ship's log shows it ("Jax Okonkwo falls from the hold ladder", "a crate shifts and pins Priya's leg"); no numbers. In the fight at a site the fight's own lines tell it ("Corran Vale is hit"), so it lands like any shot, with byWho a cast member. The crew react as to any wound: crewmates who see it take it with them (their mood), someone down stops where they are, and the dead stay on the deck.`,
    "- The captain is not special: they can be struck and killed like anyone, and the first officer takes command. A death is the strongest card you have; spend it rarely, and only when the story has walked toward it.",
  ];
}

/** §money-levers: the tenth lever, a sum into or out of the ship's money. */
function transactLever(config: ConfigDef): string[] {
  return [
    "## 10. transact: money into or out of the ship's money",
    `- amount: credits, positive into the ship's money (a reward, a windfall, a bribe taken, a fare paid in cash), negative out of it (a fine at the gate, a bribe paid, a debt called in, damages). Never 0. A debit more than the ship has ("money" under Ship, less this call's other debits) is dropped; a credit above ${config.narrator.maxWindfall} is dropped.`,
    `- memo: what it is for, a few words ("the gate fine", "for keeping quiet"); counterparty: who pays or is paid, full name, or empty. The ship's log shows them with the sum ("Paid Osei 200 cr: the gate fine"); a card still never states a sum, it says "it costs us".`,
    "- It happens when your plan is applied, not when a card is chosen: use it for what has been decided (the fine is levied, the reward is paid), and show it on a card from whoever paid or was paid.",
  ];
}

export function buildCapabilities(state: State, content: ContentBundle, config: ConfigDef): string {
  // Expeditions A2: landing sites are listed under "Sites", not with the ports.
  const ports = Object.values(content.ports)
    .filter((p) => !isSite(content, p.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const here = reachFrom(content, state);
  const shipAt = portHereOrNext(state);
  const measured = isSite(content, shipAt)
    ? `the near port of ${content.ports[shipAt]?.name ?? shipAt}, where the ship is set down or heading`
    : "the port the ship is at or heading for";
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
    "You have exactly ten levers. Anything not listed here does not exist in this game yet: no direct changes to needs, moods, who likes whom or where people are, no messages, no new places. A lever that cannot happen (a dead person struck, a debit the ship cannot pay, an id that does not exist) is dropped and you are told why next call.",
  );
  lines.push(
    "The ids below (ports, sites, store keys, cargo items, machines, faultKeys) are the only ones the plan may use; copy them exactly.",
  );
  lines.push("");
  lines.push("## The galaxy: ports and legs");
  lines.push(
    `${ports.length} ports joined by legs; a leg's transit time is listed with it. Any port is a possible destination for an offer or a course: beyond one hop the ship makes a voyage of it, docking at each port on the way (a real stop: the fee is paid, the ramps open, the market is open, and the dock is dressed as she comes alongside) and continuing on its own when nothing holds her. The long legs are where the far ports are, and where the quiet in-transit stretches happen. "From here" is measured from ${here} (${content.ports[here]?.name ?? here}), ${measured}.`,
  );
  for (const port of ports) {
    const routes = port.routes
      .map((r) => `${r.toPortId} (${seconds(r.distance)} transit)`)
      .join(", ");
    const stores = port.externalStores.map((s) => `${s.key} (${s.kind})`).join(", ");
    lines.push(`- ${port.id} "${port.name}": ${port.description}`);
    lines.push(`  character: ${port.character}`);
    lines.push(`  from here: ${reachLine(content, state, here, port.id)}`);
    lines.push(`  legs to: ${routes || "none"}; store keys: ${stores || "none"}`);
    lines.push(`  market sells: ${marketLine(state, content, config, port.id)}`);
  }
  lines.push("");
  lines.push(...sitesSection(state, content, here));
  lines.push("");
  lines.push("## Cargo items and classes");
  for (const item of cargo) {
    lines.push(`- ${item.id} "${item.name}" (class ${item.cargoClass})`);
  }
  lines.push("");
  lines.push("## 1. offerJob: a freight contract, a passenger, or an errand to a site");
  lines.push(
    '- fromPort must be the port the ship is docked at (see the digest): offers are made in person at the dock, never in flight, and never at a landing site. toPort may be any port reachable from fromPort (see "from here" above), never a site; a far port means a voyage with real stops on the way, which the ship routes by itself.',
  );
  lines.push(`- One cargo item kind per job. quantity: ${q(JOB_QUANTITY_UNITS)} units.`);
  lines.push(
    "- payTier low | standard | generous is a private lever: it places the pay inside the class price band for the route and the engine computes it. No text ever mentions pay.",
  );
  lines.push(
    `- payCredits: 0 lets payTier place the pay. Any other number is the exact pay in credits, for when the story is the sum (he offers far too much for a short run, she pays half what it is worth): a positive whole number, at most ${config.narrator.maxOfferPay}, otherwise the offer is dropped. Private like payTier: the captain sees the sum only in the ship's balance when it is paid, never on a card.`,
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
  lines.push(
    `- errandKind ${ERRAND_KINDS.join(" | ")} makes it an errand: a job to a landing site under Sites and back, about someone there. site is the site's id; toPort is fromPort, the port the ship is at, where the job comes home. fetchPerson: targetName is who is to be brought back (they are the one the errand is after at the site, under that name), and wants ${ERRAND_WANTS.join(" | ")} is how. fetchItem: targetItem is an item id (any item, as for stockMarket), targetName what it is called there (or empty for the item's name), and wants is empty. passenger and roundTrip are false and cargoItem and quantity are ignored; for freight and passages every errand field is empty. Accepted, the ship sets course for the site and sets down there; the crew go out armed to whoever is there, and how the fight goes is the sim's (who breaks, who is hurt or killed, whether the target gets away). It pays by the distance there and back, placed by payTier, once the ship is home with what it went for; a failed errand pays nothing. A kill job (wants dead) is rare, and whoever offers one is never clean: its target dies in the fight or, taken alive, is executed by the party at the scene. At the site the sim raises its own cards: the arrival card (two plans for going in), brought by the first officer, and at most one turn card in the fight when one of the party goes down, dies or breaks (press on, or pull back to the ship), brought by the first officer or else the senior of the party still on their feet, never the captain; you dress them on those policyDecision calls (and may name the arrival card's way in unseen, lever 8), you never cause them.`,
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
    "- Each side has a label and an effect: none; setCourse to coursePort (only while docked, to any port reachable from here, never a site); endPassage; or privateTalk. While the ship is on a voyage, setCourse to a neighbouring port is a detour: the voyage destination stays and the ship routes on from wherever it ends up. Use it only when the story makes the route a captain's choice; otherwise the ship picks its own way. The crew carry out the choice and the sim plays it out.",
  );
  lines.push(
    '- endPassage puts the current passenger off: valid only while a passenger is aboard or ashore on a live passage (see "Aboard" under Crew). They leave at the next docking (now, if docked) with no fare and stay at that port as someone in your cast. That is the real side of a crew-friction card ("Put him off at Kessler." / "He stays."); the sim does the rest. A captive an errand brought aboard (their "Aboard" line says where they were taken) is a passenger too, but putting them off fails the errand: it pays nothing and the ship still goes home. Offer it only when giving up the job is the real choice, and make that plain on the card (the job is lost, the issuer gets nothing), never in terms of pay.',
  );
  // §private-talk: a side effect of a card, not a lever of its own.
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
    "- This is the only way a part reaches a port. The crew buy what a stalled repair needs themselves, from the ship's money, while docked there; none of your levers buys, delivers or repairs (transact, 10, moves money, never parts). Stock a port the ship is at to make a part available now, another port to make the story go there, or set 0 to make it scarce.",
  );
  // §galley-provisions: the galley's stores are bought like parts; name them by id so the model can
  // stock them.
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
  lines.push("");
  lines.push(...fieldLever(state, content, config));
  lines.push("");
  lines.push(...UNSEEN_LEVER);
  lines.push("");
  lines.push(...strikeLever(config));
  lines.push("");
  lines.push(...transactLever(config));
  return lines.join("\n");
}
