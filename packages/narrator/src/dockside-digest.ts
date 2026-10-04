/**
 * The digest's dock sections (Dockside §6.1, §6.3; D63, D67), as plain lines for `digest.ts`:
 *
 * - "On the dock", for every call made with a dock alongside (story calls too): the place, the
 *   staging call's ambience line for this docking, who is on the dock (name, role, post, activity
 *   label, why they are there), the props it set down, and the freight on the dock by job. A new
 *   face the staging call invented is shown as available to the story but not cast.
 * - "The dock you are dressing", for the staging call only (the dock is not alongside yet): the
 *   place, its posts by key, its areas, and the floor set the sim will place anyway.
 */
import {
  type ContentBundle,
  type DeepReadonly,
  type DockDef,
  type DockProp,
  type FloorSetEntry,
  type ItemDefId,
  type Job,
  type JobIssuer,
  type Local,
  type NarratorHook,
  deckToDock,
  dockAlongside,
  isInDockArea,
  isOnDock,
} from "@crew/sim";
import { type State, portName } from "./lookups";
import { STAGING_AREA_SPOT } from "./staging/plan";

export interface DockLines {
  readonly heading: string;
  readonly lines: string[];
}

export function personLine(person: DeepReadonly<JobIssuer>): string {
  return `${person.name} (${person.org === undefined ? person.role : `${person.role}, ${person.org}`})`;
}

function itemName(content: ContentBundle, itemDefId: string): string {
  return content.items[itemDefId as ItemDefId]?.name ?? itemDefId;
}

function postName(dock: DockDef, key: string): string {
  return dock.posts.find((p) => p.key === key)?.name ?? key;
}

/**
 * D63: what freight of one job lies on the dock, and in what standing: an offer's crates staged
 * and nobody's yet, a taken job's crates still waiting to go aboard, or a delivery set down in
 * the delivery bay (the port takes it in from there).
 */
function dockFreightLine(
  state: State,
  content: ContentBundle,
  job: DeepReadonly<Job>,
  itemIds: readonly string[],
): string {
  const inBay = itemIds.filter((id) => {
    const item = state.items[id as keyof State["items"]];
    return item !== undefined && isInDockArea(content, state, item.location, "deliveryBay");
  }).length;
  const n = itemIds.length;
  const crates = `${n} ${n === 1 ? "crate" : "crates"}`;
  const whose = `${job.id} (${personLine(job.issuerPerson)}, to ${portName(content, job.toPortId)})`;
  if (job.status === "offered") return `- on offer: ${crates} staged for ${whose}; not taken`;
  if (job.status === "accepted") return `- waiting to be loaded: ${crates} for ${whose}`;
  if (inBay === n) return `- delivered: ${crates} for ${whose} in the delivery bay`;
  return `- unloading: ${crates} for ${whose} on the dock, ${inBay} in the delivery bay`;
}

function freightLines(state: State, content: ContentBundle): string[] {
  const byJob = new Map<string, string[]>();
  for (const item of Object.values(state.items)) {
    if (item.jobId === undefined || !isOnDock(content, state, item.location)) continue;
    byJob.set(item.jobId, [...(byJob.get(item.jobId) ?? []), item.id]);
  }
  const lines: string[] = [];
  for (const [jobId, itemIds] of [...byJob].sort(([a], [b]) => a.localeCompare(b))) {
    const job = state.jobs[jobId as keyof State["jobs"]];
    if (job !== undefined) lines.push(dockFreightLine(state, content, job, itemIds));
  }
  return lines;
}

/** Why a local is on the dock, in the digest's words. */
function originPhrase(local: DeepReadonly<Local>): string {
  const origin = local.origin;
  switch (origin.kind) {
    case "regular":
      return "a regular here";
    case "receiver":
      return `here to take in the freight of ${origin.jobId}`;
    case "passenger":
      return "a passenger the ship left here";
    case "dockHand":
      return "a dock hand";
    case "visitor":
      return "came in from the port with word for the captain";
    case "staged":
      switch (origin.source) {
        case "seed":
          return "one of this port's people";
        case "cast":
          return "in your cast";
        case "newFace": {
          const look = local.look === undefined ? "" : `; looks: ${local.look}`;
          return `a new face, not in your cast until you write about them${look}`;
        }
      }
  }
}

/** What a dock hand is carting, if anything. */
function errandPhrase(local: DeepReadonly<Local>): string | undefined {
  const errand = local.errand;
  if (errand === undefined) return undefined;
  switch (errand.kind) {
    case "stageOffer":
      return `bringing out the crates of ${errand.jobId} to the staging area`;
    case "withdrawOffer":
      return errand.phase === "fetch"
        ? `fetching the crates of ${errand.jobId} back in`
        : `carrying the crates of ${errand.jobId} back in`;
    case "takeDelivery":
      return errand.phase === "fetch"
        ? `going for the delivery of ${errand.jobId}`
        : `carrying the delivery of ${errand.jobId} in`;
  }
}

function localLine(dock: DockDef, local: DeepReadonly<Local>): string {
  const label = local.label === undefined ? "" : `, "${local.label}"`;
  const doing = [errandPhrase(local), local.behaviour.kind === "leave" ? "leaving" : undefined]
    .filter((p) => p !== undefined)
    .join("; ");
  return `- ${local.name} (${local.role}) at ${postName(dock, local.postKey)}${label}: ${originPhrase(local)}${doing === "" ? "" : `; ${doing}`}`;
}

/** Where a staged prop stands: on the staging area, or by the nearest post. */
function propSpot(dock: DockDef, prop: DeepReadonly<DockProp>): string {
  const tile = deckToDock(dock, prop.tile);
  const staging = dock.areas.find((a) => a.kind === "freightStaging")?.rect;
  if (
    staging !== undefined &&
    tile.x >= staging.x &&
    tile.x < staging.x + staging.w &&
    tile.y >= staging.y &&
    tile.y < staging.y + staging.h
  ) {
    return "on the staging area";
  }
  const nearest = [...dock.posts].sort(
    (a, b) =>
      Math.abs(a.tile.x - tile.x) +
      Math.abs(a.tile.y - tile.y) -
      (Math.abs(b.tile.x - tile.x) + Math.abs(b.tile.y - tile.y)),
  )[0];
  return nearest === undefined ? "on the dock" : `by ${nearest.name}`;
}

/** "On the dock (<name>)": undefined with no dock alongside. */
export function onDockLines(state: State, content: ContentBundle): DockLines | undefined {
  const dock = dockAlongside(content, state);
  if (dock === undefined) return undefined;
  const lines = [`the place: ${dock.ambience}`];
  const side = state.dockside;
  if (side.ambience !== undefined) lines.push(`as the ship came in: ${side.ambience}`);
  const locals = Object.values(side.locals).sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true }),
  );
  if (locals.length > 0) lines.push("people on the dock (not crew; they stay on the dock):");
  for (const local of locals) lines.push(localLine(dock, local));
  if (side.props.length > 0) lines.push("set dressing (nobody's; nobody aboard can use it):");
  for (const prop of side.props) {
    lines.push(`- ${prop.count}x ${itemName(content, prop.itemDefId)} ${propSpot(dock, prop)}`);
  }
  const freight = freightLines(state, content);
  if (freight.length > 0) lines.push("freight:");
  lines.push(...freight);
  return { heading: `On the dock (${dock.name})`, lines };
}

function floorSetLine(dock: DockDef, entry: DeepReadonly<FloorSetEntry>): string {
  const why =
    entry.reason.kind === "regular"
      ? "a regular here"
      : entry.reason.kind === "receiver"
        ? `a dock hand, here to take in the freight of ${entry.reason.jobId}`
        : "a passenger the ship left here";
  const label = entry.label === undefined ? "" : `, "${entry.label}"`;
  return `- ${entry.name} (${entry.role}) at ${entry.postKey} (${postName(dock, entry.postKey)})${label}: ${why}`;
}

/** "The dock you are dressing (<name>)", for a `stageDock` hook (D67). */
export function stagingDockLines(
  content: ContentBundle,
  hook: DeepReadonly<Extract<NarratorHook, { kind: "stageDock" }>>,
): DockLines {
  const dock = content.docks?.[hook.context.dockId];
  if (dock === undefined) throw new Error(`digest: no dock "${hook.context.dockId}" in content`);
  const lines = [
    `the place: ${dock.ambience}`,
    "posts (key: what it is):",
    ...dock.posts.map((p) => `- ${p.key}: ${p.name} (${p.kind})`),
    `areas: the staging area (a prop at "${STAGING_AREA_SPOT}" goes there; freight on offer waits there too), the delivery bay (deliveries are set down there)`,
  ];
  const floor = hook.context.floorSet;
  lines.push(
    floor.length === 0
      ? "already on the dock: nobody (the floor set is empty)"
      : "already on the dock (the floor set; the sim places them whatever you do):",
  );
  for (const entry of floor) lines.push(floorSetLine(dock, entry));
  return { heading: `The dock you are dressing (${dock.name})`, lines };
}
