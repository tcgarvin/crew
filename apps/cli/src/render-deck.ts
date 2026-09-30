/**
 * ASCII rendering for a `DeckDef` (used by `crew content render-deck` and to generate the
 * deck README under `packages/content/data/decks/`).
 */
import type { DeckDef } from "@crew/sim";

/** Renders the tile grid, a compartment legend and door list as plain ASCII. */
export function renderDeck(deck: DeckDef): string {
  const lines: string[] = [];
  lines.push(`${deck.name} (${deck.id})`);
  lines.push(`${deck.width} x ${deck.height} tiles`);
  lines.push("");
  lines.push(...deck.tiles);
  lines.push("");
  lines.push("Legend:");
  for (const c of deck.compartments) {
    lines.push(`  ${c.symbol}  ${c.name}${c.tags.length > 0 ? `  [${c.tags.join(", ")}]` : ""}`);
  }
  lines.push("");
  lines.push(`Doors (${deck.doors.length}):`);
  for (const door of deck.doors) {
    const power = door.powerDomain !== undefined ? `, power=${door.powerDomain}` : "";
    lines.push(
      `  ${door.key}: (${door.edge.x},${door.edge.y}) side ${door.edge.side}, ${door.kind}, ${door.initialState}${power}`,
    );
  }
  lines.push("");
  lines.push(`Machines (${deck.machines.length}):`);
  for (const m of deck.machines) {
    lines.push(`  ${m.key}: ${m.machineDefId} @ (${m.origin.x},${m.origin.y}) rot=${m.rotation}`);
  }
  return lines.join("\n");
}
