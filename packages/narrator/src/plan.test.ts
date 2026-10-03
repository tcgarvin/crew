/**
 * D45, D53: the schema rides in the cached system prefix of every call (no longer a grammar, so
 * no provider-side size cap), so it must stay small and game-independent: no per-game enums.
 */
import { describe, expect, it } from "vitest";
import { approachingPortRequest } from "./fixtures";
import { planJsonSchema, planSchemaFor } from "./plan";
import { content } from "./test-support";

const MAX_SCHEMA_BYTES = 8 * 1024;
const MAX_ENUM_ENTRIES = 8;

function enumArrays(node: unknown, found: unknown[][] = []): unknown[][] {
  if (Array.isArray(node)) {
    for (const child of node) enumArrays(child, found);
  } else if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.enum)) found.push(record.enum);
    for (const child of Object.values(record)) enumArrays(child, found);
  }
  return found;
}

describe("plan JSON schema size (D45, D53)", () => {
  it("stays under the prompt budget for the real content bundle and a fixture snapshot", () => {
    const req = approachingPortRequest(content());
    expect(req.snapshot.state.machines).not.toEqual({});
    const json = planJsonSchema(planSchemaFor());
    const text = JSON.stringify(json);
    const bytes = Buffer.byteLength(text, "utf8");
    const enums = enumArrays(json);
    const entries = enums.reduce((n, e) => n + e.length, 0);
    console.log(
      `plan schema: ${bytes} bytes, ${enums.length} enum arrays, ${entries} enum entries, longest ${Math.max(...enums.map((e) => e.length))}`,
    );
    expect(bytes).toBeLessThan(MAX_SCHEMA_BYTES);
    for (const e of enums) expect(e.length).toBeLessThanOrEqual(MAX_ENUM_ENTRIES);
    // No per-game id leaks into the schema.
    for (const portId of Object.keys(content().ports)) expect(text).not.toContain(portId);
    for (const machine of Object.values(req.snapshot.state.machines)) {
      expect(text).not.toContain(`"${machine.id}"`);
    }
  });
});
