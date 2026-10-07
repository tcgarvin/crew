import { templateCard } from "@crew/content";
/**
 * The deterministic null narrator (PLAN §3 `NullNarrator`, review N3): the answer when no model
 * is configured and the fallback for every model failure, so the game stays playable with the
 * LLM unavailable. For a policy decision it writes a template card. D40: the narrator is the
 * only source of work, so for `captainAshore` it makes one job offer from the
 * port's `jobTemplates` and the content name table (D25), built as an `offerJob` intent and run
 * through the same translator as a model's offer, so pay, clamps and the person/pitch shape are
 * identical. The draw is seeded from the snapshot's tick and the port, so the same snapshot
 * always yields the same offer.
 */
import {
  type ContentBundle,
  type DecisionId,
  JOB_URGENCIES,
  type JobTemplateDef,
  type PortDefId,
  type RngApi,
  createRngApi,
  seedAllStreams,
  seedStream,
} from "@crew/sim";
import {
  type FallbackReason,
  type NarratorIntent,
  type NarratorRequest,
  type NarratorResponse,
  PAY_TIERS,
  QUANTITIES,
} from "./contract";
import { JOB_QUANTITY_UNITS, type Snapshot, portName } from "./lookups";
import { PROMPT_VERSION } from "./prompts/system";
import { translateIntents } from "./translate";

export const NULL_NARRATOR_MODEL = "null-narrator";

/** Role given to an issuer known only by a template's bare name (no name table). */
const TEMPLATE_ISSUER_ROLE = "shipper";

/**
 * What the offline offer says about the job (`{cargo}`, `{from}`, `{to}` filled from content).
 * No pay and no numbers (D24, GDD §22); the pitch comes from the name table's lines.
 */
export const NULL_OFFER_DESCRIPTIONS: readonly string[] = [
  "{cargo} waiting on the dock at {from}, bound for {to}.",
  "A plain run: {cargo} from {from} to {to}, loaded here and signed for there.",
  "{to} has been waiting on this {cargo} longer than anyone would like.",
  "Routine freight for {to}: {cargo}, already crated and cleared for loading at {from}.",
];

export interface NullNarratorOptions {
  readonly callId?: string;
  readonly fallback?: FallbackReason;
  /**
   * Enables port names in template text and, for `captainAshore`, the offline job offer (D40);
   * without it that hook gets no commands.
   */
  readonly content?: ContentBundle;
}

function fill(line: string, values: Readonly<Record<string, string>>): string {
  return line.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Pure draws seeded from the snapshot tick and the port; nothing in the snapshot is touched. */
function offerRng(snapshot: Snapshot, portId: PortDefId): RngApi {
  const seed = seedStream(snapshot.state.tick, `null-offer:${portId}`)[0];
  return createRngApi({ seed, rng: seedAllStreams(seed) });
}

/** Templates in draw order: the weighted pick first, then the rest, so a bad one is skipped. */
function templatesInDrawOrder(rng: RngApi, port: { jobTemplates: readonly JobTemplateDef[] }) {
  const usable = port.jobTemplates.filter((t) => t.weight > 0 && t.cargo.length > 0);
  if (usable.length === 0) return [];
  const first = rng.weighted(
    "commerce",
    usable.map((t) => ({ item: t, weight: t.weight })),
  );
  return [first, ...usable.filter((t) => t !== first)];
}

/** The coarse quantity whose unit count is nearest to the template's drawn count. */
function quantityFor(count: number): (typeof QUANTITIES)[number] {
  let best: (typeof QUANTITIES)[number] = QUANTITIES[0];
  for (const quantity of QUANTITIES) {
    if (
      Math.abs(JOB_QUANTITY_UNITS[quantity] - count) < Math.abs(JOB_QUANTITY_UNITS[best] - count)
    ) {
      best = quantity;
    }
  }
  return best;
}

/**
 * D25: who offers the job and what they say, from the content name table over the `social`
 * stream (the `commerce` stream draws only route, count and pay). Without a table entry for the
 * port the template's `issuer` becomes the name.
 */
function drawPerson(
  rng: RngApi,
  content: ContentBundle,
  portId: PortDefId,
  template: JobTemplateDef,
  words: Readonly<Record<string, string>>,
): Pick<
  Extract<NarratorIntent, { kind: "offerJob" }>,
  "issuerName" | "issuerRole" | "issuerOrg" | "pitch"
> {
  const people = content.people;
  const local = people?.ports[portId];
  if (people === undefined || local === undefined) {
    return {
      issuerName: template.issuer,
      issuerRole: TEMPLATE_ISSUER_ROLE,
      issuerOrg: "",
      pitch: fill("I need {cargo} carried to {to}. Interested?", words),
    };
  }
  const given = rng.pick("social", people.givenNames);
  const familyIndex = rng.int("social", 0, people.familyNames.length - 1);
  // "Maren Maren" reads as a typo; step to the next family name instead.
  const family =
    people.familyNames[familyIndex] === given
      ? people.familyNames[(familyIndex + 1) % people.familyNames.length]
      : people.familyNames[familyIndex];
  return {
    issuerName: `${given} ${family ?? ""}`.trim(),
    issuerRole: rng.pick("social", local.roles),
    issuerOrg: local.orgs.length === 0 ? "" : rng.pick("social", local.orgs),
    pitch: fill(rng.pick("social", [...people.pitches, ...local.pitches]), words),
  };
}

type Person = ReturnType<typeof drawPerson>;

/**
 * D70: half the time the work comes from someone standing on the dock (a regular at their post,
 * or someone the staging call placed), as the prompt asks the model to prefer, so the captain
 * offline walks over and talks to them as well as going out through the gate. Their name and
 * role; the drawn organisation and pitch stay.
 */
function withDockIssuer(rng: RngApi, snapshot: Snapshot, person: Person): Person {
  const onDock = Object.values(snapshot.state.dockside.locals).filter(
    (l) => l.origin.kind === "regular" || l.origin.kind === "staged",
  );
  if (onDock.length === 0 || !rng.chance("social", 0.5)) return person;
  const local = rng.pick("social", onDock);
  return { ...person, issuerName: local.name, issuerRole: local.role, issuerOrg: "" };
}

function offerIntent(
  rng: RngApi,
  snapshot: Snapshot,
  content: ContentBundle,
  portId: PortDefId,
  template: JobTemplateDef,
): NarratorIntent | undefined {
  const line = template.cargo[0];
  if (line === undefined) return undefined;
  const cargoClass = content.items[line.itemDefId]?.cargoClass;
  if (cargoClass === undefined) return undefined;
  const count = rng.int("commerce", line.countMin, line.countMax);
  const payTier = rng.pick("commerce", PAY_TIERS);
  const words = {
    cargo: content.people?.cargoWords[cargoClass] ?? "freight",
    from: portName(content, portId),
    to: portName(content, template.toPortId),
  };
  const description = capitalise(fill(rng.pick("social", NULL_OFFER_DESCRIPTIONS), words));
  const urgency = rng.pick("social", JOB_URGENCIES);
  return {
    kind: "offerJob",
    ...withDockIssuer(rng, snapshot, drawPerson(rng, content, portId, template, words)),
    description,
    fromPort: portId,
    toPort: template.toPortId,
    cargoItem: line.itemDefId,
    quantity: quantityFor(count),
    payTier,
    urgency,
    // A surfaced offer is the card; while another card is already queued it posts quietly, as a
    // model's offer would.
    surface:
      snapshot.state.decisions.queue.length === 0 && snapshot.state.decisions.held.length === 0,
    // Passengers-and-galaxy §4.4: the null narrator never offers passages.
    passenger: false,
    roundTrip: false,
  };
}

/** One translated `offerJob` for the hook's port, or nothing when no template translates. */
function nullOffer(
  req: NarratorRequest,
  portId: PortDefId,
  content: ContentBundle,
  callId: string,
): Pick<NarratorResponse, "commands" | "dropped"> | undefined {
  const port = content.ports[portId];
  if (port === undefined) return undefined;
  const snapshot = req.snapshot as Snapshot;
  const rng = offerRng(snapshot, portId);
  for (const template of templatesInDrawOrder(rng, port)) {
    const intent = offerIntent(rng, snapshot, content, portId, template);
    if (intent === undefined) continue;
    const translated = translateIntents(
      {
        rationale: "null narrator: templated offer",
        intents: [intent],
        card: null,
      },
      { snapshot, content, hookTick: req.hook.tick, callId, hook: req.hook },
    );
    if (translated.commands.length > 0) {
      return { commands: translated.commands, dropped: translated.dropped };
    }
  }
  return undefined;
}

export function nullNarratorResponse(
  req: NarratorRequest,
  options: NullNarratorOptions = {},
): NarratorResponse {
  const base = {
    commands: [],
    callId: options.callId ?? globalThis.crypto.randomUUID(),
    model: NULL_NARRATOR_MODEL,
    promptVersion: PROMPT_VERSION,
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
  };
  const hook = req.hook;
  if (hook.kind === "policyDecision") {
    const decision = req.snapshot.state.decisions.records[hook.context.decisionId as DecisionId];
    if (decision === undefined) return base;
    return { ...base, card: templateCard(decision, options.content) };
  }
  // D66: the staging call is answered with an empty plan: the dock is the sim's floor set.
  if (hook.kind === "stageDock") return base;
  if (hook.kind === "captainAshore" && options.content) {
    const offer = nullOffer(req, hook.context.portId, options.content, base.callId);
    return offer === undefined ? base : { ...base, ...offer };
  }
  return base;
}
