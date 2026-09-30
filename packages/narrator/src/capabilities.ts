/**
 * The capability list (D11): exactly what the four narrator commands can do in this game,
 * generated from content, config and the ship's machines so the prompt never promises what the
 * sim cannot do. Static for a game (it changes only with content), so it sits in the cached
 * system prefix; per-call limits (budgets, current port) are in the digest.
 */
import type { ConfigDef, ContentBundle, FaultEffect } from "@crew/sim";
import {
  JOB_QUANTITY_UNITS,
  SPAWN_QUANTITY_UNITS,
  type State,
  faultWindowSeconds,
  machineCompartment,
  machineName,
} from "./lookups";

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

export function buildCapabilities(state: State, content: ContentBundle, config: ConfigDef): string {
  const ports = Object.values(content.ports).sort((a, b) => a.id.localeCompare(b.id));
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
    "You have exactly four levers. Anything not listed here does not exist in this game yet: no combat, no injuries, no direct changes to money, needs, moods or positions, no messages, no new places.",
  );
  lines.push("");
  lines.push("## Ports and routes");
  for (const port of ports) {
    const routes = port.routes
      .map((r) => `${r.toPortId} (${seconds(r.distance)} transit)`)
      .join(", ");
    const stores = port.externalStores.map((s) => `${s.key} (${s.kind})`).join(", ");
    lines.push(`- ${port.id} "${port.name}": ${port.description}`);
    lines.push(`  routes to: ${routes || "none"}; stores: ${stores}`);
  }
  lines.push("");
  lines.push("## Cargo items and classes");
  for (const item of cargo) {
    lines.push(`- ${item.id} "${item.name}" (class ${item.cargoClass})`);
  }
  lines.push("");
  lines.push("## 1. offerJob: a freight contract");
  lines.push(
    "- fromPort must be the port the ship is docked at or approaching (see the digest). toPort must be on a route from fromPort.",
  );
  lines.push(`- One cargo item kind per job. quantity: ${q(JOB_QUANTITY_UNITS)} units.`);
  lines.push(
    "- payTier low | standard | generous places the pay inside the class price band for the route; the engine computes the credits. Never state amounts in prose.",
  );
  lines.push(
    "- surface=true shows it to the captain now as an accept/decline card (counts as this call's one card). surface=false posts it quietly on the port board.",
  );
  lines.push("");
  lines.push("## 2. spawnAtBoundary: put existing items into a port store, off the ship");
  lines.push(
    `- Only into a port store listed above, never aboard. quantity: ${q(SPAWN_QUANTITY_UNITS)}, at most ${config.narrator.maxSpawnsPerCommand} per command. Uses one spawn from the budget in the digest.`,
  );
  lines.push("- Only existing cargo items; passengers and new item kinds are not available yet.");
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
    "- Each side has a label and an effect: none, or setCourse to coursePort (only while docked, only to a port on a route from here). The crew carry out the choice; you do not script outcomes.",
  );
  lines.push(
    "- At most one card per call (a surfaced job counts). No new cards on a policyDecision hook: dress the existing one instead.",
  );
  return lines.join("\n");
}
